import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/domain.mjs";
import { normalizeCSV } from "../src/imports.mjs";
import { invoicePDF } from "../src/pdf.mjs";

function fixture(t) {
  const store = new Store(":memory:");
  store.seed([
    {
      email: "review@example.test",
      name: "Oberoende syntetisk granskare",
      password: "synthetic-review-password",
    },
  ]);
  t.after(() => store.close());
  return store;
}
function customer(store, overrides = {}) {
  return store.customer(
    {
      name: "Syntetisk kund AB",
      orgNumber: "559999-9998",
      email: "customer@example.test",
      address: "Testgatan 2",
      ...overrides,
    },
    1,
  ).id;
}
function draft(store, customerId, price = "100", overrides = {}) {
  return store.invoice(
    {
      customerId,
      date: "2026-10-01",
      dueDate: "2026-10-31",
      description: "Syntetisk tjänst",
      quantity: "1",
      unitPrice: price,
      vatRate: 25,
      ...overrides,
    },
    1,
  ).id;
}

test("Q1: olika rapportperioder bevaras och ändrad fil dubbelimporterar inte", (t) => {
  const store = fixture(t);
  const csv =
    "date;description;amount;currency;period\n2026-10-01;Marketplace;100.00;SEK;2026-08\n2026-10-01;Marketplace;100.00;SEK;2026-09";
  assert.equal(store.import({ source: "kdp", csv }, 1).inserted, 2);
  assert.deepEqual(
    store
      .state()
      .bank.map((r) => r.period)
      .sort(),
    ["2026-08", "2026-09"],
  );
  const replay = store.import({ source: "kdp", csv: csv + "\n" }, 1);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.duplicates, 2);
  assert.equal(store.state().bank.length, 2);
});

test("Q1: lika bankbelopp med olika referenser är skilda verkliga händelser", (t) => {
  const store = fixture(t);
  const csv =
    "date;description;amount;reference\n2026-10-01;Payment;100;unique-1\n2026-10-01;Payment;100;unique-2";
  assert.equal(store.import({ source: "bank", csv }, 1).inserted, 2);
  assert.equal(
    store.state().bank.reduce((sum, row) => sum + row.amount, 0),
    20000,
  );
});

test("Q2: explicit felaktig valutamappning avvisas atomiskt, EUR förblir EUR", (t) => {
  const store = fixture(t);
  const csv = "date;description;amount;currency\n2026-10-01;EUR payout;100;EUR";
  for (const key of ["currency", "reference", "period"]) {
    assert.throws(
      () =>
        store.import(
          { source: "bank", csv, mapping: { [key]: "missing-column" } },
          1,
        ),
      /saknas/,
    );
  }
  assert.equal(store.state().imports.length, 0);
  assert.equal(store.state().bank.length, 0);
  assert.equal(normalizeCSV(csv, { currency: "currency" })[0].currency, "EUR");
});

test("Q3: direkt bankklassificering mot1510 avvisas utan reskontra- eller bokföringsändring", (t) => {
  const store = fixture(t);
  const id = draft(store, customer(store));
  store.issue(id, 1, 1);
  store.bank(
    {
      date: "2026-10-02",
      description: "Syntetisk kundbetalning",
      amount: "125",
      reference: "review-payment",
    },
    1,
  );
  const before = store.state();
  assert.throws(
    () =>
      store.bookBank(before.bank[0].id, { account: "1510", reviewed: true }, 1),
    /faktura|1510/,
  );
  const after = store.state();
  assert.deepEqual(after.reports, before.reports);
  assert.deepEqual(after.invoices, before.invoices);
  assert.deepEqual(after.vouchers, before.vouchers);
  assert.equal(after.bank[0].voucher_id, null);
  assert.equal(after.reports.receivables, 12500);
});

