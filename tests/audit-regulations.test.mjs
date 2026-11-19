// Riskprover: grönt resultat bekräftar observerat nuläge, inte regelefterlevnad.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/domain.mjs";
import { exportSIE } from "../src/sie.mjs";

function fixture(t) {
  const s = new Store(":memory:");
  s.seed([{ email: "audit@example.test", name: "Granskare", password: "synthetic-audit-password" }]);
  t.after(() => s.close());
  return s;
}
function invoice(s, extra = {}) {
  const c = s.customer({ name: "Syntetisk Kund AB", orgNumber: "559999-9998", email: "customer@example.test", address: "Testgatan 2" }, 1);
  return s.invoice({ customerId: c.id, date: "2026-10-01", dueDate: "2026-10-31", description: "Syntetisk konsulttjänst", quantity: "1", unitPrice: "10000", vatRate: 25, ...extra }, 1);
}

test("REG-01/F-14/F-15: ej stödda fakturafält avvisas före mutation", (t) => {
  const s = fixture(t);
  for (const extra of [{ deliveryDate: "2026-09-30" }, { lines: [{ unitPrice: "200" }] }])
    assert.throws(() => invoice(s, extra), /stöds inte/);
  assert.equal(s.state().invoices.length, 0);
  const { id } = invoice(s);
  s.issue(id, 1, 1);
  const before = s.state();
  assert.throws(() => s.credit(id, { date: "2026-10-02", amount: "50" }, 1), /Fältet amount/);
  assert.deepEqual(s.state(), before);
});

test("REG-02 riskbevis: verifikation utan motpart eller underlag accepteras och saknar kompletteringslänk", (t) => {
  const s = fixture(t);
  const { id } = s.post({ date: "2026-10-01", text: "Inköp", lines: [{ account: "6110", debit: "100" }, { account: "1930", credit: "100" }] }, 1);
  const v = s.get("SELECT * FROM vouchers WHERE id=?", id);
  assert.equal(v.document_id, null);
  assert.equal(v.counterparty, undefined);
  const d = s.document({ name: "syntetiskt.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4\nsynthetic").toString("base64") }, 1);
  assert.throws(() => s.run("UPDATE vouchers SET document_id=? WHERE id=?", d.id, id), /oföränderliga/);
  assert.equal(s.exportData(1).vouchers.find((x) => x.id === id).document_id, null);
});

test("REG-03: ogiltiga år spärras i inställning, bokföring och export", (t) => {
  const s = fixture(t);
  const settings = (end, start = "2026-01-01") => {
    const c = s.state().company;
    return { name: c.name, orgNumber: c.org_number, vatNumber: c.vat_number, fTax: true, address: c.address, bank: c.bank, fiscalStart: start, fiscalEnd: end, version: c.version };
  };
  const voucher = { date: "2026-02-01", text: "Syntetisk kapitalinsättning", lines: [{ account: "1930", debit: "100" }, { account: "2081", credit: "100" }] };
  assert.throws(() => s.company(settings("2030-12-31"), 1), /Ogiltigt räkenskapsår/);
  for (const [start, end] of [["2026-02-01", "2027-01-31"], ["2026-01-01", "2026-12-01"], ["2026-01-01", "2027-06-30"]]) {
    s.company(settings(end, start), 1);
    assert.ok(exportSIE(s).toString("latin1").includes(`#RAR 0 ${start.replaceAll("-", "")} ${end.replaceAll("-", "")}`));
  }
  assert.throws(() => s.company(settings("2027-07-01"), 1), /högst 18/);
  s.post(voucher, 1);
  s.run("UPDATE company SET fiscal_end='2030-12-31'");
  assert.throws(() => s.post(voucher, 1), /Ogiltigt räkenskapsår/);
  assert.throws(() => exportSIE(s), /Ogiltigt räkenskapsår/);
  assert.throws(() => s.company(settings("2026-12-31", "2026-03-01"), 1), /måste rymma/);
  s.company(settings("2026-12-31"), 1);
  assert.equal(s.state().vouchers.length, 1);
  assert.match(exportSIE(s).toString("latin1"), /#RAR 0 20260101 20261231/);
});

test("REG-04 avgränsningskontroll: ej stödda momssatser avvisas atomärt", (t) => {
  const s = fixture(t);
  for (const vatRate of [0, 6, 12]) assert.throws(() => invoice(s, { vatRate }), /25 %/);
  assert.equal(s.state().invoices.length, 0);
  assert.equal(s.state().vouchers.length, 0);
});

test("REG-05 omfattningsbevis: ingen momsrapport eller momsperiod finns i rapport-API", (t) => {
  const s = fixture(t);
  const { id } = invoice(s);
  s.issue(id, 1, 1);
  const r = s.reports();
  assert.equal(r.trialBalance.find((a) => a.number === "2611").balance, -250000);
  assert.equal(r.vat, undefined);
  assert.equal(r.vatReturn, undefined);
  assert.equal(r.vatPeriod, undefined);
});
