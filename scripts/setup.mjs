import { Store } from "../src/domain.mjs";
import { randomBytes } from "node:crypto";
const store = new Store(process.env.DATABASE_PATH || "data/ekonomi.sqlite");
try {
  const users = [1, 2].map((n) => ({
    email: `delagare${n}@example.test`,
    name: `Delägare ${n}`,
    password: randomBytes(18).toString("base64url"),
  }));
  store.seed(users);
  console.log(
    "Lokal databas skapad med syntetiskt bolag. Spara lösenorden; de visas bara nu.",
  );
  for (const u of users) console.log(`${u.email}  ${u.password}`);
  console.log("Starta: node src/server.mjs\nÖppna: http://127.0.0.1:3210");
} finally {
  store.close();
}
