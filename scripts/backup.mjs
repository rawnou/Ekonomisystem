import { Store } from "../src/domain.mjs";
import { makeBackup, restoreBackup } from "../src/backup.mjs";
const [mode = "create", source, target] = process.argv.slice(2);
if (mode === "restore") {
  if (!source || !target)
    throw new Error(
      "Använd: node scripts/backup.mjs restore backups/fil.sqlite data/ny.sqlite",
    );
  console.log("Återställd och verifierad:", restoreBackup(source, target));
} else if (mode === "create") {
  const store = new Store(process.env.DATABASE_PATH || "data/ekonomi.sqlite");
  try {
    const destination =
      source ||
      `backups/ekonomi-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`;
    console.log(
      "Backup verifierad:",
      destination,
      await makeBackup(store, destination),
    );
  } finally {
    store.close();
  }
} else throw new Error("Okänt kommando. Använd create eller restore.");
