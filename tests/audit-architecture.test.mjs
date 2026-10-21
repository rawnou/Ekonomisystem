import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../src/domain.mjs";
import { invoicePDF } from "../src/pdf.mjs";
import { makeBackup, restoreBackup } from "../src/backup.mjs";

// Characterization tests: these pass when the reviewed limitation is present.
// They are evidence of findings, not assertions that this behavior is correct.
function fixture(t, path = ":memory:") {
  const store = new Store(path);
  store.seed([{ email: "audit@example.test", name: "Audit", password: "synthetic-audit-password" }]);
  t.after(() => store.close());
  return store;
}
function invoice(store, name = "Testkund AB", description = "Testtjänst") {
  const customer = store.customer({ name, orgNumber: "559999-9998", email: "audit-customer@example.test", address: "Testgatan 2" }, 1);
  return store.invoice({ customerId: customer.id, date: "2026-12-31", dueDate: "2027-01-30", description, quantity: "1", unitPrice: "100", vatRate: 25 }, 1).id;
}
const lines = [{ account: "1930", debit: "100" }, { account: "2081", credit: "100" }];

test("A1 observed: an issued December invoice cannot be paid next January or move to a new fiscal year", (t) => {
  const s = fixture(t), id = invoice(s);
  s.issue(id, 1, 1);
  assert.throws(() => s.payment(id, { amount: "125", date: "2027-01-02" }, 1), /utanför räkenskapsåret/);
  const c = s.state().company;
  assert.throws(() => s.company({ name: c.name, orgNumber: c.org_number, vatNumber: c.vat_number, fTax: c.f_tax, address: c.address, bank: c.bank, fiscalStart: "2027-01-01", fiscalEnd: "2027-12-31", version: c.version }, 1), /Räkenskapsår med bokföring kan inte ändras/);
  assert.equal(s.state().invoices[0].paid, 0);
  assert.equal(s.state().vouchers.length, 1);
});

for (const field of ["customer", "description"]) {
  test(`A2 observed: unsupported Unicode in ${field} is frozen into an issued invoice before PDF failure`, (t) => {
    const s = fixture(t), id = invoice(s, field === "customer" ? "测试 AB" : "Testkund AB", field === "description" ? "Tjänst 😀" : "Testtjänst");
    s.issue(id, 1, 1);
    assert.equal(s.state().invoices[0].status, "issued");
    assert.equal(s.reports().receivables, 12500);
    assert.throws(() => invoicePDF(s, id), /Unicode-font/);
    if (field === "customer") {
      s.run("UPDATE customers SET name='Testkund AB' WHERE id=1");
      assert.throws(() => invoicePDF(s, id), /Unicode-font/);
    }
    assert.throws(() => s.run("UPDATE invoices SET description='Ändrad testtjänst' WHERE id=?", id), /oföränderlig/);
  });
}

test("A3 observed: backup verification accepts a broken voucher counter and restored posting fails", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ekonomi-audit-architecture-"));
  const s = new Store(join(dir, "source.sqlite"));
  let restored;
  try {
    s.seed([{ email: "audit@example.test", name: "Audit", password: "synthetic-audit-password" }]);
    s.post({ date: "2026-10-01", text: "Testkapital", lines }, 1);
    // Model a semantically damaged database; this requires direct DB access.
    // No HTTP exploit or ordinary user path to this damage is claimed.
    s.run("UPDATE counters SET value=0 WHERE name='voucher'");
    const backup = join(dir, "backup.sqlite"), target = join(dir, "restored.sqlite");
    const manifest = await makeBackup(s, backup);
    assert.equal(manifest.vouchers, 1);
    assert.equal(restoreBackup(backup, target).vouchers, 1);
    restored = new Store(target);
    assert.throws(() => restored.post({ date: "2026-10-02", text: "Nästa testpost", lines }, 1), /UNIQUE constraint failed: vouchers.number/);
    assert.equal(restored.state().vouchers.length, 1);
  } finally {
    restored?.close();
    s.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + "\\ekonomi-audit-architecture-"));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A4 observed: previous company settings and unused original CSV fields are absent from export", (t) => {
  const s = fixture(t);
  const update = (bank) => {
    const c = s.state().company;
    s.company({ name: c.name, orgNumber: c.org_number, vatNumber: c.vat_number, fTax: c.f_tax, address: c.address, bank, fiscalStart: c.fiscal_start, fiscalEnd: c.fiscal_end, version: c.version }, 1);
  };
  update("synthetic-previous-bank-58401");
  update("synthetic-current-bank-58402");
  s.import({ source: "bank", csv: "date;description;amount;currency;evidence\n2026-10-01;Test;100;SEK;synthetic-original-extra-58403" }, 1);
  const exported = JSON.stringify(s.exportData(1));
  assert.ok(exported.includes("synthetic-current-bank-58402"));
  assert.ok(!exported.includes("synthetic-previous-bank-58401"));
  assert.ok(!exported.includes("synthetic-original-extra-58403"));
  assert.deepEqual(s.all("SELECT detail FROM audit WHERE action='company.update'").map((r) => JSON.parse(r.detail)), [{ version: 2 }, { version: 3 }]);
});
