import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { Store } from "../src/domain.mjs";
import { createApp } from "../src/server.mjs";
import { exportSIE } from "../src/sie.mjs";

// Reproduction tests deliberately assert the observed defects. Green is evidence
// that the finding remains, not an acceptance criterion for production use.
function fixture(t) {
  const store = new Store(":memory:");
  store.seed([{ email: "integration@example.test", name: "Syntetisk granskare", password: "synthetic-integration-password" }]);
  t.after(() => store.close());
  return store;
}

test("INT-1 reproduktion: bokförd text accepteras men blockerar hela årets SIE-export", t => {
  const store = fixture(t);
  store.post({ date: "2026-10-01", text: "Syntetiskt köp i €", lines: [
    { account: "5410", debit: "100" }, { account: "1930", credit: "100" },
  ] }, 1);
  assert.equal(store.reports().expenses, 10000);
  assert.throws(() => exportSIE(store), /CP437/);
  store.reverse(1, { date: "2026-10-02", reason: "Rätta beskrivning" }, 1);
  assert.equal(store.reports().expenses, 0);
  assert.throws(() => exportSIE(store), /CP437/);
  assert.equal(store.exportData(1).vouchers.length, 2);
});

test("INT-2 reproduktion: två samtidiga identiska HTTP-delbetalningar bokförs båda", async t => {
  const store = fixture(t);
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const app = createApp(store, { port });
  await new Promise(resolve => app.listen(port, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(origin + "/api/login", { method: "POST", headers: {
    Origin: origin, "Content-Type": "application/json",
  }, body: JSON.stringify({ email: "integration@example.test", password: "synthetic-integration-password" }) });
  assert.equal(login.status, 200);
  const headers = {
    Origin: origin, "Content-Type": "application/json",
    Cookie: login.headers.get("set-cookie").split(";")[0],
    "X-CSRF-Token": (await login.json()).csrf,
    "Idempotency-Key": "one-synthetic-bank-payment",
  };
  const customer = store.customer({ name: "Testkund", orgNumber: "559999-9998", email: "kund@example.test", address: "Testgatan 1" }, 1);
  const invoice = store.invoice({ customerId: customer.id, date: "2026-10-01", dueDate: "2026-10-31", description: "Syntetisk tjänst", quantity: "1", unitPrice: "100", vatRate: 25 }, 1);
  store.issue(invoice.id, 1, 1);
  const request = () => fetch(origin + `/api/invoices/${invoice.id}/payment`, {
    method: "POST", headers, body: JSON.stringify({ amount: "50", date: "2026-10-02", idempotencyKey: "one-synthetic-bank-payment" }),
  });
  const responses = await Promise.all([request(), request()]);
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  await Promise.all(responses.map(response => response.json()));
  assert.equal(store.reports().cash, 10000);
  assert.equal(store.reports().receivables, 2500);
  assert.equal(store.state().vouchers.length, 3);
});