test("Q4: gräns kontrolleras före utkast och högsta accepterade total kan fastställas", (t) => {
  const store = fixture(t),
    c = customer(store);
  assert.throws(() => draft(store, c, "9000000000"), /beloppsgräns/);
  assert.equal(store.state().invoices.length, 0);
  const id = draft(store, c, "8000000000");
  store.issue(id, 1, 1);
  const state = store.state();
  assert.equal(state.invoices[0].total, 1000000000000);
  assert.equal(state.invoices[0].status, "issued");
  assert.equal(
    state.vouchers[0].lines.reduce(
      (sum, row) => sum + row.debit - row.credit,
      0,
    ),
    0,
  );
});

test("Q5: långa tillåtna uppgifter får flera giltigt refererade sidor och ryms geometriskt", (t) => {
  const store = fixture(t);
  const company = store.state().company;
  store.company(
    {
      version: company.version,
      name: "Namn ".repeat(100).trim(),
      orgNumber: "5599999999",
      vatNumber: "SE559999999901",
      fTax: true,
      address: "Gata ".repeat(100).trim(),
      bank: "Bank ".repeat(100).trim(),
      fiscalStart: "2026-01-01",
      fiscalEnd: "2026-12-31",
    },
    1,
  );
  const id = draft(
    store,
    customer(store, {
      name: "K".repeat(500),
      address: "Adress ".repeat(71).trim(),
    }),
    "100",
    { description: "Tjänst ".repeat(71).trim() },
  );
  store.issue(id, 1, 1);
  const pdf = invoicePDF(store, id),
    raw = pdf.toString("latin1");
  const pageCount = Number(/\/Type \/Pages[^\n]*\/Count (\d+)/.exec(raw)?.[1]);
  assert.ok(pageCount >= 2);
  assert.equal((raw.match(/\/Type \/Page /g) || []).length, pageCount);
  const streams = [...raw.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(
    (match) => match[1],
  );
  assert.equal(streams.length, pageCount);
  let renderedText = "";
  for (const stream of streams) {
    const body = stream.split("\nET\n")[0];
    const rows = [...body.matchAll(/\(([^\n]*)\) Tj/g)].map(
      (match) => match[1],
    );
    assert.ok(rows.length <= 44);
    assert.ok(790 - 16 * (rows.length - 1) >= 48);
    for (const row of rows)
      assert.ok(row.length <= 80, `Rad för lång: ${row.length}`);
    renderedText += rows.join("");
  }
  assert.match(renderedText, /TOTALT: 125\.00 SEK/);
  assert.match(renderedText, /Betalningsuppgifter: Bank/);
  assert.ok(renderedText.includes("K".repeat(500)));
  const xref = Number(/startxref\n(\d+)/.exec(raw)[1]);
  assert.equal(pdf.subarray(xref, xref + 4).toString(), "xref");
  for (const match of raw.matchAll(/(\d+) 0 obj\n/g)) {
    const number = Number(match[1]);
    const entry = raw.slice(xref).split("\n")[2 + number];
    assert.equal(
      Number(entry.slice(0, 10)),
      Buffer.byteLength(raw.slice(0, match.index), "latin1"),
    );
  }
});

test("Q1: tvetydiga bank- och royaltyrader avvisas före alla databasändringar", (t) => {
  const store = fixture(t);
  const row = "2026-10-01;Marketplace;100;SEK;2026-08";
  const csv = `date;description;amount;currency;period\n${row}\n${row}`;
  for (const source of ["bank", "kdp", "adtraction"]) {
    assert.throws(
      () => store.import({ source, csv }, 1),
      /Inga rader har importerats.*unika transaktionsreferenser/,
    );
    assert.equal(store.state().imports.length, 0);
    assert.equal(store.state().bank.length, 0);
  }
});

test("Q1: royaltyreferens, rapportperiod och källa bevarar separata händelser", (t) => {
  const store = fixture(t);
  const csv =
    "date;description;amount;currency;period;reference\n2026-10-01;Marketplace;100;SEK;2026-08;r1\n2026-10-01;Marketplace;100;SEK;2026-08;r2\n2026-10-01;Marketplace;100;SEK;2026-09;r1";
  for (const source of ["kdp", "adtraction"]) {
    assert.equal(store.import({ source, csv }, 1).inserted, 3);
    assert.equal(store.import({ source, csv }, 1).duplicates, 3);
  }
  assert.equal(store.state().bank.length, 6);
});
