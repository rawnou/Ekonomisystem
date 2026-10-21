import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/domain.mjs";
import { exportSIE } from "../src/sie.mjs";

function fixture(t) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.run(
    "INSERT INTO company(id,name,org_number,vat_number,f_tax,address,bank,fiscal_start,fiscal_end) VALUES(1,?,?,?,?,?,?,?,?)",
    "ÅÄÖ åäö AB",
    "5599999999",
    "SE559999999901",
    1,
    "Stockholm",
    "1930",
    "2026-01-01",
    "2026-12-31",
  );
  store.run(
    "INSERT INTO users(id,email,name,role,password) VALUES(1,?,?,?,?)",
    "test@example.invalid",
    "Test",
    "admin",
    "unused",
  );
  return store;
}

const asText = (bytes) => bytes.toString("latin1"); // ASCII records; CP437 bytes are tested separately.

test("SIE4E fixture: capital, invoice and cost reconcile to independent known balances", (t) => {
  const store = fixture(t);
  store.post(
    {
      date: "2026-01-01",
      text: "Aktiekapital",
      lines: [
        { account: "1930", debit: "25000" },
        { account: "2081", credit: "25000" },
      ],
    },
    1,
  );
  store.post(
    {
      date: "2026-02-01",
      text: 'Faktura "ett"',
      lines: [
        { account: "1510", debit: "1250" },
        { account: "3041", credit: "1000" },
        { account: "2611", credit: "250" },
      ],
    },
    1,
  );
  store.post(
    {
      date: "2026-02-02",
      text: "Programvara",
      lines: [
        { account: "5420", debit: "100" },
        { account: "2641", debit: "25" },
        { account: "1930", credit: "125" },
      ],
    },
    1,
  );
  const bytes = exportSIE(store),
    output = asText(bytes),
    rows = output.split("\r\n");
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(rows[0], "#FLAGGA 0");
  for (const expected of [
    '#PROGRAM "Ekonomisystem" "0.1.0"',
    "#FORMAT PC8",
    "#SIETYP 4",
    "#ORGNR 559999-9999",
    "#RAR 0 20260101 20261231",
    "#VALUTA SEK",
    "#IB 0 1930 0.00",
    "#IB 0 2081 0.00",
    "#UB 0 1930 24875.00",
    "#UB 0 1510 1250.00",
    "#UB 0 2081 -25000.00",
    "#UB 0 2611 -250.00",
    "#UB 0 2641 25.00",
    "#RES 0 3041 -1000.00",
    "#RES 0 5420 100.00",
    "#TRANS 1930 {} 25000.00",
    "#TRANS 2081 {} -25000.00",
  ])
    assert.ok(rows.includes(expected), expected);
  assert.match(output, /#VER "V" 2 20260201 "Faktura \\"ett\\"" \d{8} "1"/u);
  assert.deepEqual(
    rows
      .filter((r) => r.startsWith("#VER "))
      .map((r) => Number(r.split(" ")[2])),
    [1, 2, 3],
  );
  assert.ok(
    rows.filter((r) => r.startsWith("#IB ")).every((r) => r.endsWith(" 0.00")),
  );
  assert.ok(!rows.some((r) => /^#(?:IB|UB) 0 (?:3041|5420) /u.test(r)));
  assert.ok(!rows.some((r) => /^#RES 0 (?:1930|2081) /u.test(r)));
  assert.ok(!output.includes("#RAR -1"));
  assert.equal(rows.filter((r) => r === "{").length, 3);
  assert.equal(rows.filter((r) => r === "}").length, 3);
  assert.equal(rows.at(-1), "");
  // Sum balance + result accounts, using integer cents independently of exporter.
  const sum = rows
    .filter((r) => /^#(?:UB|RES) /u.test(r))
    .reduce((total, r) => {
      const amount = r.split(" ")[3],
        negative = amount.startsWith("-");
      const [whole, fraction] = amount.replace("-", "").split(".");
      return (
        total +
        (negative ? -1n : 1n) * (BigInt(whole) * 100n + BigInt(fraction))
      );
    }, 0n);
  assert.equal(sum, 0n);
});

test("Swedish letters are CP437 bytes, and built-in typographic account dashes are normalized", (t) => {
  const bytes = exportSIE(fixture(t));
  assert.ok(
    bytes.includes(Buffer.from([0x8f, 0x8e, 0x99, 0x20, 0x86, 0x84, 0x94])),
  );
  assert.ok(!bytes.includes(Buffer.from("ÅÄÖ", "utf8")));
  assert.match(
    asText(bytes),
    /#KONTO 3044 "F.rs.ljning momsfri - kr.ver bed.mning"/u,
  );
});

test("reversals are exported as separate balanced vouchers without deleting originals", (t) => {
  const store = fixture(t);
  const original = store.post(
    {
      date: "2026-03-01",
      text: "Fel",
      lines: [
        { account: "6110", debit: "12.34" },
        { account: "1930", credit: "12.34" },
      ],
    },
    1,
  );
  store.reverse(original.id, { date: "2026-03-02", reason: "Fel konto" }, 1);
  const output = asText(exportSIE(store));
  assert.equal((output.match(/^#VER /gmu) || []).length, 2);
  assert.match(output, /#RES 0 6110 0.00/u);
  assert.match(output, /#TRANS 6110 \{\} 12.34/u);
  assert.match(output, /#TRANS 6110 \{\} -12.34/u);
});

test("a fiscal year spanning calendar years retains its actual boundaries", (t) => {
  const store = fixture(t);
  store.run(
    "UPDATE company SET fiscal_start=?,fiscal_end=?",
    "2025-07-01",
    "2026-06-30",
  );
  store.post(
    {
      date: "2025-07-01",
      text: "Start",
      lines: [
        { account: "1930", debit: "0.01" },
        { account: "2081", credit: "0.01" },
      ],
    },
    1,
  );
  assert.match(asText(exportSIE(store)), /#RAR 0 20250701 20260630/u);
});

test("unsupported characters and control characters fail explicitly without replacement bytes", (t) => {
  const store = fixture(t);
  store.run("UPDATE company SET name=?", "Bolag 🐈");
  assert.throws(() => exportSIE(store), /CP437/u);
  store.run("UPDATE company SET name=?", "Bolag\n#VER");
  assert.throws(() => exportSIE(store), /kontrolltecken/u);
  store.run("UPDATE company SET name=?", "Bolag\\");
  assert.throws(() => exportSIE(store), /snedstreck/u);
});

test("export refuses incomplete or unbalanced persisted vouchers", (t) => {
  const store = fixture(t);
  store.run(
    "INSERT INTO vouchers(number,date,text,actor,created_at) VALUES(1,?,?,1,?)",
    "2026-01-01",
    "Broken",
    "2026-01-01T00:00:00Z",
  );
  assert.throws(() => exportSIE(store), /balanserar inte/u);
  store.run(
    "INSERT INTO entries(voucher_id,account,debit,credit) VALUES(1,?,100,0)",
    "1930",
  );
  assert.throws(() => exportSIE(store), /balanserar inte/u);
});

test("export does not silently omit persisted entries outside the configured fiscal year", (t) => {
  const store = fixture(t);
  store.run(
    "INSERT INTO vouchers(number,date,text,actor,created_at) VALUES(1,?,?,1,?)",
    "2025-12-31",
    "Outside",
    "2026-01-01T00:00:00Z",
  );
  assert.throws(() => exportSIE(store), /utanför/u);
});

test("registration day uses Stockholm even when UTC instant is previous day", (t) => {
  const store = fixture(t);
  store.run(
    "INSERT INTO vouchers(number,date,text,actor,created_at) VALUES(1,?,?,1,?)",
    "2026-01-01",
    "Late",
    "2025-12-31T23:30:00Z",
  );
  store.run(
    "INSERT INTO entries(voucher_id,account,debit,credit) VALUES(1,?,100,0)",
    "1930",
  );
  store.run(
    "INSERT INTO entries(voucher_id,account,debit,credit) VALUES(1,?,0,100)",
    "2081",
  );
  assert.match(
    asText(exportSIE(store)),
    /#VER "V" 1 20260101 "Late" 20260101 "1"/u,
  );
});

test("account totals above Number safe integer retain every cent", (t) => {
  const store = fixture(t);
  for (const [number, amount] of [
    [1, Number.MAX_SAFE_INTEGER],
    [2, 2],
  ]) {
    store.run(
      "INSERT INTO vouchers(id,number,date,text,actor,created_at) VALUES(?,?,?, ?,1,?)",
      number,
      number,
      "2026-01-01",
      "Large",
      "2026-01-01T12:00:00Z",
    );
    store.run(
      "INSERT INTO entries(voucher_id,account,debit,credit) VALUES(?,?,?,0)",
      number,
      "1930",
      amount,
    );
    store.run(
      "INSERT INTO entries(voucher_id,account,debit,credit) VALUES(?,?,0,?)",
      number,
      "2081",
      amount,
    );
  }
  const output = asText(exportSIE(store));
  assert.match(output, /#UB 0 1930 90071992547409.93/u);
  assert.match(output, /#UB 0 2081 -90071992547409.93/u);
});
