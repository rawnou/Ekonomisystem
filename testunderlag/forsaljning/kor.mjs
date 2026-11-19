import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Store } from "../../src/domain.mjs";
import { createApp } from "../../src/server.mjs";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE || "playwright-core");
const fixture = JSON.parse(await readFile(new URL("./testdata.json", import.meta.url)));
const dir = await mkdtemp(join(tmpdir(), "balans-forsaljning-"));
const out = process.argv[2] || dir;
await mkdir(out, { recursive: true });
const store = new Store(join(dir, "forsaljning.sqlite"));
const user = { email: "forsaljning@example.test", name: "Fiktiv säljare", password: randomUUID() };
store.seed([user]);

const probe = createServer();
await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
const { port } = probe.address();
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const app = createApp(store, { port });
await new Promise((resolve) => app.listen(port, "127.0.0.1", resolve));

let browser, context, page, headers;
const output = {};
function record(id, part) {
  output[id] = part;
  console.log(id, JSON.stringify(part));
}
async function api(path, data) {
  const response = await (data === undefined
    ? context.request.get(origin + path)
    : context.request.post(origin + path, { headers, data }));
  return { status: response.status(), body: await response.json() };
}
async function state() {
  const { status, body } = await api("/api/state");
  assert.equal(status, 200);
  return body;
}
function auditSnapshot(s, id) {
  const invoice = s.invoices.find((entry) => entry.id === id);
  const { number, status, net, vat, total, paid, due_date, original_id } = invoice;
  const vouchers = s.vouchers.filter((v) => v.invoice_id === id).reverse().map(({ number, date, lines }) => ({
    number, date, lines,
  }));
  for (const { lines } of vouchers) {
    assert.equal(lines.reduce((sum, line) => sum + line.debit - line.credit, 0), 0);
  }
  const { income, cash, receivables, trialBalance } = s.reports;
  const accounts = Object.fromEntries(trialBalance.filter((account) => ["1510", "1930", "2611", "3041"].includes(account.number)).map(
    ({ number, balance }) => [number, balance],
  ));
  return { invoice: { id, number, status, net, vat, total, paid, due_date, original_id },
    vouchers, reports: { income, cash, receivables, accounts } };
}
function checkAmounts(s, { number, status, net, vat, total, paid, income, cash, receivables, outputVAT }) {
  assert.deepEqual(
    [s.invoice.number, s.invoice.status, s.invoice.net, s.invoice.vat, s.invoice.total, s.invoice.paid, s.reports.income, s.reports.cash, s.reports.receivables],
    [number, status, net, vat, total, paid, income, cash, receivables],
  );
  assert.equal(s.reports.accounts[1510], receivables);
  assert.equal(s.reports.accounts[1930], cash);
  assert.equal(s.reports.accounts[3041], -income || 0);
  assert.equal(s.reports.accounts[2611], -outputVAT || 0);
}
const nav = (name) => page.locator(`nav button[data-page="${name}"]`).click();
const form = (name) => page.locator(`form[data-form="${name}"]`);
async function fill(formName, values) {
  for (const [key, value] of Object.entries(values)) {
    const field = form(formName).locator(`[name=${key}]`);
    if (await field.evaluate((e) => e.tagName === "SELECT")) {
      await field.selectOption(String(value));
    } else {
      await field.fill(String(value));
    }
  }
}
async function clickSubmit(formName, path, options = {}) {
  const response = page.waitForResponse((r) => r.url().endsWith(path) && r.request().method() !== "GET");
  if (options.refresh !== false) {
    const stateResponse = page.waitForResponse((r) => r.url().endsWith("/api/state"));
    await form(formName).locator("button[type=submit]").click();
    await stateResponse;
    await page.waitForFunction(() => !document.querySelector("button[type=submit]:disabled"));
  } else {
    await form(formName).locator("button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector("#notice").classList.contains("error"));
  }
  return { status: (await response).status(), body: await (await response).json() };
}
async function action(id, name, answers) {
  const dialogHandler = async (dialog) => {
    const answer = answers.shift();
    if (dialog.type() === "confirm") assert.equal(answer, true);
    await dialog.accept(typeof answer === "string" ? answer : undefined);
  };
  page.on("dialog", dialogHandler);
  try {
    const endpoint = `/api/invoices/${id}/${name}`;
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(endpoint)),
      page.waitForResponse((r) => r.url().endsWith("/api/state")),
      page.locator(`[data-action=${name}][data-id="${id}"]`).click(),
    ]);
    assert.equal(answers.length, 0);
    await page.waitForFunction(() => !document.querySelector("button[data-action]:disabled"));
    return { status: response.status(), body: await response.json() };
  } finally {
    page.off("dialog", dialogHandler);
  }
}
function invoiceRow(id, actionName) {
  return page.locator("tr").filter({ has: page.locator(`button[data-action=${actionName}][data-id="${id}"]`) });
}
async function writePdf(id, stem) {
  const r = await context.request.get(`${origin}/api/invoices/${id}/pdf`);
  assert.equal(r.status(), 200);
  assert.equal(r.headers()["content-type"], "application/pdf");
  const pdf = await r.body();
  const filepath = join(dir, `${stem}.pdf`);
  await writeFile(filepath, pdf);
  const extracted = execFileSync("pdftotext", ["-layout", filepath, "-"], { encoding: "utf8" }).trim();
  await writeFile(join(out, `${stem}.txt`), extracted + "\n");
  return { pdf, extracted, contentDisposition: r.headers()["content-disposition"] };
}
try {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  context = await browser.newContext({ locale: "sv-SE", timezoneId: "Europe/Stockholm", viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.clock.setFixedTime(new Date("2026-11-19T12:00:00Z"));
  await page.goto(origin);
  await fill("login", { email: user.email, password: user.password });
  assert.equal((await clickSubmit("login", "/api/login")).status, 200);
  const session = await api("/api/session");
  assert.equal(session.status, 200);
  headers = { Origin: origin, "X-CSRF-Token": session.body.csrf };

  await nav("settings");
  const companyName = process.env.BALANS_TEST_COMPANY || "Testkompassen AB";
  await fill("company", { name: companyName, orgNumber: "559900-0006", vatNumber: "SE559900000601", address: "Bokföringsvägen 42, 111 11 Exempelstad", bank: "FIKTIV BANKREFERENS" });
  assert.equal((await clickSubmit("company", "/api/company")).status, 200);
  assert.equal((await state()).company.name, companyName);

  await nav("customers");
  await fill("customer", { name: "Fiktiv ofullständig kund" });
  const missingCustomer = await clickSubmit("customer", "/api/customers", { refresh: false });
  assert.equal(missingCustomer.status, 400);
  assert.equal((await state()).customers.length, 0);
  assert.deepEqual(await form("customer").locator("input[required]").evaluateAll((fields) => fields.map((f) => f.name)), ["name"]);
  await fill("customer", fixture.customer);
  const registered = await clickSubmit("customer", "/api/customers");
  assert.equal(registered.status, 200);
  const customerId = registered.body.id;
  assert.match(await page.locator("tbody").innerText(), /Fiktiv Skärgårdskund AB/);
  const registeredCustomer = (await state()).customers[0];
  assert.equal(registeredCustomer.name, fixture.customer.name);
  record("F-01", { customer: registeredCustomer, ledgerCount: (await state()).vouchers.length });
  record("F-02", { requiredHtml: ["name"], onlyName: missingCustomer, partialSave: false, editOrDeleteButtons: await page.locator("tbody button").count() });

  await nav("invoices");
  await fill("invoice", { customerId, ...fixture.invoiceA });
  const draftA = await clickSubmit("invoice", "/api/invoices");
  assert.equal(draftA.status, 200);
  const a = draftA.body.id;
  let snap = auditSnapshot(await state(), a);
  checkAmounts(snap, { number: null, status: "draft", net: 2000000, vat: 500000, total: 2500000, paid: 0,
    income: 0, cash: 0, receivables: 0, outputVAT: 0 });
  assert.equal(snap.vouchers.length, 0);
  const draftRow = invoiceRow(a, "issue");
  const draftActions = await draftRow.locator("a,button").allTextContents();
  assert.deepEqual(draftActions, ["Fastställ"]);
  assert.doesNotMatch(await draftRow.innerText(), /Planering och analys A/);
  const draftPdf = await api(`/api/invoices/${a}/pdf`);
  assert.equal(draftPdf.status, 400);
  record("F-03", { ...snap, draftRow: await draftRow.innerText() });
  record("F-04", { draftActions, descriptionInRow: false, draftPdf });

  const badDue = await api("/api/invoices", { customerId, ...fixture.invoiceA, dueDate: "2026-09-30" });
  assert.equal(badDue.status, 400);
  assert.equal((await state()).invoices.length, 1);
  const issuedA = await action(a, "issue", [true]);
  assert.equal(issuedA.status, 200);
  const repeatedIssue = await api(`/api/invoices/${a}/issue`, { version: 1 });
  assert.equal(repeatedIssue.status, 409);
  snap = auditSnapshot(await state(), a);
  checkAmounts(snap, { number: 1, status: "issued", net: 2000000, vat: 500000, total: 2500000, paid: 0,
    income: 2000000, cash: 0, receivables: 2500000, outputVAT: 500000 });
  assert.equal(snap.vouchers.length, 1);
  record("F-05", { ...snap, repeatedIssue, badDue });
  const overdueRow = await invoiceRow(a, "payment").innerText();
  assert.match(overdueRow, /2026-10-15/);
  assert.match(overdueRow, /Fastställd/);
  assert.doesNotMatch(overdueRow, /förfallen/i);
  const paidEarly = await api(`/api/invoices/${a}/payment`, { amount: "10000", date: "2026-09-30" });
  assert.equal(paidEarly.status, 400);
  await nav("overview");
  const overviewTasks = await page.locator(".task-row").allTextContents();
  assert.ok(overviewTasks.some((label) => label.includes("Obetalda fakturor")));
  assert.ok(!overviewTasks.some((label) => /förfall/i.test(label)));
  await nav("invoices");
  record("F-06", { browserDate: "2026-11-19", overdueRow, overviewTasks, paidEarly, vouchersAfter: (await state()).vouchers.length });

  const download = page.waitForEvent("download");
  await invoiceRow(a, "payment").getByText("PDF", { exact: true }).click();
  const pdfDownload = await download;
  await pdfDownload.saveAs(join(dir, "A-webblasare.pdf"));
  const { pdf: pdfA, extracted: extractedA } = await writePdf(a, "faktura-A");
  assert.deepEqual(await readFile(join(dir, "A-webblasare.pdf")), pdfA);
  for (const expectation of [companyName, fixture.customer.name, fixture.invoiceA.description, "20000.00", "5000.00",
    "25000.00", fixture.invoiceA.dueDate]) assert.ok(extractedA.includes(expectation), expectation);
  const boundary = "BALANS-FIKTIV-LOKAL-LEVERANS";
  const mimePdf = pdfA.toString("base64").match(/.{1,76}/g).join("\r\n");
  const eml = [
    "From: saljare@example.test", `To: ${fixture.customer.email}`, "Subject: Fiktiv faktura 1",
    "MIME-Version: 1.0", `Content-Type: multipart/mixed; boundary="${boundary}"`, "",
    `--${boundary}`, "Content-Type: text/plain; charset=us-ascii", "", "Lokal simulering.", "",
    `--${boundary}`, 'Content-Type: application/pdf; name="faktura-1.pdf"', 'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="faktura-1.pdf"', "", mimePdf, `--${boundary}--`, "",
  ].join("\r\n");
  const mailPath = join(dir, "lokal-utkorg.eml");
  await writeFile(mailPath, eml);
  const readMail = await readFile(mailPath, "utf8");
  const encoded = readMail.split('Content-Disposition: attachment; filename="faktura-1.pdf"\r\n\r\n')[1]
    .split(`\r\n--${boundary}--`)[0];
  assert.deepEqual(Buffer.from(encoded, "base64"), pdfA);
  record("F-07", { browserFilename: pdfDownload.suggestedFilename(), bytes: pdfA.length,
    pdfSHA256: createHash("sha256").update(pdfA).digest("hex"), localEmlBytes: Buffer.byteLength(readMail) });
  const sendControls = await page.getByRole("button", { name: /skicka/i }).count();
  assert.equal(sendControls, 0);
  record("F-07b", { sendControls, uiActions: await invoiceRow(a, "payment").locator("a,button").allTextContents() });

  const [del, slut, dublett] = fixture.paymentSlip;
  assert.equal((await action(a, "payment", [del.amount, del.date])).status, 200);
  const afterPartial = auditSnapshot(await state(), a);
  checkAmounts(afterPartial, { number: 1, status: "partial", net: 2000000, vat: 500000, total: 2500000, paid: 1000000,
    income: 2000000, cash: 1000000, receivables: 1500000, outputVAT: 500000 });
  assert.match(await invoiceRow(a, "payment").innerText(), /Delbetald/);
  const overpayment = await api(`/api/invoices/${a}/payment`, { amount: "15000,01", date: slut.date });
  assert.equal(overpayment.status, 400);
  assert.deepEqual(auditSnapshot(await state(), a), afterPartial);
  assert.equal((await action(a, "payment", [slut.amount, slut.date])).status, 200);
  const afterFull = auditSnapshot(await state(), a);
  checkAmounts(afterFull, { number: 1, status: "paid", net: 2000000, vat: 500000, total: 2500000, paid: 2500000,
    income: 2000000, cash: 2500000, receivables: 0, outputVAT: 500000 });
  assert.equal(await invoiceRow(a, "payment").count(), 0);
  assert.equal(await page.getByText("Betald", { exact: true }).count(), 1);
  record("F-08", { afterPartial, overpayment, afterFull });

  const draftB = await clickDraft(fixture.invoiceB);
  const b = draftB.id;
  assert.equal((await action(b, "issue", [true])).status, 200);
  snap = auditSnapshot(await state(), b);
  checkAmounts(snap, { number: 2, status: "issued", net: 62, vat: 16, total: 78, paid: 0,
    income: 2000062, cash: 2500000, receivables: 78, outputVAT: 500016 });
  const { extracted: extractedB } = await writePdf(b, "faktura-B");
  for (const expectation of ["0.62", "0.16", "0.78"]) assert.ok(extractedB.includes(expectation), expectation);
  record("F-09", snap);

  async function clickDraft(values) {
    await fill("invoice", { customerId, ...values });
    const result = await clickSubmit("invoice", "/api/invoices");
    assert.equal(result.status, 200);
    return result.body;
  }
  const { id: c } = await clickDraft(fixture.invoiceC);
  assert.equal((await action(c, "issue", [true])).status, 200);
  const beforeCredit = auditSnapshot(await state(), c);
  const credit = await action(c, "credit", ["2026-10-04"]);
  assert.equal(credit.status, 200);
  const s = await state();
  const original = auditSnapshot(s, c);
  const credited = auditSnapshot(s, credit.body.id);
  assert.equal(original.invoice.status, "credited");
  assert.equal(credited.invoice.original_id, c);
  checkAmounts(credited, { number: 4, status: "credit", net: -800000, vat: -200000, total: -1000000, paid: 0,
    income: 2000062, cash: 2500000, receivables: 78, outputVAT: 500016 });
  const { extracted: creditText } = await writePdf(credit.body.id, "kredit-C");
  assert.ok(creditText.includes("Kredit av faktura 3"));
  assert.ok(creditText.includes("-10000.00"));
  record("F-10", { beforeCredit, original, credited, duplicateCredit: await api(`/api/invoices/${c}/credit`, { date: "2026-10-04" }) });
  assert.equal(output["F-10"].duplicateCredit.status, 400);

  const { id: d } = await clickDraft(fixture.invoiceD);
  assert.equal((await action(d, "issue", [true])).status, 200);
  assert.equal((await action(d, "payment", [dublett.amount, dublett.date])).status, 200);
  const expectedSingle = auditSnapshot(await state(), d);
  assert.equal(expectedSingle.invoice.paid, 10000);
  const repeatedPayment = await api(`/api/invoices/${d}/payment`, { amount: dublett.amount, date: dublett.date });
  assert.equal(repeatedPayment.status, 200);
  const doublePayment = auditSnapshot(await state(), d);
  assert.equal(doublePayment.invoice.paid, 20000);
  assert.equal(doublePayment.reports.receivables, expectedSingle.reports.receivables - 10000);
  assert.equal(doublePayment.reports.cash, expectedSingle.reports.cash + 10000);
  assert.equal(doublePayment.vouchers.length, 3);
  record("F-11", { bankReference: dublett.bankReference, expectedSingle, repeatedPayment, doublePayment });

  const afterRetry = await state();
  const paymentVoucher = afterRetry.vouchers.find((v) => v.invoice_id === d);
  const reverseWrong = await api(`/api/vouchers/${paymentVoucher.id}/reverse`, { date: "2026-10-21", reason: "Fiktiv dubbelbetalning" });
  const creditPartialInvoice = await api(`/api/invoices/${d}/credit`, { date: "2026-10-21" });
  assert.equal(reverseWrong.status, 400);
  assert.equal(creditPartialInvoice.status, 400);
  assert.deepEqual(auditSnapshot(await state(), d), doublePayment);
  record("F-12", { paymentVoucher: paymentVoucher.number, reverseWrong, creditPartialInvoice, vouchersAfter: (await state()).vouchers.length });

  const rateResponses = {};
  for (const vatRate of [0, 6, 12]) {
    const before = await state();
    rateResponses[vatRate] = await api("/api/invoices", { customerId, ...fixture.invoiceB, vatRate });
    assert.equal(rateResponses[vatRate].status, 400);
    assert.deepEqual(await state(), before);
  }
  record("F-13", { uiRates: await form("invoice").locator("select[name=vatRate] option").allTextContents(), rateResponses });

  const extraLine = { description: "Oregistrerad andra rad", quantity: "1", unitPrice: "200", vatRate: 25 };
  const firstLine = { ...fixture.invoiceD, description: "Första rad", unitPrice: "100" };
  const multiOnly = await api("/api/invoices", { customerId, date: firstLine.date, dueDate: firstLine.dueDate,
    lines: [firstLine, extraLine] });
  assert.equal(multiOnly.status, 400);
  const multiWithLegacyLine = await api("/api/invoices", { customerId, ...firstLine, lines: [firstLine, extraLine] });
  assert.equal(multiWithLegacyLine.status, 200);
  const e = multiWithLegacyLine.body.id;
  assert.equal((await api(`/api/invoices/${e}/issue`, { version: 1 })).status, 200);
  const noSecondLine = auditSnapshot(await state(), e);
  assert.equal(noSecondLine.invoice.total, 12500);
  record("F-14", { correctGrossIfAllRows: 37500, multiOnly, multiWithLegacyLine, noSecondLine });

  const partialCreditAttempt = await api(`/api/invoices/${e}/credit`, { date: "2026-10-06", amount: "50" });
  assert.equal(partialCreditAttempt.status, 200);
  const accidentalFullCredit = auditSnapshot(await state(), partialCreditAttempt.body.id);
  assert.equal(accidentalFullCredit.invoice.total, -12500);
  record("F-15", { requestedGross: -5000, accidentalFullCredit, originalStatus: (await state()).invoices.find((i) => i.id === e).status });

  const emojiDraft = await api("/api/invoices", { customerId, ...fixture.invoiceD, description: "Fiktiv tjänst ✨" });
  assert.equal(emojiDraft.status, 200);
  const emojiId = emojiDraft.body.id;
  assert.equal((await api(`/api/invoices/${emojiId}/issue`, { version: 1 })).status, 200);
  const emojiIssue = auditSnapshot(await state(), emojiId);
  const badPdf = await api(`/api/invoices/${emojiId}/pdf`);
  assert.equal(badPdf.status, 400);
  const json = await api("/api/export/json");
  assert.equal(json.status, 200);
  const snapshot = JSON.parse(json.body.invoices.find((i) => i.id === emojiId).snapshot);
  assert.equal(snapshot.company.name, companyName);
  record("F-16", { emojiIssue, badPdf });

  const { id: pendingDraft } = await clickDraft(fixture.invoiceB);
  const { id: issueFirst } = await clickDraft(fixture.invoiceB);
  const issuance = await action(issueFirst, "issue", [true]);
  assert.equal(issuance.status, 200);
  assert.equal(pendingDraft, 9);
  assert.equal(issueFirst, 10);
  assert.equal(issuance.body.number, 9);
  const { contentDisposition, extracted: idMismatchText } = await writePdf(issueFirst, "faktura-nummer-9");
  assert.equal(contentDisposition, 'attachment; filename="faktura-10.pdf"');
  assert.match(idMismatchText, /FAKTURA 9/);
  record("F-17", { pendingDraft, issueFirst, invoiceNumber: issuance.body.number, contentDisposition });
  await page.screenshot({ path: join(out, "fakturavy.png") });
  await writeFile(join(out, "utfall.json"), JSON.stringify(output, null, 2) + "\n");
  console.log("Webbläsare", browser.version());
  console.log("Testkatalog", dir);
} finally {
  await browser?.close();
  await new Promise((resolve) => app.close(resolve));
  store.close();
}
