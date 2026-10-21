import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Store } from "../src/domain.mjs";

// Execute the actual application handlers. This is a UI logic/markup test,
// not a browser, layout, accessibility or native HTML validation test.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const ok = (value) => ({ ok: true, json: async () => value });
function fixture(t) {
  const store = new Store(":memory:");
  store.seed([{ email: "flow@example.test", name: "Syntetisk flödesgranskare", password: "synthetic-flow-password" }]);
  t.after(() => store.close());
  return store;
}
async function ui(store, fetchImpl = async () => ok({})) {
  const handlers = {}, root = { innerHTML: "", addEventListener: (name, fn) => { handlers[name] = fn; } };
  const notice = { textContent: "", className: "" };
  const app = await runInNewContext(`(async () => { ${source}\nreturn {
    init(s, role = 'admin') { session = { user: { role, name: 'Test' }, csrf: 'test' }; state = s; },
    customers, invoiceRows, invoices, ledger, reports, bank,
    getPage() { return page; },
  }; })()`, {
    document: { querySelector: (selector) => selector === "#app" ? root : notice },
    fetch: (path, opts) => path === "/api/session" ? Promise.resolve(ok({})) : fetchImpl(path, opts),
    FormData: class { constructor(form) { return Object.entries(form.values)[Symbol.iterator](); } },
    confirm: () => true, prompt: () => null, setTimeout: () => 0, clearTimeout: () => {},
    Intl, Date,
  });
  app.init(store.state());
  return { app, handlers, root, notice };
}
function voucherForm() {
  const button = { disabled: false };
  const values = { date: "2026-10-01", text: "Syntetiskt materialinköp", documentId: "" };
  const rows = [
    { account: "6110", debit: "100", credit: "0" },
    { account: "1930", debit: "0", credit: "100" },
  ].map((values) => ({ querySelector: (selector) => ({ value: values[selector.match(/name=(\w+)/)[1]] }) }));
  return { dataset: { form: "voucher" }, values,
    querySelector: () => button, querySelectorAll: () => rows };
}
function draft(store, description = "Kontrollera den här tjänstebeskrivningen") {
  const customerId = store.customer({ name: "Test AB", orgNumber: "5599999999", email: "test@example.test", address: "Testgatan 1" }, 1).id;
  return store.invoice({ customerId, description, date: "2026-10-01", dueDate: "2026-10-31", quantity: "3", unitPrice: "100", vatRate: "25" }, 1).id;
}

test("FL1 verified: successful voucher save + failed refresh leaves a retry that books twice", async (t) => {
  const store = fixture(t);
  let refreshes = 0, mutations = 0;
  const { handlers, notice } = await ui(store, async (path, options) => {
    if (path === "/api/vouchers") {
      mutations++;
      return ok(store.post(JSON.parse(options.body), 1));
    }
    if (path === "/api/state") {
      if (++refreshes === 1) throw new Error("Syntetiskt avbrott vid omläsning");
      return ok(store.state());
    }
    throw new Error("Unexpected path " + path);
  });
  const form = voucherForm(), event = { preventDefault() {}, target: form };
  await handlers.submit(event);
  assert.equal(store.state().vouchers.length, 1);
  assert.match(notice.textContent, /avbrott/);
  assert.equal(notice.className, "visible error");
  assert.equal(form.querySelector().disabled, false);
  await handlers.submit(event);
  assert.equal(mutations, 2);
  assert.equal(store.state().vouchers.length, 2);
  assert.equal(store.reports().expenses, 20000);
  assert.equal(store.reports().cash, -20000);
});

test("FL2 verified: customer fields advertised as optional are required by the domain", async (t) => {
  const store = fixture(t), { app } = await ui(store);
  const markup = app.customers();
  for (const name of ["orgNumber", "email", "address"]) {
    const input = markup.match(new RegExp(`<input name="${name}"[^>]*>`))[0];
    assert.doesNotMatch(input, /\brequired\b/);
    assert.throws(() => store.customer({ name: "Test AB", orgNumber: "5599999999", email: "test@example.test", address: "Testgatan 1", [name]: "" }, 1), /Obligatorisk text/);
  }
  assert.equal(store.state().customers.length, 0);
});

test("FL3 verified: saved draft cannot be inspected or corrected in the invoice view", async (t) => {
  const store = fixture(t), description = "Unik tjänst som måste kunna granskas";
  const id = draft(store, description), { app } = await ui(store);
  const row = app.invoiceRows(store.state().invoices).join("");
  assert.match(row, /data-action="issue"/);
  assert.doesNotMatch(row, /PDF|Unik tjänst|data-action="(?:edit|delete|preview)"/);
  assert.doesNotMatch(app.invoices(), new RegExp(description));
  assert.equal(store.state().invoices[0].id, id);
  assert.equal(store.state().invoices[0].description, description);
});

test("FL4 verified: posted document association is absent from the ledger view", async (t) => {
  const store = fixture(t);
  const documentId = store.document({ name: "Syntetiskt underlag.pdf", type: "application/pdf", data: Buffer.from("%PDF-1.4\nsynthetic").toString("base64") }, 1).id;
  store.post({ date: "2026-10-01", text: "Syntetiskt materialinköp", documentId,
    lines: [{ account: "6110", debit: "100" }, { account: "1930", credit: "100" }] }, 1);
  const { app } = await ui(store);
  const savedTable = app.ledger().split("Verifikationer</h2>")[1];
  assert.equal(store.state().vouchers[0].document_id, documentId);
  assert.doesNotMatch(savedTable, /Syntetiskt underlag|\/api\/documents\//);
});

test("FL5 control: viewer UI omits write actions and escaping preserves injected customer text", async (t) => {
  const store = fixture(t), id = draft(store);
  const { app } = await ui(store);
  const rows = store.state().invoices;
  rows[0].customer_name = '<img src=x onerror="alert(1)">';
  const output = app.invoiceRows(rows).join("");
  assert.match(output, /&lt;img/);
  assert.doesNotMatch(output, /<img/);
  assert.equal(rows[0].id, id);
  app.init(store.state(), "viewer");
  assert.doesNotMatch(app.invoices(), /data-form="invoice"|data-action="issue"/);
  assert.doesNotMatch(app.ledger(), /data-form="voucher"|data-action="reverse"/);
});
