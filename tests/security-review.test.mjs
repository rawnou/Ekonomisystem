import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { Store } from "../src/domain.mjs";
import { hashPassword, checkPassword } from "../src/security.mjs";

function fixture(t) {
  const s = new Store(":memory:");
  t.after(() => s.close());
  s.seed([
    {
      email: "independent-review@example.test",
      name: "Syntetisk granskare",
      role: "admin",
      password: "review-only-synthetic-password",
    },
  ]);
  return s;
}
const lines = [
  { account: "1930", debit: "100" },
  { account: "3041", credit: "100" },
];

test("oberoende: initiering fungerar och kan inte skriva över konton", (t) => {
  const s = fixture(t);
  assert.equal(s.get("SELECT COUNT(*) n FROM company").n, 1);
  assert.equal(s.get("SELECT COUNT(*) n FROM users").n, 1);
  assert.throws(() => s.seed([]), /redan initierad/);
  assert.equal(s.get("SELECT COUNT(*) n FROM users").n, 1);
});

test("oberoende: publika poster kan inte förfalska rättelse- eller fakturarelation", (t) => {
  const s = fixture(t),
    original = s.post({ date: "2026-01-02", text: "Original", lines }, 1);
  for (const extra of [{ reversalOf: original.id }, { invoiceId: 1 }]) {
    assert.throws(
      () =>
        s.post(
          { date: "2026-01-01", text: "Förfalskad relation", lines, ...extra },
          1,
        ),
      /Interna bokföringsreferenser/,
    );
  }
  assert.equal(s.get("SELECT COUNT(*) n FROM vouchers").n, 1);
  const correction = s.reverse(
    original.id,
    { date: "2026-01-03", reason: "Verifierad rättelse" },
    1,
  );
  assert.equal(correction.number, 2);
  assert.equal(s.reports().cash, 0);
});

test("oberoende: ackumulerad gräns avvisar atomärt och lämnar rapporter tillgängliga", (t) => {
  const s = fixture(t);
  const large = Array.from({ length: 100 }, (_, i) =>
    i < 50
      ? { account: "1930", debit: "10000000000" }
      : { account: "3041", credit: "10000000000" },
  );
  for (let i = 0; i < 2; i++)
    s.post(
      { date: "2026-01-02", text: "Syntetiskt gränstest", lines: large },
      1,
    );
  const before = s.exportData(1);
  assert.throws(
    () => s.post({ date: "2026-01-03", text: "Över gränsen", lines }, 1),
    /beloppsgräns/,
  );
  assert.deepEqual(s.state().vouchers, before.vouchers);
  assert.deepEqual(s.all("SELECT * FROM audit"), before.audit);
  assert.equal(
    s.get("SELECT value FROM counters WHERE name='voucher'").value,
    2,
  );
  assert.equal(s.reports().cash, 100_000_000_000_000);
});

test("oberoende: historisk fakturasnapshot finns kvar i JSON-export efter företagsändring", (t) => {
  const s = fixture(t),
    customer = s.customer(
      {
        name: "Testkund",
        orgNumber: "559999-9998",
        email: "customer@example.test",
        address: "Testadress",
      },
      1,
    );
  const invoice = s.invoice(
    {
      customerId: customer.id,
      date: "2026-01-02",
      dueDate: "2026-01-30",
      description: "Test",
      quantity: "1",
      unitPrice: "20000",
      vatRate: 25,
    },
    1,
  );
  s.issue(invoice.id, 1, 1);
  const original = s.get(
    "SELECT snapshot FROM invoices WHERE id=?",
    invoice.id,
  ).snapshot;
  s.company(
    {
      version: 1,
      name: "Ändrat testnamn",
      orgNumber: "559999-9999",
      vatNumber: "SE559999999901",
      fTax: true,
      address: "Ny syntetisk adress",
      bank: "Testbank",
      fiscalStart: "2026-01-01",
      fiscalEnd: "2026-12-31",
    },
    1,
  );
  const exported = s.exportData(1);
  assert.equal(exported.invoices[0].snapshot, original);
  assert.notEqual(JSON.parse(original).company.name, exported.company.name);
});

test("oberoende: scrypt-hash motsvarar explicita granskade parametrar", () => {
  const password = "synthetic-independent-review-password",
    stored = hashPassword(password);
  const [salt, hash] = stored.split(":");
  assert.equal(
    hash,
    scryptSync(password, salt, 64, {
      N: 131072,
      r: 8,
      p: 1,
      maxmem: 256 * 1024 * 1024,
    }).toString("hex"),
  );
  assert.equal(checkPassword(password, stored), true);
  assert.equal(checkPassword("different-synthetic-password", stored), false);
});
