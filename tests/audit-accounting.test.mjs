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

test("AUD-A1: två olika betalnings-ID kan boka samma belopp, varje ID exakt en gång", t => {
  const s = fixture(t), id = issued(s);
  const data = { amount: "50", date: "2026-10-02", idempotencyKey: "same-synthetic-payment" };
  const first = s.payment(id, data, 1);
  assert.deepEqual(s.payment(id, data, 1), first);
  assert.equal(s.reports().cash, 5000);
  assert.equal(s.reports().receivables, 7500);
  assert.throws(() => s.payment(id, { ...data, amount: "49" }, 1), /andra uppgifter/);
  const anotherInvoice = issued(s);
  assert.throws(() => s.payment(anotherInvoice, data, 1), /andra uppgifter/);
  s.payment(id, { ...data, idempotencyKey: "other-payment" }, 1);
  assert.equal(s.reports().cash, 10000);
  assert.equal(s.reports().receivables, 15000);
  assert.equal(s.get("SELECT COUNT(*) n FROM vouchers WHERE invoice_id=?", id).n, 3);
});

test("AUD-A2: matchad kundbetalning återförs i både reskontra, grundbok och bank", t => {
  const s = fixture(t), id = issued(s);
  const {paymentId} = s.payment(id, { amount: "100", date: "2026-10-02" }, 1);
  s.bank({ date: "2026-10-02", description: "Kundbetalning", amount: "100", reference: "bank-100" }, 1);
  const bank = s.state().bank[0];
  assert.deepEqual(s.suggestBank(bank.id, 1).map(v => v.id), [paymentId]);
  const before = s.state().vouchers.length;
  assert.throws(() => s.bookBank(bank.id, { account: "3041", reviewed: true }, 1), /möjlig träff/);
  s.matchBank(bank.id, { voucherId: paymentId }, 1);
  assert.equal(s.state().vouchers.length, before);
  assert.throws(() => s.bookBank(bank.id, { account: "3041", reviewed: true }, 1), /redan bokförd/);
  const data = { date: "2026-10-03", reason: "Ingen verklig betalning skedde" };
  const correction = s.reverse(paymentId, data, 1);
  assert.equal(balance(s, "1510"), 12500);
  assert.equal(s.reports().receivables, 12500);
  assert.equal(s.reports().cash, 0);
  assert.equal(s.state().bank[0].voucher_id, null);
  assert.equal(s.state().invoices[0].status, "issued");
  assert.throws(() => s.reverse(paymentId, data, 1));
  assert.throws(() => s.reverse(correction.id, data, 1));
});

test("AUD-A3: motbokad bankhändelse öppnas för omklassificering", t => {
  const s = fixture(t);
  s.bank({ date: "2026-10-01", description: "Syntetisk kostnad", amount: "-100", reference: "audit-bank-1" }, 1);
  const p = s.bookBank(1, { account: "5410", reviewed: true }, 1);
  s.reverse(p.id, { date: "2026-10-02", reason: "Fel konto" }, 1);
  assert.equal(s.reports().cash, 0);
  assert.equal(s.state().bank[0].voucher_id, null);
  const replacement = s.bookBank(1, { account: "5420", reviewed: true }, 1);
  assert.equal(s.state().bank[0].voucher_id, replacement.id);
  assert.equal(s.reports().cash, -10000);
});

test("AUD-A4 reproduktion: manuell kundfordran saknas i Att få betalt", t => {
  const s = fixture(t);
  s.post({ date: "2026-10-01", text: "Syntetisk manuell kundfordran", lines: [{ account: "1510", debit: "100" }, { account: "3044", credit: "100" }] }, 1);
  assert.equal(balance(s, "1510"), 10000);
  assert.equal(s.reports().receivables, 0);
});

test("AUD-A5: tom och okänd explicit valuta avvisas atomärt", t => {
  const s = fixture(t);
  const before = s.state();
  for (const currency of ["", "QQQ", "EU"]) {
    const csv = `date;description;amount;currency;reference\n2026-10-01;Syntetisk EUR-fil rad 1;100;EUR;eur1\n2026-10-02;Syntetisk EUR-fil rad 2;100;${currency};eur2`;
    assert.throws(() => s.import({ source: "bank", csv }, 1), /Rad 3:.*valutakod/);
    assert.deepEqual(s.state(), before);
  }
});

test("AUD-A6: två filer bevarar möjlig dubblett för uttrycklig granskning", t => {
  const s = fixture(t);
  const header = "date;description;amount;currency;reference";
  const row = "2026-10-01;Syntetiskt kortköp;-100;SEK;";
  const first = { source: "bank", csv: `${header}\n${row}` };
  const second = { source: "bank", csv: `${header}\n${row}\n2026-10-02;Annan;10;SEK;id-2` };
  assert.equal(s.import(first, 1).inserted, 1);
  assert.equal(s.import(second, 1).inserted, 2);
  assert.equal(s.import(second, 1).duplicates, 2);
  const pending = s.state().bank.find(b => b.review_status === "pending");
  assert.throws(() => s.bookBank(pending.id, { account: "5410", reviewed: true }, 1), /dubbletten/);
  s.reviewBank(pending.id, "distinct", 1);
  s.bookBank(1, { account: "5410", reviewed: true }, 1);
  assert.throws(() => s.bookBank(pending.id, { account: "5410", reviewed: true }, 1), /möjlig träff/);
  s.bookBank(pending.id, { account: "5410", reviewed: true, distinctFrom: "1" }, 1);
  assert.equal(s.reports().cash, -20000);
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
