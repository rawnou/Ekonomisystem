import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
export const token = () => randomBytes(32).toString("hex");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
const scryptOptions = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export function hashPassword(password) {
  if (
    typeof password !== "string" ||
    password.length < 14 ||
    password.length > 256
  )
    throw new Error("Lösenord måste vara 14–256 tecken.");
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64, scryptOptions).toString("hex")}`;
}
export function checkPassword(password, stored) {
  if (typeof password !== "string" || password.length > 256) return false;
  const [salt, hash] = stored.split(":");
  const candidate = scryptSync(password, salt, 64, scryptOptions),
    expected = Buffer.from(hash, "hex");
  return (
    expected.length === candidate.length && timingSafeEqual(candidate, expected)
  );
}
