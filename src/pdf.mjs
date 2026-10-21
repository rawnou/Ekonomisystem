import { amountText } from "./money.mjs";
function printable(value) {
  const s = String(value)
    .normalize("NFC")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s/g, " ");
  if (/[^\x20-\xFF]/.test(s))
    throw new Error(
      "Faktura-PDF stöder för närvarande latinska tecken. En uppgift innehåller tecken som kräver en inbäddad Unicode-font.",
    );
  return s;
}
function literal(value) {
  return printable(value).replace(/[\\()]/g, "\\$&");
}
export function invoicePDF(store, id) {
  const invoice = store.get("SELECT * FROM invoices WHERE id=?", id);
  if (!invoice?.snapshot)
    throw new Error("Endast fastställda fakturor kan exporteras till PDF.");
  const { company, customer } = JSON.parse(invoice.snapshot);
  const rows = [
    company.name,
    `${invoice.original_id ? "KREDITFAKTURA" : "FAKTURA"} ${invoice.number}`,
    `Fakturadatum: ${invoice.date}   Förfallodatum: ${invoice.due_date}`,
    `Leverans-/tjänstedatum: ${invoice.date} (samma som fakturadatum)`,
    `Säljare: ${company.name}`,
    `Org.nr: ${company.org_number}   Momsreg.nr: ${company.vat_number}`,
    company.address,
    company.f_tax ? "Godkänd för F-skatt" : "Ej godkänd för F-skatt",
    "",
    `Kund: ${customer.name}`,
    `Org.nr: ${customer.org_number}`,
    customer.address,
    "",
    invoice.description,
    `Antal: ${invoice.quantity / 1000}   Enhetspris: ${amountText(invoice.unit_price)} SEK`,
    `Beskattningsunderlag: ${amountText(invoice.net)} SEK`,
    `Moms ${invoice.vat_rate} %: ${amountText(invoice.vat)} SEK`,
    `TOTALT: ${amountText(invoice.total)} SEK`,
    "",
    `Betalningsuppgifter: ${company.bank}`,
    `Ange fakturanummer ${invoice.number} vid betalning.`,
    ...(invoice.original_id
      ? [
          `Avser ursprunglig faktura ${store.get("SELECT number FROM invoices WHERE id=?", invoice.original_id).number}. Full kreditering.`,
        ]
      : []),
    "",
    "Lokalt testsystem - syntetiska uppgifter. Granska före användning.",
  ];
  const wrapped = rows.flatMap((row) => {
    const words = printable(row)
      .split(/\s+/)
      .flatMap((w) => w.match(/.{1,80}/g) || [""]);
    const out = [];
    let line = "";
    for (const w of words) {
      if (line.length + (line ? 1 : 0) + w.length > 80) {
        out.push(line);
        line = "";
      }
      line += (line ? " " : "") + w;
    }
    out.push(line);
    return out;
  });
  const pages = [];
  for (let i = 0; i < wrapped.length; i += 44)
    pages.push(wrapped.slice(i, i + 44));
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
  ];
  pages.forEach((rows, i) => {
    const stream = `BT /F1 10 Tf 48 790 Td 16 TL\n${rows.map((r, j) => `${j ? "T* " : ""}(${literal(r)}) Tj`).join("\n")}\nET\nBT /F1 9 Tf 48 40 Td (Faktura ${invoice.number} - sida ${i + 1} av ${pages.length}) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
