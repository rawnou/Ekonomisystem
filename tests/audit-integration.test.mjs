import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { Store } from "../src/domain.mjs";
import { createApp } from "../src/server.mjs";
import { exportSIE } from "../src/sie.mjs";

// INT-1 documents a remaining defect. Later tests verify corrected behavior.
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

test("INT-2: samtidiga och senare försök med samma betalnings-ID bokförs en gång", async t => {
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
  const [first, second] = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(first, second);
  for (const retry of [await request(), await request()]) assert.deepEqual(await retry.json(), first);
  assert.equal(store.reports().cash, 5000);
  assert.equal(store.reports().receivables, 7500);
  assert.equal(store.state().vouchers.length, 2);
  const csv = "date,description,amount,reference\n2026-10-02,Fiktiv betalning,50,TX1\n2026-10-03,Fiktiv avgift,-10,TX2";
  const upload = () => fetch(origin + "/api/imports", {
    method: "POST", headers, body: JSON.stringify({source: "bank", csv}),
  });
  const imports = await Promise.all([upload(), upload()]);
  assert.deepEqual(imports.map(r => r.status), [200, 200]);
  const counts = await Promise.all(imports.map(r => r.json()));
  assert.deepEqual(counts.map(r => r.inserted).sort(), [0, 2]);
  assert.equal(store.state().imports.length, 1);
  assert.equal(store.state().bank.length, 2);
});


test("F-11/T-03: bokföringsidentiteter överlever omstart med SQLite", () => {
  const directory = mkdtempSync(join(tmpdir(), "balans-replay-"));
  const dbPath = join(directory, "balans.sqlite");
  let store = new Store(dbPath);
  try {
    store.seed([{ email: "disk@example.test", name: "Test", password: "synthetic-disk-password" }]);
    const { id: customerId } = store.customer({
      name: "Testkund AB", orgNumber: "559999-9998", email: "kund@example.test", address: "Testgatan 1",
    }, 1);
    const { id } = store.invoice({
      customerId, date: "2026-10-01", dueDate: "2026-10-31", description: "Testtjänst",
      quantity: "1", unitPrice: "8000", vatRate: 25,
    }, 1);
    store.issue(id, 1, 1);
    const payment = { date: "2026-10-02", amount: "4000", idempotencyKey: "test-R08" };
    const cost = { date: "2026-10-02", text: "Kvitto", idempotencyKey: "test-kuvert", lines: [
      { account: "5410", debit: "5000" }, { account: "1930", credit: "5000" },
    ] };
    const bookedPayment = store.payment(id, payment, 1);
    const bookedCost = store.post(cost, 1);
    store.close();
    store = new Store(dbPath);
    assert.deepEqual(store.payment(id, payment, 1), bookedPayment);
    assert.deepEqual(store.post(cost, 1), bookedCost);
    assert.equal(store.state().vouchers.length, 3);
    const bank = { date: "2026-10-07", description: "Kortköp", amount: "-5000", idempotencyKey: "test-bank" };
    store.bank(bank, 1);
    store.bank(bank, 1);
    assert.equal(store.state().bank.length, 1);
    assert.deepEqual(store.suggestBank(store.state().bank[0].id, 1), []);
    store.matchBank(store.state().bank[0].id, { voucherNumber: bookedCost.number }, 1);
    assert.equal(store.state().vouchers.length, 3);
    store.reverse(bookedPayment.paymentId, { date: "2026-10-03", reason: "Felbetalning" }, 1);
    assert.equal(store.reports().receivables, 1000000);
    assert.equal(store.reports().trialBalance.find(row => row.number === "1510").balance, 1000000);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
