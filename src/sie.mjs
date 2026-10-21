import { DomainError, today } from "./domain.mjs";
import { validDate } from "./imports.mjs";

// SIE 4C (2025-08-06), chapters 5, 6 and 11. Output is 4E, not 4I.
const HIGH_CP437 =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";
const CP437 = new Map(Array.from(HIGH_CP437, (c, i) => [c, i + 128]));
const TYPES = {
  asset: "T",
  liability: "S",
  equity: "S",
  income: "I",
  expense: "K",
};
const reject = (message) => {
  throw new DomainError(`SIE-export: ${message}`);
};

function encode(value) {
  return Buffer.from(
    Array.from(value, (c) => {
      const code = c.codePointAt(0);
      if (code < 128) return code;
      const byte = CP437.get(c);
      if (byte === undefined)
        reject(
          `tecknet ${JSON.stringify(c)} kan inte representeras i CP437. Texten kräver separat manuell exporthantering.`,
        );
      return byte;
    }),
  );
}

function quoted(value) {
  if (typeof value !== "string") reject("en textuppgift saknas.");
  if (/[\x00-\x1f\x7f]/u.test(value))
    reject("text innehåller otillåtna kontrolltecken.");
  // CP437 lacks typographic punctuation. Only these explicit substitutions occur.
  const normalized = value
    .normalize("NFC")
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\u00a0/gu, " ");
  // The standard specifies escaping quotes, not general JSON escaping.
  // A literal backslash directly before a quote or at field end is ambiguous
  // across SIE parsers; fail rather than change the user's text silently.
  if (/\\(?:"|$)/u.test(normalized))
    reject(
      "text med omvänt snedstreck före citationstecken eller sist i fältet kan inte exporteras entydigt.",
    );
  return `"${normalized.replaceAll('"', '\\"')}"`;
}

function date(value) {
  validDate(value);
  return value.replaceAll("-", "");
}

function money(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function cents(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    reject(
      "ett belopp är negativt eller större än det säkra heltalsintervallet.",
    );
  return BigInt(value);
}

/** Export the single configured fiscal year. Opening balances are zero:
 * migrated capital/balances must be posted as balanced vouchers in this version.
 * Previous years, dimensions, budgets and quantities are not stored by the app.
 * No external SIE certification/validator result is implied by this exporter.
 */
export function exportSIE(store) {
  const snapshot = store.tx(() => ({
    company: store.get("SELECT * FROM company WHERE id=1"),
    accounts: store.all("SELECT * FROM accounts ORDER BY number"),
    vouchers: store.all("SELECT * FROM vouchers ORDER BY number"),
    entries: store.all("SELECT * FROM entries ORDER BY id"),
  }));
  const { company, accounts, vouchers, entries } = snapshot;
  if (!company) reject("företaget är inte konfigurerat.");
  const start = date(company.fiscal_start),
    end = date(company.fiscal_end);
  if (start >= end) reject("räkenskapsåret är ogiltigt.");
  const org = String(company.org_number).replace("-", "");
  if (!/^\d{10}$/u.test(org)) reject("organisationsnumret är ogiltigt.");

  const accountMap = new Map();
  for (const account of accounts) {
    if (
      !/^\d{4}$/u.test(account.number) ||
      !TYPES[account.kind] ||
      accountMap.has(account.number)
    )
      reject("kontoplanen har ogiltigt konto eller kontotyp.");
    accountMap.set(account.number, { ...account, balance: 0n });
  }
  const voucherMap = new Map();
  let lastNumber = 0;
  for (const voucher of vouchers) {
    if (!Number.isSafeInteger(voucher.number) || voucher.number <= lastNumber)
      reject("verifikationsnummer är inte unika och stigande.");
    lastNumber = voucher.number;
    date(voucher.date);
    if (
      voucher.date < company.fiscal_start ||
      voucher.date > company.fiscal_end
    )
      reject("en verifikation ligger utanför det exporterade räkenskapsåret.");
    voucherMap.set(voucher.id, { ...voucher, lines: [], balance: 0n });
  }
  for (const entry of entries) {
    const account = accountMap.get(entry.account),
      voucher = voucherMap.get(entry.voucher_id);
    if (!account || !voucher)
      reject("en bokföringsrad saknar konto eller verifikation.");
    const debit = cents(entry.debit),
      credit = cents(entry.credit);
    if (debit > 0n === credit > 0n)
      reject(
        "en bokföringsrad måste ha antingen positiv debet eller positiv kredit.",
      );
    const amount = debit - credit;
    voucher.lines.push({ account: entry.account, amount });
    voucher.balance += amount;
    account.balance += amount;
  }

  const rows = [
    "#FLAGGA 0",
    '#PROGRAM "Ekonomisystem" "0.1.0"',
    "#FORMAT PC8",
    `#GEN ${date(today())} "Ekonomisystem"`,
    "#SIETYP 4",
    `#FNAMN ${quoted(company.name)}`,
    `#ORGNR ${org.slice(0, 6)}-${org.slice(6)}`,
    "#FTYP AB",
    `#RAR 0 ${start} ${end}`,
    "#KPTYP EUBAS97",
    "#VALUTA SEK",
  ];
  for (const account of accountMap.values()) {
    rows.push(
      `#KONTO ${account.number} ${quoted(account.name)}`,
      `#KTYP ${account.number} ${TYPES[account.kind]}`,
    );
  }
  for (const account of accountMap.values()) {
    if (["asset", "liability", "equity"].includes(account.kind)) {
      rows.push(
        `#IB 0 ${account.number} 0.00`,
        `#UB 0 ${account.number} ${money(account.balance)}`,
      );
    } else rows.push(`#RES 0 ${account.number} ${money(account.balance)}`);
  }
  for (const voucher of voucherMap.values()) {
    if (voucher.balance !== 0n || voucher.lines.length < 2)
      reject(
        `verifikation ${voucher.number} balanserar inte eller saknar rader.`,
      );
    const registered = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Stockholm",
    }).format(new Date(voucher.created_at));
    rows.push(
      `#VER "V" ${voucher.number} ${date(voucher.date)} ${quoted(voucher.text)} ${date(registered)} ${quoted(String(voucher.actor))}`,
      "{",
    );
    for (const line of voucher.lines)
      rows.push(`#TRANS ${line.account} {} ${money(line.amount)}`);
    rows.push("}");
  }
  return encode(`${rows.join("\r\n")}\r\n`);
}
