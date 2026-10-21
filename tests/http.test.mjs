import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { Store } from "../src/domain.mjs";
import { createApp } from "../src/server.mjs";
import { digest } from "../src/security.mjs";

async function availablePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
test("HTTP integration: login, cookies, CSRF, roller, pengar, samtidighet och logout", async (t) => {
  const store = new Store(":memory:");
  store.seed([
    {
      email: "owner@example.test",
      name: "Ägare",
      password: "test-password-long-enough",
    },
  ]);
  const port = await availablePort(),
    origin = `http://127.0.0.1:${port}`,
    app = createApp(store, { port });
  await new Promise((r) => app.listen(port, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => app.close(r));
    store.close();
  });
  let cookie = "",
    csrf = "";
  const request = (path, method = "GET", data, extra = {}) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(data
          ? {
              "Content-Type": "application/json",
              Origin: origin,
              "X-CSRF-Token": csrf,
            }
          : {}),
        Cookie: cookie,
        ...extra,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
  assert.equal((await request("/api/state")).status, 401);
  assert.equal(
    (
      await request("/api/login", "POST", {
        email: "owner@example.test",
        password: "wrong",
      })
    ).status,
    401,
  );
  const login = await request("/api/login", "POST", {
    email: "owner@example.test",
    password: "test-password-long-enough",
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  cookie = setCookie.split(";")[0];
  csrf = (await login.json()).csrf;
  assert.ok(
    store.get(
      "SELECT id FROM sessions WHERE id=?",
      digest(cookie.split("=")[1]),
    ),
  );
  assert.equal(
    (await request("/api/customers", "POST", {}, { "X-CSRF-Token": "" }))
      .status,
    403,
  );
  assert.equal(
    (
      await request(
        "/api/customers",
        "POST",
        {},
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const badHostStatus = await new Promise((resolve, reject) => {
    const r = httpRequest(
      origin + "/api/state",
      { headers: { Host: "evil.example", Cookie: cookie } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    r.on("error", reject);
    r.end();
  });
  assert.equal(badHostStatus, 403);
  const customer = await (
    await request("/api/customers", "POST", {
      name: "Kund <script>alert(1)</script>",
      orgNumber: "559999-9998",
      address: "Testgatan",
      email: "test@example.test",
    })
  ).json();
  const invoice = await (
    await request("/api/invoices", "POST", {
      customerId: customer.id,
      date: "2026-10-01",
      dueDate: "2026-10-31",
      description: "Tjänst",
      quantity: "1",
      unitPrice: "20000",
      vatRate: 25,
    })
  ).json();
  const concurrent = await Promise.all([
    request(`/api/invoices/${invoice.id}/issue`, "POST", { version: 1 }),
    request(`/api/invoices/${invoice.id}/issue`, "POST", { version: 1 }),
  ]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
  let state = await (await request("/api/state")).json();
  assert.equal(state.vouchers.length, 1);
  assert.equal(state.reports.receivables, 2500000);
  const forged = await request("/api/vouchers", "POST", {
    date: "2026-10-02",
    text: "Forged",
    reversalOf: 1,
    lines: [
      { account: "1930", debit: "100" },
      { account: "2081", credit: "100" },
    ],
  });
  assert.equal(forged.status, 400);
  const pdf = await request(`/api/invoices/${invoice.id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.ok((await pdf.arrayBuffer()).byteLength > 100);
  assert.equal((await request("/api/export/sie")).status, 200);
  const exported = await (await request("/api/export/json")).json();
  assert.ok(
    JSON.parse(exported.invoices[0].snapshot).customer.name.includes(
      "<script>",
    ),
  );
  const payments = await Promise.all([
    request(`/api/invoices/${invoice.id}/payment`, "POST", {
      amount: "15000",
      date: "2026-10-02",
    }),
    request(`/api/invoices/${invoice.id}/payment`, "POST", {
      amount: "15000",
      date: "2026-10-02",
    }),
  ]);
  assert.deepEqual(payments.map((r) => r.status).sort(), [200, 400]);
  state = await (await request("/api/state")).json();
  assert.equal(state.reports.receivables, 1000000);
  const ownerCookie = cookie,
    ownerCsrf = csrf;
  store.run(
    "INSERT INTO users(email,name,role,password) SELECT 'viewer@example.test','Läsare','viewer',password FROM users WHERE id=1",
  );
  const viewer = await request("/api/login", "POST", {
    email: "viewer@example.test",
    password: "test-password-long-enough",
  });
  cookie = viewer.headers.get("set-cookie").split(";")[0];
  csrf = (await viewer.json()).csrf;
  assert.equal((await request("/api/state")).status, 200);
  assert.equal((await request("/api/export/json")).status, 403);
  assert.equal(
    (
      await request("/api/bank", "POST", {
        date: "2026-10-01",
        description: "Test",
        amount: "10",
        currency: "SEK",
      })
    ).status,
    403,
  );
  assert.equal((await request("/api/logout", "POST", {})).status, 200);
  assert.equal((await request("/api/state")).status, 401);
  cookie = ownerCookie;
  csrf = ownerCsrf;
  assert.equal(
    (await request("/api/state")).status,
    401,
    "ny inloggning roterar tidigare session",
  );
});
test("HTTP dokumentkontroll upptäcker skadat arkiverat innehåll", async (t) => {
  const store = new Store(":memory:");
  store.seed([
    {
      email: "owner@example.test",
      name: "Ägare",
      password: "test-password-long-enough",
    },
  ]);
  const d = store.document(
    {
      name: "test.pdf",
      type: "application/pdf",
      data: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"),
    },
    1,
  );
  store.db.exec("DROP TRIGGER documents_no_update");
  store.run(
    "UPDATE documents SET content=? WHERE id=?",
    Buffer.from("corrupt"),
    d.id,
  );
  const port = await availablePort(),
    app = createApp(store, { port });
  await new Promise((r) => app.listen(port, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => app.close(r));
    store.close();
  });
  const raw = "a".repeat(64);
  store.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    digest(raw),
    1,
    "csrf",
    Date.now() + 10000,
  );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/api/documents/${d.id}`, {
        headers: { Cookie: `session=${raw}` },
      })
    ).status,
    409,
  );
});
