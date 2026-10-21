import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/domain.mjs";
import {
  decimal,
  amountText,
  invoiceAmounts,
  convertCurrency,
} from "../src/money.mjs";
import { makeBackup, restoreBackup } from "../src/backup.mjs";
import { invoicePDF } from "../src/pdf.mjs";

const users = [
  {
    email: "owner@example.test",
    name: "Ägare",
    password: "test-password-very-long",
  },
];
function fixture(t, path = ":memory:") {
  const s = new Store(path);
  s.seed(users);
  t.after(() => s.close());
  return s;
}
function newInvoice(s, price = "20000") {
  const c = s.customer(
    {
      name: "Kund AB",
      orgNumber: "559999-9998",
      email: "kund@example.test",
      address: "Testvägen 2",
    },
    1,
  );
  return s.invoice(
    {
      customerId: c.id,
      date: "2026-10-01",
      dueDate: "2026-10-31",
      description: "Webbutveckling",
      quantity: "1",
      unitPrice: price,
      vatRate: 25,
    },
    1,
  ).id;
}
const lines = [
  { account: "1930", debit: "1000" },
  { account: "2081", credit: "1000" },
];
test("exakt decimalhantering och avrundning utan binära penningberäkningar", () => {
  assert.equal(decimal("0,29"), 29);
  assert.equal(amountText(-101), "-1.01");
  assert.equal(invoiceAmounts("3", "0.10", 25).total, 38);
  assert.equal(convertCurrency("100.01", "10.123456"), 101245);
  assert.throws(() => decimal("1.001"));
  assert.throws(() => decimal(1));
  assert.throws(() => decimal("1e2"));
  assert.throws(() => invoiceAmounts("999999999", "999999999", 25));
});
test("20 000 SEK + 25 %: fastställer 25 000 och balanserar 1510/3041/2611", (t) => {
  const s = fixture(t),
    id = newInvoice(s);
  s.issue(id, 1, 1);
  const i = s.state().invoices[0];
  assert.equal(i.net, 2000000);
  assert.equal(i.vat, 500000);
  assert.equal(i.total, 2500000);
  assert.equal(i.number, 1);
  const totals = Object.fromEntries(
    s.reports().trialBalance.map((a) => [a.number, a.balance]),
  );
  assert.equal(totals["1510"], 2500000);
  assert.equal(totals["3041"], -2000000);
  assert.equal(totals["2611"], -500000);
  assert.equal(s.reports().income, 2000000);
  assert.equal(
    s.reports().balance.assets,
    s.reports().balance.liabilities + s.reports().balance.equity,
  );
  assert.throws(() => s.issue(id, 1, 1), /ändrats/);
});
test("delbetalning, återstående skuld och överbetalning", (t) => {
  const s = fixture(t),
    id = newInvoice(s);
  s.issue(id, 1, 1);
  s.payment(id, { amount: "10000", date: "2026-10-02" }, 1);
  assert.equal(s.state().invoices[0].status, "partial");
  assert.equal(s.reports().receivables, 1500000);
  assert.equal(s.reports().cash, 1000000);
  assert.throws(() =>
    s.payment(id, { amount: "15000.01", date: "2026-10-03" }, 1),
  );
  s.payment(id, { amount: "15000", date: "2026-10-03" }, 1);
  assert.equal(s.state().invoices[0].status, "paid");
  assert.equal(s.reports().receivables, 0);
});
test("full kredit är separat faktura och återför intäkter, moms och skuld", (t) => {
  const s = fixture(t),
    id = newInvoice(s);
  s.issue(id, 1, 1);
  const c = s.credit(id, { date: "2026-10-02" }, 1);
  const credit = s.get("SELECT * FROM invoices WHERE id=?", c.id);
  assert.equal(credit.total, -2500000);
  assert.equal(credit.original_id, id);
  assert.equal(credit.number, 2);
  assert.equal(s.reports().income, 0);
  assert.equal(s.reports().receivables, 0);
  assert.equal(
    s.reports().trialBalance.find((a) => a.number === "2611").balance,
    0,
  );
  assert.throws(() => s.credit(id, { date: "2026-10-03" }, 1));
});
test("CSV-dubbletter mellan filer och manuella bankrader förhindras", (t) => {
  const s = fixture(t),
    csv =
      "datum;beskrivning;belopp;valuta;referens\n2026-10-01;Amazon;100,00;EUR;ref1\n";
  assert.equal(s.import({ source: "bank", csv }, 1).inserted, 1);
  assert.equal(s.import({ source: "bank", csv }, 1).duplicates, 1);
  assert.equal(s.import({ source: "bank", csv: csv + "\n" }, 1).inserted, 0);
  assert.equal(
    s.bank(
      {
        date: "2026-10-01",
        description: "Amazon",
        amount: "100",
        currency: "EUR",
        reference: "ref1",
      },
      1,
    ).inserted,
    false,
  );
  assert.equal(s.state().bank.length, 1);
  assert.equal(s.state().bank[0].currency, "EUR");
  assert.equal(s.reports().income, 0);
});
test("trasig CSV och ogiltigt datum lämnar inga halva importer", (t) => {
  const s = fixture(t);
  for (const csv of [
    "datum;belopp\n2026-10-01;10",
    "date;description;amount\n2026-10-01;A;10\n2026-02-30;B;20",
    'date;description;amount\n2026-10-01;"A;10',
    "date;description;amount\n2026-10-01;A;1;extra",
  ])
    assert.throws(() => s.import({ source: "bank", csv }, 1));
  assert.equal(s.state().imports.length, 0);
  assert.equal(s.state().bank.length, 0);
});
test("obalanserad verifikation rullas tillbaka inklusive nummerserie", (t) => {
  const s = fixture(t);
  assert.throws(
    () =>
      s.post(
        {
          date: "2026-10-01",
          text: "Fel",
          lines: [
            { account: "1930", debit: "100" },
            { account: "2081", credit: "99" },
          ],
        },
        1,
      ),
    /balanserar/,
  );
  assert.equal(s.state().vouchers.length, 0);
  assert.equal(
    s.post({ date: "2026-10-01", text: "Kapital", lines }, 1).number,
    1,
  );
});
test("låst period, oföränderliga poster och spårbar motbokning", (t) => {
  const s = fixture(t);
  const v = s.post({ date: "2026-10-01", text: "Kapital", lines }, 1);
  s.lock("2026-10-01", 1);
  assert.throws(
    () => s.post({ date: "2026-10-01", text: "Fel", lines }, 1),
    /låst/,
  );
  assert.throws(
    () => s.run("UPDATE entries SET debit=1 WHERE id=1"),
    /oföränderliga/,
  );
  assert.throws(() => s.run("DELETE FROM vouchers WHERE id=?", v.id));
  s.reverse(v.id, { date: "2026-10-02", reason: "Felregistrering" }, 1);
  assert.equal(s.reports().cash, 0);
  assert.equal(s.state().vouchers[0].reversal_of, v.id);
  assert.throws(() =>
    s.reverse(v.id, { date: "2026-10-03", reason: "igen" }, 1),
  );
});
test("viewer och okänd användare får inte mutera eller exportera backupdata", (t) => {
  const s = fixture(t);
  s.run(
    "INSERT INTO users(email,name,role,password) VALUES(?,?,?,?)",
    "read@example.test",
    "Läsare",
    "viewer",
    s.get("SELECT password FROM users WHERE id=1").password,
  );
  assert.throws(
    () => s.post({ date: "2026-10-01", text: "Fel", lines }, 2),
    (e) => e.status === 403,
  );
  assert.throws(
    () => s.lock("2026-10-01", 2),
    (e) => e.status === 403,
  );
  assert.throws(
    () => s.exportData(2),
    (e) => e.status === 403,
  );
  assert.throws(
    () => s.bank({}, 999),
    (e) => e.status === 403,
  );
});
test("utländsk valuta bevaras, kräver kurs och kan bara bokföras en gång", (t) => {
  const s = fixture(t);
  s.bank(
    {
      date: "2026-10-01",
      description: "Valutainbetalning",
      amount: "100",
      currency: "EUR",
    },
    1,
  );
  assert.throws(() => s.bookBank(1, { account: "3044", reviewed: true }, 1));
  s.bookBank(
    1,
    { account: "3044", reviewed: true, exchangeRate: "11.123456" },
    1,
  );
  assert.equal(s.reports().cash, 111235);
  const b = s.state().bank[0];
  assert.equal(b.original_amount, 10000);
  assert.equal(b.exchange_rate, "11.123456");
  assert.throws(() =>
    s.bookBank(1, { account: "3044", reviewed: true, exchangeRate: "11" }, 1),
  );
});
test("valutakursdifferens kan redovisas separat utan att ändra fordran", (t) => {
  const s = fixture(t);
  s.post(
    {
      date: "2026-10-01",
      text: "Fordran 100 EUR kurs 11, manuellt verifierad",
      lines: [
        { account: "1510", debit: "1100" },
        { account: "3044", credit: "1100" },
      ],
    },
    1,
  );
  s.post(
    {
      date: "2026-10-02",
      text: "Betalning 100 EUR kurs 11,20; kursvinst",
      lines: [
        { account: "1930", debit: "1120" },
        { account: "1510", credit: "1100" },
        { account: "3960", credit: "20" },
      ],
    },
    1,
  );
  const balances = Object.fromEntries(
    s.reports().trialBalance.map((a) => [a.number, a.balance]),
  );
  assert.equal(balances["1510"], 0);
  assert.equal(balances["3960"], -2000);
  assert.equal(balances["1930"], 112000);
});
test("optimistisk versionskontroll och frysta fakturauppgifter", (t) => {
  const s = fixture(t),
    id = newInvoice(s);
  s.issue(id, 1, 1);
  assert.throws(
    () => s.issue(id, 1, 1),
    (e) => e.status === 409,
  );
  assert.throws(
    () => s.run("UPDATE invoices SET total=1 WHERE id=?", id),
    /oföränderlig/,
  );
  s.run("UPDATE customers SET name='Ny kunduppgift' WHERE id=1");
  const snap = JSON.parse(
    s.get("SELECT snapshot FROM invoices WHERE id=?", id).snapshot,
  );
  assert.equal(snap.customer.name, "Kund AB");
  const pdf = invoicePDF(s, id);
  assert.equal(pdf.subarray(0, 8).toString(), "%PDF-1.4");
  assert.match(pdf.toString("latin1"), /25000.00/);
  assert.doesNotMatch(pdf.toString("latin1"), /Ny kunduppgift/);
});
test("saknade eller brutna underlag avvisas och underlag arkiveras oföränderligt", (t) => {
  const s = fixture(t);
  assert.throws(() =>
    s.post(
      { date: "2026-10-01", text: "Saknat underlag", lines, documentId: 999 },
      1,
    ),
  );
  assert.throws(() =>
    s.document(
      {
        name: "fake.pdf",
        type: "application/pdf",
        data: Buffer.from("not a PDF").toString("base64"),
      },
      1,
    ),
  );
  const pdf = Buffer.from("%PDF-1.4\n%%EOF");
  const d = s.document(
    { name: "test.pdf", type: "application/pdf", data: pdf.toString("base64") },
    1,
  );
  s.post(
    {
      date: "2026-10-01",
      text: "Kapital med underlag",
      lines,
      documentId: d.id,
    },
    1,
  );
  assert.equal(s.state().vouchers[0].document_id, d.id);
  assert.equal(
    s.document(
      {
        name: "duplicate.pdf",
        type: "application/pdf",
        data: pdf.toString("base64"),
      },
      1,
    ).duplicate,
    true,
  );
  assert.throws(() => s.run("DELETE FROM documents WHERE id=?", d.id));
});
test("backup och återställning verifierar data, checksumma och tar bort sessioner", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ekonomi-test-"));
  const s = fixture(t, join(dir, "source.sqlite"));
  t.after(() => {
    assert.ok(dir.startsWith(join(tmpdir(), "ekonomi-test-")));
    rmSync(dir, { recursive: true, force: true });
  });
  s.post({ date: "2026-10-01", text: "Kapital", lines }, 1);
  s.run(
    "INSERT INTO sessions VALUES(?,?,?,?)",
    "hash",
    1,
    "csrf",
    Date.now() + 100000,
  );
  const dest = join(dir, "backup.sqlite");
  await makeBackup(s, dest);
  const restored = join(dir, "restored.sqlite");
  restoreBackup(dest, restored);
  const r = new Store(restored);
  try {
    assert.deepEqual(r.reports(), s.reports());
    assert.equal(r.get("SELECT COUNT(*) n FROM sessions").n, 0);
    assert.equal(r.state().audit.length, s.state().audit.length);
  } finally {
    r.close();
  }
  assert.throws(() => restoreBackup(dest, restored));
  writeFileSync(
    dest,
    Buffer.concat([readFileSync(dest), Buffer.from("corruption")]),
  );
  assert.throws(
    () => restoreBackup(dest, join(dir, "bad.sqlite")),
    /kontrollsumma/,
  );
});
