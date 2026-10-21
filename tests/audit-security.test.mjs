import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { Store } from "../src/domain.mjs";
import { createApp } from "../src/server.mjs";
import { digest } from "../src/security.mjs";
import { makeBackup, restoreBackup, verifyDatabase } from "../src/backup.mjs";

const lines = [{ account: "1930", debit: "100" }, { account: "3041", credit: "100" }];
function fixture(t, path = ":memory:") {
  const s = new Store(path);
  s.seed([{ email: "audit@example.test", name: "Syntetisk", password: "synthetic-audit-password" }]);
  t.after(() => s.close());
  s.run("INSERT INTO users(email,name,role,password) SELECT 'viewer@example.test','Viewer','viewer',password FROM users WHERE id=1");
  s.run("INSERT INTO users(email,name,role,password) SELECT 'accountant@example.test','Accountant','accountant',password FROM users WHERE id=1");
  return s;
}
async function httpFixture(t) {
  const s = fixture(t);
  // Select an unused local port without touching the user's running application.
  const { createServer } = await import("node:net");
  const probe = createServer();
  await new Promise(r => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise(r => probe.close(r));
  const app = createApp(s, { port });
  await new Promise(r => app.listen(port, "127.0.0.1", r));
  t.after(() => new Promise(r => app.close(r)));
  const origin = `http://127.0.0.1:${port}`;
  function session(actor = 1, expiry = Date.now() + 60000) {
    const raw = String(actor).repeat(64), csrf = `csrf-${actor}`;
    s.run("INSERT OR REPLACE INTO sessions VALUES(?,?,?,?)", digest(raw), actor, csrf, expiry);
    return { Cookie: `session=${raw}`, "X-CSRF-Token": csrf, Origin: origin, "Content-Type": "application/json" };
  }
  return { s, origin, session };
}
function issue(s) {
  const c = s.customer({ name: "Kund", orgNumber: "559999-9998", email: "kund@example.test", address: "Testgatan" }, 1);
  const i = s.invoice({ customerId: c.id, date: "2026-01-02", dueDate: "2026-01-30", description: "Original", quantity: "1", unitPrice: "100", vatRate: 25 }, 1);
  s.issue(i.id, 1, 1);
  return i.id;
}

test("audit säkerhet: viewer nekas alla ekonomiska skrivrutter, accountant nekas adminrutter", async t => {
  const { s, origin, session } = await httpFixture(t);
  const paths = ["/api/customers", "/api/invoices", "/api/vouchers", "/api/bank", "/api/imports", "/api/documents", "/api/periods/lock", "/api/invoices/1/issue", "/api/invoices/1/payment", "/api/invoices/1/credit", "/api/vouchers/1/reverse", "/api/bank/1/book"];
  const viewer = session(2), accountant = session(3);
  const before = s.get("SELECT COUNT(*) n FROM audit").n;
  for (const path of paths) assert.equal((await fetch(origin + path, { method: "POST", headers: viewer, body: "{}" })).status, 403, path);
  for (const headers of [viewer, accountant]) {
    assert.equal((await fetch(origin + "/api/company", { method: "PUT", headers, body: "{}" })).status, 403);
    assert.equal((await fetch(origin + "/api/periods/lock", { method: "POST", headers, body: "{}" })).status, 403);
    for (const path of ["/api/export/json", "/api/export/sie"]) assert.equal((await fetch(origin + path, { headers })).status, 403);
  }
  assert.equal(s.get("SELECT COUNT(*) n FROM audit").n, before);
});

test("audit säkerhet: utgången session, saknad CSRF och främmande Origin nekas", async t => {
  const { origin, session } = await httpFixture(t);
  const expired = session(1, Date.now() - 1000);
  assert.equal((await fetch(origin + "/api/state", { headers: expired })).status, 401);
  const valid = session(1);
  for (const headers of [{ ...valid, "X-CSRF-Token": "" }, { ...valid, Origin: "https://untrusted.example" }]) {
    assert.equal((await fetch(origin + "/api/vouchers", { method: "POST", headers, body: "{}" })).status, 403);
  }
});

test("audit reproduktion S1: påbörjad mutation godtas efter att sessionen loggats ut", async t => {
  const { s, origin, session } = await httpFixture(t);
  const headers = session(1);
  let observed;
  const sessionRead = new Promise(r => { observed = r; });
  const get = s.get.bind(s);
  s.get = (sql, ...params) => {
    const result = get(sql, ...params);
    if (sql.startsWith("SELECT s.*,u.name")) observed();
    return result;
  };
  const payload = JSON.stringify({ date: "2026-01-02", text: "Efter utloggning", lines });
  let pending;
  const result = new Promise((resolve, reject) => {
    pending = request(origin + "/api/vouchers", { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(payload) } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode));
    });
    pending.on("error", reject);
    pending.flushHeaders();
  });
  await sessionRead;
  assert.equal((await fetch(origin + "/api/logout", { method: "POST", headers, body: "{}" })).status, 200);
  assert.equal(s.get("SELECT COUNT(*) n FROM sessions").n, 0);
  pending.end(payload);
  assert.equal(await result, 200, "Verifierat fel: gammal sessionskopia godtar skrivningen");
  assert.equal(s.get("SELECT COUNT(*) n FROM vouchers").n, 1);
  assert.equal((await fetch(origin + "/api/state", { headers })).status, 401);
});

