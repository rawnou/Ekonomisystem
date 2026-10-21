import { Store } from "../src/domain.mjs";
import { invoicePDF } from "../src/pdf.mjs";
const store = new Store(process.env.DATABASE_PATH || "data/ekonomi.sqlite");
try {
  if (
    store.get("SELECT id FROM vouchers LIMIT 1") ||
    store.get("SELECT id FROM customers LIMIT 1")
  )
    throw new Error(
      "Demodata får bara läggas till i en tom initierad databas.",
    );
  const actor = store.get(
    "SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1",
  )?.id;
  if (!actor) throw new Error("Kör setup först.");
  const customer = store.customer(
    {
      name: "Demokunden Studio AB",
      orgNumber: "559999-9998",
      address: "Exempelvägen 8, 111 11 Stockholm",
      email: "faktura@example.test",
    },
    actor,
  );
  store.post(
    {
      date: "2026-01-02",
      text: "Syntetisk kapitalinsättning",
      lines: [
        { account: "1930", debit: "25000" },
        { account: "2081", credit: "25000" },
      ],
    },
    actor,
  );
  for (const [month, price] of [
    ["07", "12000"],
    ["08", "16000"],
    ["09", "20000"],
    ["10", "8000"],
  ]) {
    const date = `2026-${month}-05`;
    const invoice = store.invoice(
      {
        customerId: customer.id,
        date,
        dueDate: `2026-${month}-28`,
        description: `Webbutveckling – syntetiskt exempel ${month}`,
        quantity: "1",
        unitPrice: price,
        vatRate: 25,
      },
      actor,
    );
    store.issue(invoice.id, 1, actor);
    if (month !== "10")
      store.payment(
        invoice.id,
        {
          date: `2026-${month}-20`,
          amount:
            month === "09" ? "10000" : String((BigInt(price) * 125n) / 100n),
        },
        actor,
      );
    store.post(
      {
        date,
        text: "Syntetiskt programvaruinköp med underlagshantering som test",
        lines: [
          { account: "5420", debit: "1000" },
          { account: "2641", debit: "250" },
          { account: "1930", credit: "1250" },
        ],
      },
      actor,
    );
  }
  const bytes = invoicePDF(store, 1);
  store.document(
    {
      name: "Syntetisk kundfaktura 1.pdf",
      type: "application/pdf",
      data: bytes.toString("base64"),
    },
    actor,
  );
  store.import(
    {
      source: "kdp",
      csv: "date;marketplace;royalty;currency;reference;period\n2026-10-15;Amazon.de;123,45;EUR;DEMO-KDP-01;2026-08",
    },
    actor,
  );
  store.import(
    {
      source: "adtraction",
      csv: "date;description;commission;currency;reference;period\n2026-10-16;Provision – kräver manuell momsbedömning;750;SEK;DEMO-ADT-01;2026-09",
    },
    actor,
  );
  store.bank(
    {
      date: "2026-10-16",
      description: "Syntetisk bankkostnad",
      amount: "-99",
      currency: "SEK",
      reference: "DEMO-BANK-01",
    },
    actor,
  );
  console.log(
    "Syntetiska demodata skapade som riktiga databasposter. Inga verkliga kunder eller bankuppgifter.",
  );
} finally {
  store.close();
}
