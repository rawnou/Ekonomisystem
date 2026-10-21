// Riskprover: grönt resultat bekräftar observerat nuläge, inte regelefterlevnad.
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/domain.mjs";
import { invoicePDF } from "../src/pdf.mjs";
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

test("REG-01 riskbevis: separat tjänstedatum ignoreras och PDF anger fakturadagen", (t) => {
  const s = fixture(t);
  const { id } = invoice(s, { deliveryDate: "2026-09-30" });
  s.issue(id, 1, 1);
  const pdf = invoicePDF(s, id).toString("latin1");
  assert.ok(pdf.includes("Leverans-/tjänstedatum: 2026-10-01"));
  assert.ok(!pdf.includes("2026-09-30"));
  assert.equal(s.get("SELECT * FROM invoices WHERE id=?", id).delivery_date, undefined);
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

test("REG-03 riskbevis: femårigt räkenskapsår accepteras och exporteras", (t) => {
  const s = fixture(t);
  const c = s.state().company;
  s.company({ name: c.name, orgNumber: c.org_number, vatNumber: c.vat_number, fTax: true, address: c.address, bank: c.bank, fiscalStart: "2026-01-01", fiscalEnd: "2030-12-31", version: c.version }, 1);
  assert.equal(s.state().company.fiscal_end, "2030-12-31");
  s.post({ date: "2030-12-01", text: "Syntetisk kapitalinsättning", lines: [{ account: "1930", debit: "100" }, { account: "2081", credit: "100" }] }, 1);
  assert.match(exportSIE(s).toString("latin1"), /#RAR 0 20260101 20301231/);
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
