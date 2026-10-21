export function decimal(value, scale = 2) {
  if (typeof value !== "string" || !/^-?\d+(?:[.,]\d+)?$/.test(value.trim()))
    throw new Error("Ange ett giltigt decimalbelopp som text.");
  const s = value.trim().replace(",", ".");
  const [whole, fraction = ""] = s.replace("-", "").split(".");
  if (fraction.length > scale)
    throw new Error(`Högst ${scale} decimaler tillåts.`);
  const n =
    BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0"));
  const signed = s.startsWith("-") ? -n : n;
  if (signed > 1_000_000_000_000n || signed < -1_000_000_000_000n)
    throw new Error("Beloppet är för stort.");
  return Number(signed);
}
export function roundRatio(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  return Number(sign * ((sign * numerator + denominator / 2n) / denominator));
}
export function invoiceAmounts(quantity, unitPrice, vatRate) {
  const q = decimal(quantity, 3),
    unit = decimal(unitPrice);
  if (q <= 0 || unit < 0 || ![0, 6, 12, 25].includes(Number(vatRate)))
    throw new Error("Kontrollera antal, pris och momssats.");
  const net = roundRatio(BigInt(q) * BigInt(unit), 1000n);
  if (!Number.isSafeInteger(net) || net > 1_000_000_000_000)
    throw new Error("Fakturabeloppet är för stort.");
  const vat = roundRatio(BigInt(net) * BigInt(vatRate), 100n);
  return { net, vat, total: net + vat, quantity: q, unit };
}
export function amountText(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error("Ogiltigt belopp.");
  const value = BigInt(cents),
    absolute = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}
export function convertCurrency(original, rate) {
  const cents = decimal(original),
    scaledRate = decimal(rate, 6);
  if (scaledRate <= 0) throw new Error("Växelkurs måste vara positiv.");
  return roundRatio(BigInt(cents) * BigInt(scaledRate), 1_000_000n);
}
