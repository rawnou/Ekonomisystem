import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  decimal,
  invoiceAmounts,
  amountText,
  convertCurrency,
} from "./money.mjs";
import { validDate, normalizeCSV } from "./imports.mjs";
import { hashPassword } from "./security.mjs";

export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
const fail = (s, status) => {
  throw new DomainError(s, status);
};
const text = (s, max = 500) => {
  if (typeof s !== "string" || !s.trim() || s.length > max)
    fail("Obligatorisk text saknas eller är för lång.");
  return s.trim();
};
const now = () => new Date().toISOString();
function bankFingerprint(data, source) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source,
        data.date,
        data.amount,
        data.currency || "SEK",
        String(data.reference || "").trim() || data.description.trim(),
        source === "bank" ? "" : data.period || "",
      ]),
    )
    .digest("hex");
}
export const today = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(
    new Date(),
  );
const ACCOUNTS = [
  ["1510", "Kundfordringar", "asset"],
  ["1930", "Företagskonto", "asset"],
  ["2081", "Aktiekapital", "equity"],
  ["2091", "Balanserat resultat", "equity"],
  ["2440", "Leverantörsskulder", "liability"],
  ["2611", "Utgående moms 25 %", "liability"],
  ["2621", "Utgående moms 12 %", "liability"],
  ["2631", "Utgående moms 6 %", "liability"],
  ["2641", "Ingående moms", "asset"],
  ["2650", "Redovisningskonto moms", "liability"],
  ["3041", "Försäljning tjänster Sverige", "income"],
  ["3044", "Försäljning momsfri – kräver bedömning", "income"],
  ["3740", "Öresutjämning", "income"],
  ["3960", "Valutakursvinster", "income"],
  ["4535", "Inköp tjänster från EU – manuell moms", "expense"],
  ["5410", "Förbrukningsinventarier", "expense"],
  ["5420", "Programvaror", "expense"],
  ["6110", "Kontorsmateriel", "expense"],
  ["6570", "Bankkostnader", "expense"],
  ["7960", "Valutakursförluster", "expense"],
];
export class Store {
  constructor(path = "data/ekonomi.sqlite") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS company(id INTEGER PRIMARY KEY CHECK(id=1),name TEXT NOT NULL,org_number TEXT NOT NULL,vat_number TEXT NOT NULL,f_tax INTEGER NOT NULL,address TEXT NOT NULL,bank TEXT NOT NULL,fiscal_start TEXT NOT NULL,fiscal_end TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','accountant','viewer')),password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),csrf TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(number TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,org_number TEXT NOT NULL,email TEXT NOT NULL,address TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY,number INTEGER UNIQUE,customer_id INTEGER NOT NULL REFERENCES customers(id),date TEXT NOT NULL,due_date TEXT NOT NULL,description TEXT NOT NULL,quantity INTEGER NOT NULL,unit_price INTEGER NOT NULL,vat_rate INTEGER NOT NULL,net INTEGER NOT NULL,vat INTEGER NOT NULL,total INTEGER NOT NULL,paid INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','issued','partial','paid','credited','credit')),version INTEGER NOT NULL DEFAULT 1,original_id INTEGER UNIQUE REFERENCES invoices(id),snapshot TEXT);
      CREATE TABLE IF NOT EXISTS documents(id INTEGER PRIMARY KEY,name TEXT NOT NULL,type TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,content BLOB NOT NULL,created_at TEXT NOT NULL,previous_id INTEGER REFERENCES documents(id));
      CREATE TABLE IF NOT EXISTS vouchers(id INTEGER PRIMARY KEY,number INTEGER NOT NULL UNIQUE,date TEXT NOT NULL,text TEXT NOT NULL,actor INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,reversal_of INTEGER UNIQUE REFERENCES vouchers(id),document_id INTEGER REFERENCES documents(id),invoice_id INTEGER REFERENCES invoices(id));
      CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY,voucher_id INTEGER NOT NULL REFERENCES vouchers(id),account TEXT NOT NULL REFERENCES accounts(number),debit INTEGER NOT NULL CHECK(debit>=0),credit INTEGER NOT NULL CHECK(credit>=0),CHECK((debit=0 AND credit>0) OR (credit=0 AND debit>0)));
      CREATE TABLE IF NOT EXISTS imports(id INTEGER PRIMARY KEY,source TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL,rows INTEGER NOT NULL,UNIQUE(source,hash));
      CREATE TABLE IF NOT EXISTS bank(id INTEGER PRIMARY KEY,date TEXT NOT NULL,description TEXT NOT NULL,amount INTEGER NOT NULL,currency TEXT NOT NULL,reference TEXT NOT NULL,source TEXT NOT NULL,period TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL UNIQUE,import_id INTEGER REFERENCES imports(id),voucher_id INTEGER REFERENCES vouchers(id),invoice_id INTEGER REFERENCES invoices(id),original_amount INTEGER,exchange_rate TEXT);
      CREATE TABLE IF NOT EXISTS periods(through TEXT PRIMARY KEY,actor INTEGER NOT NULL REFERENCES users(id),created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor INTEGER REFERENCES users(id),action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS entries_account ON entries(account,voucher_id);
      CREATE INDEX IF NOT EXISTS vouchers_date ON vouchers(date);
      CREATE TRIGGER IF NOT EXISTS vouchers_no_update BEFORE UPDATE ON vouchers BEGIN SELECT RAISE(ABORT,'Verifikationer är oföränderliga'); END;
      CREATE TRIGGER IF NOT EXISTS vouchers_no_delete BEFORE DELETE ON vouchers BEGIN SELECT RAISE(ABORT,'Verifikationer får inte raderas'); END;
      CREATE TRIGGER IF NOT EXISTS entries_no_update BEFORE UPDATE ON entries BEGIN SELECT RAISE(ABORT,'Bokförda rader är oföränderliga'); END;
      CREATE TRIGGER IF NOT EXISTS entries_no_delete BEFORE DELETE ON entries BEGIN SELECT RAISE(ABORT,'Bokförda rader får inte raderas'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Historik är oföränderlig'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Historik får inte raderas'); END;
      CREATE TRIGGER IF NOT EXISTS documents_no_update BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT,'Underlag är oföränderliga'); END;
      CREATE TRIGGER IF NOT EXISTS documents_no_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(ABORT,'Underlag får inte raderas'); END;
      CREATE TRIGGER IF NOT EXISTS periods_no_update BEFORE UPDATE ON periods BEGIN SELECT RAISE(ABORT,'Periodlås får inte ändras'); END;
      CREATE TRIGGER IF NOT EXISTS periods_no_delete BEFORE DELETE ON periods BEGIN SELECT RAISE(ABORT,'Periodlås får inte raderas'); END;
      CREATE TRIGGER IF NOT EXISTS issued_invoice_content BEFORE UPDATE ON invoices WHEN OLD.status <> 'draft' AND (NEW.number IS NOT OLD.number OR NEW.customer_id IS NOT OLD.customer_id OR NEW.date IS NOT OLD.date OR NEW.due_date IS NOT OLD.due_date OR NEW.description IS NOT OLD.description OR NEW.quantity IS NOT OLD.quantity OR NEW.unit_price IS NOT OLD.unit_price OR NEW.vat_rate IS NOT OLD.vat_rate OR NEW.net IS NOT OLD.net OR NEW.vat IS NOT OLD.vat OR NEW.total IS NOT OLD.total OR NEW.snapshot IS NOT OLD.snapshot OR NEW.original_id IS NOT OLD.original_id) BEGIN SELECT RAISE(ABORT,'Fastställd faktura är oföränderlig'); END;
      CREATE TRIGGER IF NOT EXISTS issued_invoice_delete BEFORE DELETE ON invoices WHEN OLD.status <> 'draft' BEGIN SELECT RAISE(ABORT,'Fastställd faktura får inte raderas'); END;
    `);
    this.tx(() => {
      for (const a of ACCOUNTS)
        this.run("INSERT OR IGNORE INTO accounts VALUES(?,?,?)", ...a);
    });
  }
  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }
  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }
  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
  close() {
    this.db.close();
  }
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  authorize(actor, admin = false) {
    const user = this.get("SELECT id,name,role FROM users WHERE id=?", actor);
    if (
      !user ||
      (admin
        ? user.role !== "admin"
        : !["admin", "accountant"].includes(user.role))
    )
      fail("Du saknar behörighet.", 403);
    return user;
  }
  audit(actor, action, detail) {
    this.run(
      "INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)",
      actor,
      action,
      JSON.stringify(detail),
      now(),
    );
  }
  next(name) {
    this.run(
      "INSERT INTO counters VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1",
      name,
    );
    return this.get("SELECT value FROM counters WHERE name=?", name).value;
  }
  seed(users) {
    if (this.get("SELECT id FROM company"))
      fail("Databasen är redan initierad.");
    this.tx(() => {
      this.run(
        "INSERT INTO company(id,name,org_number,vat_number,f_tax,address,bank,fiscal_start,fiscal_end,version) VALUES(1,?,?,?,?,?,?,?,?,1)",
        "Exempelbolaget AB (testdata)",
        "559999-9999",
        "SE559999999901",
        1,
        "Testgatan 1, 111 11 Stockholm",
        "TEST – ange bankuppgifter före användning",
        "2026-01-01",
        "2026-12-31",
      );
      for (const u of users)
        this.run(
          "INSERT INTO users(email,name,role,password) VALUES(?,?,?,?)",
          u.email.toLowerCase(),
          u.name,
          u.role || "admin",
          hashPassword(u.password),
        );
      this.audit(null, "setup", { synthetic: true });
    });
  }
  checkPeriod(date) {
    validDate(date);
    const c = this.get("SELECT * FROM company WHERE id=1");
    if (!c || date < c.fiscal_start || date > c.fiscal_end)
      fail("Datum ligger utanför räkenskapsåret.");
    if (this.get("SELECT through FROM periods WHERE through>=? LIMIT 1", date))
      fail("Bokföringsperioden är låst.", 409);
  }
  company(data, actor) {
    this.authorize(actor, true);
    return this.tx(() => {
      const c = this.get("SELECT * FROM company WHERE id=1");
      if (data.version !== c.version)
        fail("Inställningarna har ändrats. Läs om sidan.", 409);
      const start = validDate(data.fiscalStart),
        end = validDate(data.fiscalEnd);
      if (start >= end) fail("Räkenskapsårets slut måste vara efter start.");
      if (
        (start !== c.fiscal_start || end !== c.fiscal_end) &&
        this.get("SELECT id FROM vouchers LIMIT 1")
      )
        fail("Räkenskapsår med bokföring kan inte ändras.");
      if (
        !/^\d{6}-?\d{4}$/.test(data.orgNumber) ||
        !/^SE\d{12}$/.test(data.vatNumber)
      )
        fail("Kontrollera organisationsnummer och momsnummer.");
      this.run(
        "UPDATE company SET name=?,org_number=?,vat_number=?,f_tax=?,address=?,bank=?,fiscal_start=?,fiscal_end=?,version=version+1 WHERE id=1",
        text(data.name),
        data.orgNumber,
        data.vatNumber,
        data.fTax ? 1 : 0,
        text(data.address),
        text(data.bank),
        start,
        end,
      );
      this.audit(actor, "company.update", { version: c.version + 1 });
    });
  }
  customer(data, actor) {
    this.authorize(actor);
    return this.tx(() => {
      const id = Number(
        this.run(
          "INSERT INTO customers(name,org_number,email,address) VALUES(?,?,?,?)",
          text(data.name),
          text(data.orgNumber),
          text(data.email),
          text(data.address),
        ).lastInsertRowid,
      );
      this.audit(actor, "customer.create", { id });
      return { id };
    });
  }
  invoice(data, actor) {
    this.authorize(actor);
    this.checkPeriod(data.date);
    validDate(data.dueDate);
    if (
      data.dueDate < data.date ||
      !this.get("SELECT id FROM customers WHERE id=?", Number(data.customerId))
    )
      fail("Kontrollera kund och förfallodatum.");
    const a = invoiceAmounts(data.quantity, data.unitPrice, data.vatRate);
    // Första fakturaflödet avser svenska tjänster med 25 % moms. Övriga momskategorier kräver eget verifierat flöde.
    if (Number(data.vatRate) !== 25 || a.total <= 0)
      fail(
        "Första fakturaflödet stöder svenska tjänster med 25 % moms och positivt belopp.",
      );
    if (a.total > 1_000_000_000_000)
      fail(
        "Fakturans totalbelopp överstiger den lokala versionens beloppsgräns.",
      );
    return this.tx(() => {
      const id = Number(
        this.run(
          "INSERT INTO invoices(customer_id,date,due_date,description,quantity,unit_price,vat_rate,net,vat,total) VALUES(?,?,?,?,?,?,?,?,?,?)",
          Number(data.customerId),
          data.date,
          data.dueDate,
          text(data.description),
          a.quantity,
          a.unit,
          Number(data.vatRate),
          a.net,
          a.vat,
          a.total,
        ).lastInsertRowid,
      );
      this.audit(actor, "invoice.draft", { id });
      return { id };
    });
  }
  post(data, actor) {
    this.authorize(actor);
    if (data.reversalOf !== undefined || data.invoiceId !== undefined)
      fail(
        "Interna bokföringsreferenser får bara skapas genom respektive rättelse- eller fakturaflöde.",
      );
    return this.tx(() =>
      this._post(
        {
          date: data.date,
          text: data.text,
          lines: data.lines,
          documentId: data.documentId,
        },
        actor,
      ),
    );
  }
  _post(data, actor) {
    this.checkPeriod(data.date);
    if (
      !Array.isArray(data.lines) ||
      data.lines.length < 2 ||
      data.lines.length > 100
    )
      fail("En verifikation behöver 2–100 rader.");
    const lines = data.lines.map((l) => ({
      account: String(l.account),
      debit: decimal(l.debit || "0"),
      credit: decimal(l.credit || "0"),
    }));
    let balance = 0n;
    for (const l of lines) {
      if (
        l.debit < 0 ||
        l.credit < 0 ||
        l.debit > 0 === l.credit > 0 ||
        !this.get("SELECT number FROM accounts WHERE number=?", l.account)
      )
        fail(
          "Varje rad ska ha ett giltigt konto och positiv debet eller kredit.",
        );
      balance += BigInt(l.debit) - BigInt(l.credit);
    }
    if (balance !== 0n)
      fail("Verifikationen balanserar inte. Debet måste vara lika med kredit.");
    const accumulated = this.db.prepare(
      "SELECT COALESCE(SUM(debit),0) n FROM entries",
    );
    accumulated.setReadBigInts(true);
    const gross = lines.reduce((sum, l) => sum + BigInt(l.debit), 0n);
    if (accumulated.get().n + gross > 100_000_000_000_000n)
      fail(
        "Den lokala versionens beloppsgräns har nåtts. Ingen bokning har gjorts.",
      );
    if (
      data.documentId &&
      !this.get("SELECT id FROM documents WHERE id=?", Number(data.documentId))
    )
      fail("Underlaget saknas.");
    const number = this.next("voucher");
    const id = Number(
      this.run(
        "INSERT INTO vouchers(number,date,text,actor,created_at,reversal_of,document_id,invoice_id) VALUES(?,?,?,?,?,?,?,?)",
        number,
        data.date,
        text(data.text),
        actor,
        now(),
        data.reversalOf || null,
        data.documentId ? Number(data.documentId) : null,
        data.invoiceId || null,
      ).lastInsertRowid,
    );
    for (const l of lines)
      this.run(
        "INSERT INTO entries(voucher_id,account,debit,credit) VALUES(?,?,?,?)",
        id,
        l.account,
        l.debit,
        l.credit,
      );
    this.audit(actor, "voucher.post", {
      id,
      number,
      documentId: data.documentId || null,
    });
    return { id, number };
  }
  issue(id, version, actor) {
    this.authorize(actor);
    return this.tx(() => {
      const i = this.get("SELECT * FROM invoices WHERE id=?", id);
      if (!i || i.status !== "draft" || i.version !== version)
        fail("Fakturan har ändrats eller är redan fastställd.", 409);
      const company = this.get("SELECT * FROM company WHERE id=1"),
        customer = this.get(
          "SELECT * FROM customers WHERE id=?",
          i.customer_id,
        );
      const number = this.next("invoice");
      this._post(
        {
          date: i.date,
          text: `Kundfaktura ${number}`,
          invoiceId: id,
          lines: [
            { account: "1510", debit: amountText(i.total) },
            { account: "3041", credit: amountText(i.net) },
            ...(i.vat ? [{ account: "2611", credit: amountText(i.vat) }] : []),
          ],
        },
        actor,
      );
      this.run(
        "UPDATE invoices SET number=?,snapshot=?,status='issued',version=version+1 WHERE id=?",
        number,
        JSON.stringify({ company, customer }),
        id,
      );
      this.audit(actor, "invoice.issue", { id, number });
      return { id, number };
    });
  }
  payment(id, data, actor) {
    this.authorize(actor);
    const amount = decimal(data.amount);
    return this.tx(() => {
      const i = this.get("SELECT * FROM invoices WHERE id=?", id);
      if (
        !i ||
        !["issued", "partial"].includes(i.status) ||
        amount <= 0 ||
        amount > i.total - i.paid
      )
        fail(
          "Betalningen måste avse en obetald faktura och får inte överstiga restbeloppet.",
        );
      if (data.date < i.date) fail("Betalningen får inte föregå fakturadatum.");
      this._post(
        {
          date: data.date,
          text: `Betalning faktura ${i.number}`,
          invoiceId: id,
          lines: [
            { account: "1930", debit: data.amount },
            { account: "1510", credit: data.amount },
          ],
        },
        actor,
      );
      this.run(
        "UPDATE invoices SET paid=paid+?,status=?,version=version+1 WHERE id=?",
        amount,
        i.paid + amount === i.total ? "paid" : "partial",
        id,
      );
      this.audit(actor, "invoice.payment", { id, amount });
      return { id };
    });
  }
  credit(id, data, actor) {
    this.authorize(actor);
    return this.tx(() => {
      const i = this.get("SELECT * FROM invoices WHERE id=?", id);
      if (
        !i ||
        i.status !== "issued" ||
        i.paid !== 0 ||
        this.get("SELECT id FROM invoices WHERE original_id=?", id)
      )
        fail("Full kreditering stöds för helt obetalda fakturor.");
      this.checkPeriod(data.date);
      if (data.date < i.date)
        fail("Kreditdatum får inte föregå originalfakturan.");
      const number = this.next("invoice");
      const creditId = Number(
        this.run(
          "INSERT INTO invoices(number,customer_id,date,due_date,description,quantity,unit_price,vat_rate,net,vat,total,status,original_id,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,'credit',?,?)",
          number,
          i.customer_id,
          data.date,
          data.date,
          `Kredit av faktura ${i.number}: ${i.description}`,
          i.quantity,
          i.unit_price,
          i.vat_rate,
          -i.net,
          -i.vat,
          -i.total,
          id,
          i.snapshot,
        ).lastInsertRowid,
      );
      this._post(
        {
          date: data.date,
          text: `Kreditfaktura ${number}, original ${i.number}`,
          invoiceId: creditId,
          lines: [
            { account: "1510", credit: amountText(i.total) },
            { account: "3041", debit: amountText(i.net) },
            ...(i.vat ? [{ account: "2611", debit: amountText(i.vat) }] : []),
          ],
        },
        actor,
      );
      this.run(
        "UPDATE invoices SET status='credited',version=version+1 WHERE id=?",
        id,
      );
      this.audit(actor, "invoice.credit", { id, creditId, number });
      return { id: creditId, number };
    });
  }
  reverse(id, data, actor) {
    this.authorize(actor);
    return this.tx(() => {
      const v = this.get("SELECT * FROM vouchers WHERE id=?", id);
      if (
        !v ||
        v.invoice_id ||
        this.get("SELECT id FROM vouchers WHERE reversal_of=?", id)
      )
        fail(
          "Fakturarättelser ska göras via fakturaflödet. Övriga verifikationer får motbokas en gång.",
        );
      if (data.date < v.date) fail("Rättelsen får inte föregå originalposten.");
      const reason = text(data.reason);
      const result = this._post(
        {
          date: data.date,
          text: `Rättelse V${v.number}: ${reason}`,
          reversalOf: id,
          documentId: v.document_id,
          lines: this.all("SELECT * FROM entries WHERE voucher_id=?", id).map(
            (l) => ({
              account: l.account,
              debit: amountText(l.credit),
              credit: amountText(l.debit),
            }),
          ),
        },
        actor,
      );
      this.audit(actor, "voucher.reverse", {
        original: id,
        correction: result.id,
        reason,
      });
      return result;
    });
  }
  lock(through, actor) {
    this.authorize(actor, true);
    validDate(through);
    return this.tx(() => {
      this.checkPeriod(through);
      if (through > today()) fail("Framtida perioder kan inte låsas.");
      this.run("INSERT INTO periods VALUES(?,?,?)", through, actor, now());
      this.audit(actor, "period.lock", { through });
    });
  }
  _bank(data, actor, source = "bank", importId = null) {
    validDate(data.date);
    const description = text(data.description),
      reference = String(data.reference || "").trim();
    const currency = String(data.currency || "SEK").toUpperCase();
    if (
      !/^[A-Z]{3}$/.test(currency) ||
      !Number.isSafeInteger(data.amount) ||
      data.amount === 0
    )
      fail("Kontrollera valuta och transaktionsbelopp.");
    // Source deliberately excluded: the same bank row must not duplicate via manual entry and CSV.
    const fingerprint = bankFingerprint(
      { ...data, currency, reference, description },
      source,
    );
    const result = this.run(
      "INSERT OR IGNORE INTO bank(date,description,amount,currency,reference,source,period,fingerprint,import_id) VALUES(?,?,?,?,?,?,?,?,?)",
      data.date,
      description,
      data.amount,
      currency,
      reference,
      source,
      data.period || "",
      fingerprint,
      importId,
    );
    if (result.changes)
      this.audit(actor, "transaction.register", {
        id: Number(result.lastInsertRowid),
        source,
      });
    return result.changes > 0;
  }
  bank(data, actor) {
    this.authorize(actor);
    return this.tx(() => ({
      inserted: this._bank({ ...data, amount: decimal(data.amount) }, actor),
    }));
  }
  import(data, actor) {
    this.authorize(actor);
    if (!["bank", "kdp", "adtraction"].includes(data.source))
      fail("Okänd importkälla.");
    const rows = normalizeCSV(data.csv, data.mapping);
    const seen = new Set();
    for (const row of rows) {
      const key = bankFingerprint(row, data.source);
      if (seen.has(key))
        fail(
          "Importen innehåller flera identiska ekonomiska rader. Inga rader har importerats. Ange unika transaktionsreferenser för att skilja verkliga händelser från dubbletter.",
        );
      seen.add(key);
    }
    const hash = createHash("sha256").update(data.csv).digest("hex");
    return this.tx(() => {
      if (
        this.get(
          "SELECT id FROM imports WHERE source=? AND hash=?",
          data.source,
          hash,
        )
      )
        return { inserted: 0, duplicates: rows.length };
      const id = Number(
        this.run(
          "INSERT INTO imports(source,hash,created_at,rows) VALUES(?,?,?,?)",
          data.source,
          hash,
          now(),
          rows.length,
        ).lastInsertRowid,
      );
      let inserted = 0;
      for (const r of rows)
        if (this._bank(r, actor, data.source, id)) inserted++;
      this.audit(actor, "import.complete", {
        id,
        source: data.source,
        inserted,
        duplicates: rows.length - inserted,
      });
      return { id, inserted, duplicates: rows.length - inserted };
    });
  }
  bookBank(id, data, actor) {
    this.authorize(actor);
    return this.tx(() => {
      const b = this.get("SELECT * FROM bank WHERE id=?", id);
      if (!b || b.voucher_id)
        fail("Transaktionen saknas eller är redan bokförd.", 409);
      if (b.source !== "bank")
        fail(
          "KDP/Adtraction kräver manuell avtals- och momsgranskning före bokföring.",
        );
      if (String(data.account) === "1510")
        fail(
          "Matcha kundbetalningar genom fakturans betalningsflöde. Direkt bankklassificering mot 1510 är spärrad för att undvika dubbla betalningar.",
        );
      const converted =
        b.currency === "SEK"
          ? b.amount
          : convertCurrency(amountText(b.amount), data.exchangeRate);
      const rate = b.currency === "SEK" ? "1.000000" : data.exchangeRate;
      if (
        !data.reviewed ||
        !this.get(
          "SELECT number FROM accounts WHERE number=? AND number<>'1930'",
          String(data.account),
        )
      )
        fail(
          "Välj motkonto och bekräfta granskning. Moms måste bokföras separat vid behov.",
        );
      const abs = amountText(Math.abs(converted));
      const p = this._post(
        {
          date: b.date,
          text: `Bank: ${b.description}`,
          lines:
            converted > 0
              ? [
                  { account: "1930", debit: abs },
                  { account: String(data.account), credit: abs },
                ]
              : [
                  { account: "1930", credit: abs },
                  { account: String(data.account), debit: abs },
                ],
        },
        actor,
      );
      this.run(
        "UPDATE bank SET voucher_id=?,original_amount=?,exchange_rate=? WHERE id=?",
        p.id,
        b.amount,
        rate,
        id,
      );
      this.audit(actor, "bank.book", {
        id,
        voucher: p.id,
        currency: b.currency,
        original: b.amount,
        exchangeRate: rate,
        sek: converted,
      });
      return p;
    });
  }
  document(data, actor) {
    this.authorize(actor);
    const name = text(data.name, 200);
    if (
      !["application/pdf", "image/png", "image/jpeg"].includes(data.type) ||
      typeof data.data !== "string" ||
      data.data.length > 7_000_000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(data.data)
    )
      fail("Tillåtna underlag: PDF, PNG eller JPEG, högst 5 MB.");
    const bytes = Buffer.from(data.data, "base64");
    const valid =
      data.type === "application/pdf"
        ? bytes.subarray(0, 5).toString() === "%PDF-"
        : data.type === "image/png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!valid || bytes.length > 5_000_000)
      fail("Filinnehållet motsvarar inte angiven filtyp eller är för stort.");
    const hash = createHash("sha256").update(bytes).digest("hex");
    return this.tx(() => {
      const existing = this.get("SELECT id FROM documents WHERE hash=?", hash);
      if (existing) return { id: existing.id, duplicate: true };
      if (
        data.previousId &&
        !this.get(
          "SELECT id FROM documents WHERE id=?",
          Number(data.previousId),
        )
      )
        fail("Föregående dokumentversion saknas.");
      const id = Number(
        this.run(
          "INSERT INTO documents(name,type,hash,content,created_at,previous_id) VALUES(?,?,?,?,?,?)",
          name,
          data.type,
          hash,
          bytes,
          now(),
          data.previousId ? Number(data.previousId) : null,
        ).lastInsertRowid,
      );
      this.audit(actor, "document.archive", {
        id,
        hash,
        previousId: data.previousId || null,
      });
      return { id };
    });
  }
  reports() {
    const trialBalance = this.all(
      "SELECT a.number,a.name,a.kind,COALESCE(SUM(e.debit-e.credit),0) balance,COALESCE(SUM(e.debit),0) debit,COALESCE(SUM(e.credit),0) credit FROM accounts a LEFT JOIN entries e ON e.account=a.number GROUP BY a.number ORDER BY a.number",
    );
    const sum = (kind) =>
      trialBalance
        .filter((a) => a.kind === kind)
        .reduce((s, a) => s + a.balance, 0);
    const income = 0 - sum("income"),
      expenses = sum("expense"),
      result = income - expenses;
    const monthly = this.all(
      "SELECT substr(v.date,1,7) month,SUM(CASE WHEN a.kind='income' THEN e.credit-e.debit ELSE 0 END) income,SUM(CASE WHEN a.kind='expense' THEN e.debit-e.credit ELSE 0 END) expenses FROM entries e JOIN vouchers v ON v.id=e.voucher_id JOIN accounts a ON a.number=e.account GROUP BY month ORDER BY month",
    );
    return {
      income,
      expenses,
      result,
      receivables: this.get(
        "SELECT COALESCE(SUM(total-paid),0) n FROM invoices WHERE status IN ('issued','partial')",
      ).n,
      cash: trialBalance.find((a) => a.number === "1930").balance,
      trialBalance,
      monthly,
      balance: {
        assets: sum("asset"),
        liabilities: -sum("liability"),
        equity: -sum("equity") + result,
      },
      profitLoss: trialBalance.filter((a) =>
        ["income", "expense"].includes(a.kind),
      ),
    };
  }
  state() {
    return {
      company: this.get("SELECT * FROM company WHERE id=1"),
      accounts: this.all("SELECT * FROM accounts ORDER BY number"),
      customers: this.all("SELECT * FROM customers ORDER BY name"),
      invoices: this.all(
        "SELECT i.*,c.name customer_name FROM invoices i JOIN customers c ON c.id=i.customer_id ORDER BY i.id DESC",
      ).map(({ snapshot, ...i }) => i),
      vouchers: this.all("SELECT * FROM vouchers ORDER BY number DESC").map(
        (v) => ({
          ...v,
          lines: this.all(
            "SELECT account,debit,credit FROM entries WHERE voucher_id=? ORDER BY id",
            v.id,
          ),
        }),
      ),
      bank: this.all("SELECT * FROM bank ORDER BY date DESC,id DESC"),
      imports: this.all("SELECT * FROM imports ORDER BY id DESC"),
      documents: this.all(
        "SELECT id,name,type,hash,created_at,previous_id FROM documents ORDER BY id DESC",
      ),
      periods: this.all("SELECT * FROM periods ORDER BY through DESC"),
      audit: this.all(
        "SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT 100",
      ),
      reports: this.reports(),
    };
  }
  exportData(actor) {
    this.authorize(actor, true);
    return {
      ...this.state(),
      invoices: this.all("SELECT * FROM invoices ORDER BY id"),
      documents: this.all("SELECT * FROM documents").map((d) => ({
        ...d,
        content: Buffer.from(d.content).toString("base64"),
      })),
      audit: this.all("SELECT * FROM audit"),
      exportedAt: now(),
    };
  }
}