test("audit säkerhet: låst datum nekas atomärt för faktura, betalning och bankbokning", t => {
  const s = fixture(t), id = issue(s);
  s.bank({ date: "2026-01-03", description: "Test", amount: "10", reference: "A" }, 1);
  s.lock("2026-01-31", 1);
  const before = JSON.stringify(s.state());
  const actions = [
    () => s.post({ date: "2026-01-03", text: "Låst", lines }, 1),
    () => s.payment(id, { date: "2026-01-03", amount: "1" }, 1),
    () => s.credit(id, { date: "2026-01-03" }, 1),
    () => s.bookBank(1, { account: "3041", reviewed: true }, 1),
  ];
  for (const action of actions) assert.throws(action, /låst/);
  assert.equal(JSON.stringify(s.state()), before);
});

test("audit reproduktion S2: backup godtar trasig nummerserie och återställd databas kan inte bokföra", async t => {
  const dir = mkdtempSync(join(tmpdir(), "ekonomi-audit-security-"));
  t.after(() => {
    const target = resolve(dir);
    assert.equal(dirname(target), resolve(tmpdir()), "Radering måste ligga direkt i temporärkatalogen");
    assert.ok(basename(target).startsWith("ekonomi-audit-security-"), "Endast granskarens egen temporärkatalog får raderas");
    rmSync(target, { recursive: true, force: true });
  });
  const s = new Store(join(dir, "source.sqlite"));
  try {
    s.seed([{ email: "audit@example.test", name: "Syntetisk", password: "synthetic-audit-password" }]);
    s.post({ date: "2026-01-02", text: "Original", lines }, 1);
    s.run("UPDATE counters SET value=0 WHERE name='voucher'");
    assert.equal(verifyDatabase(s.path).vouchers, 1);
    const backup = join(dir, "backup.sqlite");
    await makeBackup(s, backup);
    restoreBackup(backup, join(dir, "restored.sqlite"));
    const restored = new Store(join(dir, "restored.sqlite"));
    try {
      assert.throws(() => restored.post({ date: "2026-01-03", text: "Efter restore", lines }, 1), /UNIQUE constraint/);
      assert.equal(restored.get("SELECT value FROM counters WHERE name='voucher'").value, 0);
    } finally { restored.close(); }
  } finally { s.close(); }
});

test("audit reproduktion S3: DB-skydd kan återöppna fastställd faktura utan att ta bort triggers", t => {
  const s = fixture(t), id = issue(s);
  assert.throws(() => s.run("UPDATE invoices SET description='Ändrad' WHERE id=?", id), /oföränderlig/);
  s.run("UPDATE invoices SET status='draft' WHERE id=?", id);
  s.run("UPDATE invoices SET description='Ändrad', total=99999 WHERE id=?", id);
  assert.equal(s.get("SELECT total FROM invoices WHERE id=?", id).total, 99999);
  assert.equal(s.reports().receivables, 0);
  assert.equal(s.reports().trialBalance.find(a => a.number === "1510").balance, 12500);
});

test("audit reproduktion S3: DB-skydd tillåter nya rader på verifikation i låst period", t => {
  const s = fixture(t), v = s.post({ date: "2026-01-02", text: "Original", lines }, 1);
  s.lock("2026-01-31", 1);
  const before = s.get("SELECT COUNT(*) n FROM audit").n;
  s.run("INSERT INTO entries(voucher_id,account,debit,credit) VALUES(?,'1930',10000,0)", v.id);
  s.run("INSERT INTO entries(voucher_id,account,debit,credit) VALUES(?,'3041',0,10000)", v.id);
  assert.equal(s.reports().cash, 20000);
  assert.equal(s.get("SELECT COUNT(*) n FROM audit").n, before);
});

test("audit reproduktion S4: misslyckade försök på okänt konto blockerar alla verkliga konton", async t => {
  const { origin } = await httpFixture(t);
  const headers = { Origin: origin, "Content-Type": "application/json" };
  for (let i = 0; i < 10; i++) {
    const res = await fetch(origin + "/api/login", { method: "POST", headers, body: JSON.stringify({ email: "nonexistent@example.test", password: null }) });
    assert.equal(res.status, 401);
  }
  const res = await fetch(origin + "/api/login", { method: "POST", headers, body: JSON.stringify({ email: "audit@example.test", password: "synthetic-audit-password" }) });
  assert.equal(res.status, 429);
});

test("audit reproduktion S5: företagsändring sparar endast version i behandlingshistoriken", t => {
  const s = fixture(t);
  const before = s.get("SELECT * FROM company WHERE id=1");
  s.company({ version: before.version, name: "Nytt syntetiskt namn", orgNumber: before.org_number, vatNumber: before.vat_number, fTax: true, address: before.address, bank: "Förändrad testbank", fiscalStart: before.fiscal_start, fiscalEnd: before.fiscal_end }, 1);
  const a = s.get("SELECT detail FROM audit WHERE action='company.update'");
  assert.deepEqual(JSON.parse(a.detail), { version: 2 });
  assert.equal(s.get("SELECT bank FROM company WHERE id=1").bank, "Förändrad testbank");
});
