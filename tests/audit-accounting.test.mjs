import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/domain.mjs";
import { invoiceAmounts, convertCurrency } from "../src/money.mjs";

// Reproduktionsprov: dessa gröna prov bekräftar dokumenterade fel, inte rättat beteende.
function fixture(t) {
  const s = new Store(":memory:");
  s.seed([{ email: "audit@example.test", name: "Syntetisk ekonomigranskare", password: "synthetic-audit-password" }]);
  t.after(() => s.close());
  return s;
}
function issued(s) {
  const c = s.customer({ name: "Syntetisk kund", orgNumber: "559999-9998", email: "test@example.test", address: "Testgatan 1" }, 1);
  const i = s.invoice({ customerId: c.id, date: "2026-10-01", dueDate: "2026-10-31", description: "Syntetisk tjänst", quantity: "1", unitPrice: "100", vatRate: 25 }, 1);
  s.issue(i.id, 1, 1);
  return i.id;
}
const balance = (s, account) => s.reports().trialBalance.find(a => a.number === account).balance;

test("AUD-A1 reproduktion: identisk delbetalning kan dubbelbokas vid retry", t => {
  const s = fixture(t), id = issued(s);
  const payload = { amount: "50", date: "2026-10-02", idempotencyKey: "same-synthetic-payment" };
  s.payment(id, payload, 1);
  s.payment(id, payload, 1);
  assert.equal(s.get("SELECT paid FROM invoices WHERE id=?", id).paid, 10000);
  assert.equal(s.reports().cash, 10000);
  assert.equal(s.reports().receivables, 2500);
  assert.equal(s.get("SELECT COUNT(*) n FROM vouchers WHERE invoice_id=?", id).n, 3);
});

test("AUD-A2 reproduktion: felregistrerad betalning kan inte återställa reskontran", t => {
  const s = fixture(t), id = issued(s);
  s.payment(id, { amount: "125", date: "2026-10-02" }, 1);
  const payment = s.get("SELECT id FROM vouchers WHERE invoice_id=? ORDER BY number DESC", id);
  assert.throws(() => s.reverse(payment.id, { date: "2026-10-03", reason: "Ingen verklig betalning skedde" }, 1), /Fakturarättelser/);
  assert.throws(() => s.credit(id, { date: "2026-10-03" }, 1), /helt obetalda/);
  // Manuell motbokning återställer huvudboken men saknar effekt på fakturans paid/status.
  s.post({ date: "2026-10-03", text: "Manuell rättelse felaktig betalning", lines: [{ account: "1510", debit: "125" }, { account: "1930", credit: "125" }] }, 1);
  assert.equal(balance(s, "1510"), 12500);
  assert.equal(s.reports().receivables, 0);
  assert.equal(s.get("SELECT status FROM invoices WHERE id=?", id).status, "paid");
  assert.throws(() => s.payment(id, { amount: "125", date: "2026-10-04" }, 1), /obetald/);
});

test("AUD-A3 reproduktion: motbokad bankhändelse är fortfarande markerad bokförd", t => {
  const s = fixture(t);
  s.bank({ date: "2026-10-01", description: "Syntetisk kostnad", amount: "-100", reference: "audit-bank-1" }, 1);
  const p = s.bookBank(1, { account: "5410", reviewed: true }, 1);
  s.reverse(p.id, { date: "2026-10-02", reason: "Fel konto" }, 1);
  assert.equal(s.reports().cash, 0);
  assert.equal(s.get("SELECT voucher_id FROM bank WHERE id=1").voucher_id, p.id);
  assert.throws(() => s.bookBank(1, { account: "5420", reviewed: true }, 1), /redan bokförd/);
});

test("AUD-A4 reproduktion: manuell kundfordran saknas i Att få betalt", t => {
  const s = fixture(t);
  s.post({ date: "2026-10-01", text: "Syntetisk manuell kundfordran", lines: [{ account: "1510", debit: "100" }, { account: "3044", credit: "100" }] }, 1);
  assert.equal(balance(s, "1510"), 10000);
  assert.equal(s.reports().receivables, 0);
});

test("AUD-A5 reproduktion: blank valutacell i uttrycklig valutakolumn blir SEK", t => {
  const s = fixture(t);
  const csv = "date;description;amount;currency;reference\n2026-10-01;Syntetisk EUR-fil rad 1;100;EUR;eur1\n2026-10-02;Syntetisk EUR-fil rad 2;100;;eur2";
  assert.equal(s.import({ source: "bank", csv, mapping: { currency: "currency" } }, 1).inserted, 2);
  assert.equal(s.get("SELECT currency FROM bank WHERE reference='eur2'").currency, "SEK");
  s.bookBank(2, { account: "3044", reviewed: true, exchangeRate: "11" }, 1);
  assert.equal(s.reports().cash, 10000); // Om källan avsåg EUR skulle 110000 öre krävas.
  assert.equal(s.get("SELECT exchange_rate FROM bank WHERE id=2").exchange_rate, "1.000000");
});

test("AUD-A6 riskreproduktion: olika verkliga bankhändelser med samma metadata kolliderar", t => {
  const s = fixture(t);
  const event = { date: "2026-10-01", description: "Syntetiskt kortköp", amount: "-100", currency: "SEK" };
  assert.equal(s.bank(event, 1).inserted, true);
  assert.equal(s.bank(event, 1).inserted, false);
  assert.equal(s.get("SELECT COUNT(*) n FROM bank").n, 1);
});

test("AUD-kontroll: 1000 syntetiska pris/antalsfall stämmer mot BigInt-referens", () => {
  const rounded = (n, d) => (n + d / 2n) / d;
  for (let i = 1; i <= 1000; i++) {
    const q = BigInt(i * 137), p = BigInt(i * 139);
    const qty = `${q / 1000n}.${String(q % 1000n).padStart(3, "0")}`;
    const price = `${p / 100n}.${String(p % 100n).padStart(2, "0")}`;
    const a = invoiceAmounts(qty, price, 25);
    const net = rounded(q * p, 1000n), vat = rounded(net * 25n, 100n);
    assert.equal(BigInt(a.net), net);
    assert.equal(BigInt(a.vat), vat);
    assert.equal(BigInt(a.total), net + vat);
  }
  assert.equal(convertCurrency("-100.01", "10.123456"), -101245);
});

test("AUD-kontroll: misslyckad betalning lämnar belopp, serie och historik orörda", t => {
  const s = fixture(t), id = issued(s);
  const before = s.exportData(1);
  assert.throws(() => s.payment(id, { amount: "125.01", date: "2026-10-02" }, 1));
  const after = s.exportData(1);
  delete before.exportedAt;
  delete after.exportedAt;
  assert.deepEqual(after, before);
  s.payment(id, { amount: "125", date: "2026-10-02" }, 1);
  assert.equal(s.get("SELECT MAX(number) n FROM vouchers").n, 2);
});
