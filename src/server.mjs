import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, DomainError } from "./domain.mjs";
import { token, digest, checkPassword, hashPassword } from "./security.mjs";
import { invoicePDF } from "./pdf.mjs";
import { exportSIE } from "./sie.mjs";
import { makeBackup } from "./backup.mjs";

const root = fileURLToPath(new URL("../public/", import.meta.url));
export function createApp(store, { port = 3210 } = {}) {
  const origin = `http://127.0.0.1:${port}`,
    attempts = new Map();
  const dummyHash = hashPassword(token());
  const headers = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const send = (status, data, type = "application/json; charset=utf-8") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(
        type.startsWith("application/json")
          ? JSON.stringify(data ?? { ok: true })
          : data,
      );
    };
    try {
      if (req.headers.host !== `127.0.0.1:${port}`)
        throw new DomainError("Ogiltig lokal värd. Använd 127.0.0.1.", 403);
      const url = new URL(req.url, origin),
        path = url.pathname;
      if (!["GET", "POST", "PUT"].includes(req.method))
        throw new DomainError("Metoden stöds inte.", 405);
      if (!path.startsWith("/api/")) {
        const staticPaths = {
          "/": ["index.html", "text/html; charset=utf-8"],
          "/app.js": ["app.js", "text/javascript; charset=utf-8"],
          "/style.css": ["style.css", "text/css; charset=utf-8"],
        };
        if (req.method !== "GET" || !staticPaths[path])
          throw new DomainError("Sidan finns inte.", 404);
        const [file, type] = staticPaths[path];
        return send(200, readFileSync(resolve(root, file)), type);
      }
      const cookie = /(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/.exec(
        req.headers.cookie || "",
      )?.[1];
      const session = cookie
        ? store.get(
            "SELECT s.*,u.name,u.role,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.expires_at>?",
            digest(cookie),
            Date.now(),
          )
        : null;
      if (req.method === "GET" && path === "/api/session")
        return send(
          200,
          session
            ? {
                user: {
                  id: session.user_id,
                  name: session.name,
                  role: session.role,
                },
                csrf: session.csrf,
              }
            : { user: null },
        );
      let data;
      if (req.method !== "GET") {
        if (
          req.headers.origin !== origin ||
          !String(req.headers["content-type"] || "").startsWith(
            "application/json",
          )
        )
          throw new DomainError(
            "Begäran måste komma från den lokala applikationen som JSON.",
            403,
          );
        let length = 0,
          chunks = [];
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 7_200_000)
            throw new DomainError("Begäran är för stor.", 413);
          chunks.push(chunk);
        }
        try {
          data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          throw new DomainError("Ogiltig JSON.", 400);
        }
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new DomainError("JSON-objekt krävs.");
      }
      if (req.method === "POST" && path === "/api/login") {
        const key = "loopback",
          current = attempts.get(key);
        if (current && current.until > Date.now() && current.count >= 10)
          throw new DomainError(
            "För många inloggningsförsök. Vänta 15 minuter.",
            429,
          );
        const email =
          typeof data.email === "string" ? data.email.toLowerCase().trim() : "";
        const user = store.get("SELECT * FROM users WHERE email=?", email);
        const valid = checkPassword(data.password, user?.password || dummyHash);
        if (!user || !valid) {
          const attempt =
            current?.until > Date.now()
              ? current
              : { count: 0, until: Date.now() + 900000 };
          attempt.count++;
          attempts.set(key, attempt);
          store.audit(null, "auth.failed", {});
          throw new DomainError("Fel e-postadress eller lösenord.", 401);
        }
        attempts.delete(key);
        const raw = token(),
          csrf = token();
        store.tx(() => {
          store.run("DELETE FROM sessions WHERE expires_at<?", Date.now());
          if (session) store.run("DELETE FROM sessions WHERE id=?", session.id);
          store.run(
            "INSERT INTO sessions VALUES(?,?,?,?)",
            digest(raw),
            user.id,
            csrf,
            Date.now() + 8 * 3600000,
          );
          store.audit(user.id, "auth.login", {});
        });
        res.setHeader(
          "Set-Cookie",
          `session=${raw}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return send(200, {
          user: { id: user.id, name: user.name, role: user.role },
          csrf,
        });
      }
      if (!session) throw new DomainError("Logga in för att fortsätta.", 401);
      const actor = session.user_id;
      if (req.method !== "GET" && req.headers["x-csrf-token"] !== session.csrf)
        throw new DomainError("Ogiltigt CSRF-skydd. Läs om sidan.", 403);
      if (req.method === "POST" && path === "/api/logout") {
        store.run("DELETE FROM sessions WHERE id=?", session.id);
        store.audit(actor, "auth.logout", {});
        res.setHeader(
          "Set-Cookie",
          "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return send(200);
      }
      if (req.method === "GET") {
        if (path === "/api/state") return send(200, store.state());
        let match;
        if ((match = /^\/api\/invoices\/(\d+)\/pdf$/.exec(path))) {
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="faktura-${match[1]}.pdf"`,
          );
          return send(
            200,
            invoicePDF(store, Number(match[1])),
            "application/pdf",
          );
        }
        if ((match = /^\/api\/documents\/(\d+)$/.exec(path))) {
          const doc = store.get(
            "SELECT * FROM documents WHERE id=?",
            Number(match[1]),
          );
          if (!doc) throw new DomainError("Underlaget saknas.", 404);
          const { createHash } = await import("node:crypto");
          if (
            createHash("sha256").update(doc.content).digest("hex") !== doc.hash
          )
            throw new DomainError(
              "Underlagets kontrollsumma stämmer inte.",
              409,
            );
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="underlag-${doc.id}.${doc.type === "application/pdf" ? "pdf" : doc.type === "image/png" ? "png" : "jpg"}"`,
          );
          return send(200, Buffer.from(doc.content), doc.type);
        }
        if (path === "/api/export/sie") {
          store.authorize(actor, true);
          const bytes = exportSIE(store);
          store.audit(actor, "export.sie", {});
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="bokforing.se"',
          );
          return send(200, bytes, "application/octet-stream");
        }
        if (path === "/api/export/json") {
          const exported = store.exportData(actor);
          store.audit(actor, "export.json", {});
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="ekonomisystem-export.json"',
          );
          return send(200, exported);
        }
      }
      if (req.method === "PUT" && path === "/api/company")
        return send(200, store.company(data, actor));
      if (req.method === "POST") {
        const routes = {
          "/api/customers": () => store.customer(data, actor),
          "/api/invoices": () => store.invoice(data, actor),
          "/api/vouchers": () => store.post(data, actor),
          "/api/bank": () => store.bank(data, actor),
          "/api/imports": () => store.import(data, actor),
          "/api/documents": () => store.document(data, actor),
          "/api/periods/lock": () => store.lock(data.through, actor),
        };
        if (routes[path]) return send(200, routes[path]());
        let m;
        if (
          (m = /^\/api\/invoices\/(\d+)\/(issue|payment|credit)$/.exec(path))
        ) {
          const id = Number(m[1]);
          return send(
            200,
            m[2] === "issue"
              ? store.issue(id, data.version, actor)
              : store[m[2]](id, data, actor),
          );
        }
        if ((m = /^\/api\/vouchers\/(\d+)\/reverse$/.exec(path)))
          return send(200, store.reverse(Number(m[1]), data, actor));
        if ((m = /^\/api\/bank\/(\d+)\/book$/.exec(path)))
          return send(200, store.bookBank(Number(m[1]), data, actor));
      }
      throw new DomainError("API-resursen finns inte.", 404);
    } catch (e) {
      const status = e.status || (e.code?.startsWith("SQLITE") ? 409 : 400);
      send(status, {
        error: e.code?.startsWith("SQLITE")
          ? "Datakonflikt. Läs om sidan och försök igen."
          : e.message || "Åtgärden kunde inte genomföras.",
      });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const store = new Store(process.env.DATABASE_PATH || "data/ekonomi.sqlite");
  if (!store.get("SELECT id FROM users LIMIT 1")) {
    console.error("Kör först: node scripts/setup.mjs");
    store.close();
    process.exitCode = 1;
  } else {
    const port = Number(process.env.PORT || 3210);
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("Ogiltig PORT.");
    const server = createApp(store, { port });
    let backupRunning = false;
    const automaticBackup = async () => {
      if (backupRunning) return;
      backupRunning = true;
      try {
        await makeBackup(
          store,
          `backups/auto-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
        );
        console.log("Automatisk lokal backup verifierad.");
      } catch (e) {
        console.error("Automatisk backup misslyckades:", e.message);
      } finally {
        backupRunning = false;
      }
    };
    await automaticBackup();
    const backupTimer = setInterval(automaticBackup, 24 * 3600000);
    backupTimer.unref();
    server.listen(port, "127.0.0.1", () =>
      console.log(`Ekonomisystem lokalt: http://127.0.0.1:${port}`),
    );
    const stop = () => {
      clearInterval(backupTimer);
      server.close(() => {
        store.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }
}
