import { decimal } from "./money.mjs";
export function parseCSV(csv) {
  if (typeof csv !== "string" || !csv.trim() || csv.length > 2_000_000)
    throw new Error("CSV-filen är tom eller för stor (max 2 MB).");
  csv = csv.replace(/^\uFEFF/, "");
  const first = csv.split(/\r?\n/, 1)[0];
  const delimiter = first.includes(";")
    ? ";"
    : first.includes("\t")
      ? "\t"
      : ",";
  const rows = [];
  let row = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"' && csv[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === '"') {
      if (field || closed) throw new Error("Felaktiga citationstecken i CSV.");
      quoted = true;
    } else if (c === delimiter) {
      row.push(field.trim());
      field = "";
      closed = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && csv[i + 1] === "\n") i++;
      row.push(field.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else {
      if (closed && c.trim())
        throw new Error("Oväntad text efter citerat CSV-fält.");
      field += c;
    }
  }
  if (quoted) throw new Error("Oavslutat citerat fält i CSV.");
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2 || rows.length > 10001)
    throw new Error("CSV måste innehålla rubrik och 1–10 000 datarader.");
  const headers = rows.shift().map((s) => s.toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some((h) => !h))
    throw new Error("CSV-rubriker måste vara unika och ifyllda.");
  return {
    headers,
    rows: rows.map((r, i) => {
      if (r.length !== headers.length)
        throw new Error(`Fel antal kolumner på rad ${i + 2}.`);
      return Object.fromEntries(headers.map((h, j) => [h, r[j]]));
    }),
  };
}
export function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw new Error("Datum ska vara ett giltigt YYYY-MM-DD.");
  return value;
}
export function normalizeCSV(csv, mapping = {}) {
  const { headers, rows } = parseCSV(csv);
  const names = {
    date: ["date", "datum", "payment date"],
    description: ["description", "beskrivning", "text", "marketplace"],
    amount: ["amount", "belopp", "royalty", "commission"],
    currency: ["currency", "valuta"],
    reference: ["reference", "referens", "id"],
    period: ["period", "report period"],
  };
  for (const [key, value] of Object.entries(mapping)) {
    if (
      !(key in names) ||
      typeof value !== "string" ||
      !headers.includes(value.toLowerCase())
    )
      throw new Error(
        `Fältmappningen för ${key} hänvisar till en kolumn som saknas.`,
      );
  }
  const fields = Object.fromEntries(
    Object.entries(names).map(([key, alternatives]) => [
      key,
      mapping[key]?.toLowerCase() ||
        alternatives.find((a) => headers.includes(a)),
    ]),
  );
  for (const f of ["date", "description", "amount"])
    if (!fields[f] || !headers.includes(fields[f]))
      throw new Error(`Saknar CSV-kolumn för ${f}. Ange fältmappning.`);
  return rows.map((row, i) => {
    try {
      const currency = (row[fields.currency] || "SEK").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Ogiltig valutakod.");
      const description = row[fields.description];
      if (!description || description.length > 500)
        throw new Error("Beskrivning saknas eller är för lång.");
      return {
        date: validDate(row[fields.date]),
        description,
        amount: decimal(row[fields.amount]),
        currency,
        reference: row[fields.reference] || "",
        period: row[fields.period] || "",
      };
    } catch (e) {
      throw new Error(`Rad ${i + 2}: ${e.message}`);
    }
  });
}
