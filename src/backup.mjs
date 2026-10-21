import { backup, DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const hash = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
export function verifyDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const checks = db.prepare("PRAGMA integrity_check").all();
    if (checks.length !== 1 || checks[0].integrity_check !== "ok")
      throw new Error("Databasens integritetskontroll misslyckades.");
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Brutna databasreferenser.");
    if (!db.prepare("SELECT id FROM company WHERE id=1").get())
      throw new Error("Företagsuppgifter saknas.");
    if (
      db
        .prepare(
          "SELECT v.id FROM vouchers v LEFT JOIN entries e ON e.voucher_id=v.id GROUP BY v.id HAVING COALESCE(SUM(e.debit-e.credit),1)<>0 OR COUNT(e.id)<2",
        )
        .all().length
    )
      throw new Error("Obalanserade verifikationer i backup.");
    for (const d of db.prepare("SELECT hash,content FROM documents").all())
      if (createHash("sha256").update(d.content).digest("hex") !== d.hash)
        throw new Error("Skadat underlag i backup.");
    return {
      vouchers: db.prepare("SELECT COUNT(*) n FROM vouchers").get().n,
      documents: db.prepare("SELECT COUNT(*) n FROM documents").get().n,
    };
  } finally {
    db.close();
  }
}
export async function makeBackup(store, destination) {
  if (existsSync(destination) || existsSync(destination + ".json"))
    throw new Error("Backupfilen finns redan.");
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  const temp = destination + ".tmp";
  if (existsSync(temp)) throw new Error("Temporär backupfil finns redan.");
  try {
    await backup(store.db, temp);
    const counts = verifyDatabase(temp);
    const manifest = {
      format: 1,
      createdAt: new Date().toISOString(),
      sha256: hash(temp),
      ...counts,
    };
    renameSync(temp, destination);
    writeFileSync(destination + ".json", JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    return manifest;
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}
export function restoreBackup(source, destination) {
  if (
    existsSync(destination) ||
    existsSync(destination + "-wal") ||
    existsSync(destination + "-shm")
  )
    throw new Error(
      "Återställ endast till en ny databasfil, med applikationen stoppad.",
    );
  const manifest = JSON.parse(readFileSync(source + ".json", "utf8"));
  if (manifest.format !== 1 || manifest.sha256 !== hash(source))
    throw new Error("Backupens kontrollsumma stämmer inte.");
  const counts = verifyDatabase(source);
  mkdirSync(dirname(resolve(destination)), { recursive: true });
  copyFileSync(source, destination, 1);
  // Sessions must not survive restoring an earlier database snapshot.
  const db = new DatabaseSync(destination);
  try {
    db.exec("DELETE FROM sessions");
  } finally {
    db.close();
  }
  return counts;
}
