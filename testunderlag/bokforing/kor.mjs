import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/domain.mjs";
import { createApp } from "../../src/server.mjs";

const fixture = JSON.parse(await readFile(new URL("facit.json", import.meta.url), "utf8"));
const cwd = await mkdtemp(join(tmpdir(), "balans-bokforing-"));
const user = {
  name: "Testkompassens bokförare",
  email: "bokforare-test@example.test",
  password: "Endast-fiktiv-bokforings-fixture-147",
};
const result = (id, status, evidence) => console.log(JSON.stringify({ id, status, ...evidence }));

async function setup(label) {
  const temp = createServer().listen(0, "127.0.0.1");
  await once(temp, "listening");
  const { port } = temp.address();
  await new Promise((resolve) => temp.close(resolve));
  const store = new Store(join(cwd, label + ".sqlite"));
  store.seed([user]);
  const server = createApp(store, { port }).listen(port, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${port}`;
  const login = await fetch(origin + "/api/login", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(user),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrf } = await login.json();

  async function send(method, path, payload, status = 200) {
    const headers = { cookie };
    if (method !== "GET")
      Object.assign(headers, { origin, "content-type": "application/json", "x-csrf-token": csrf });
    const response = await fetch(origin + path, { method, headers, body: JSON.stringify(payload) });
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, status, `${method} ${path} ${bytes.toString().slice(0, 500)}`);
    if (response.headers.get("content-type").startsWith("application/json"))
      return { status, data: JSON.parse(bytes), ...(path.startsWith("/api/export/") && status === 200 ? { bytes } : {}) };
    return { status, bytes };
  }

  const state = async () => (await send("GET", "/api/state")).data;
  const setCompany = async (data = {}, status = 200) => send("PUT", "/api/company", {
    ...fixture.company,
    ...data,
    version: (await state()).company.version,
  }, status);
  return {
    origin, send, state, setCompany,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      store.close();
    },
  };
}

let browser, openPage;
if (!process.env.PLAYWRIGHT_MODULE) {
  console.error("PLAYWRIGHT_MODULE saknas. Verifikationen körs via API och UI-delen markeras blockerad.");
} else {
  const require = createRequire(import.meta.url);
  const { chromium } = require(process.env.PLAYWRIGHT_MODULE);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || "/usr/bin/chromium" });
}
const vouchers = (state) => state.vouchers.toSorted((a, b) => a.number - b.number).map(
  (v) => [v.number, v.date, v.lines.map((line) => [line.account, line.debit - line.credit])],
);
const nonzero = (records) => Object.fromEntries(records.filter(([, value]) => value !== 0));
const normalize = (text) => text.replace(/[\u00a0\u202f]/g, " ");
const sum = (values) => values.reduce((total, value) => total + value, 0);
const debitTotal = (lines) => sum(lines.map(([, amount]) => Math.max(0, amount)));
const creditTotal = (lines) => sum(lines.map(([, amount]) => Math.max(0, -amount)));

async function loginUi(origin) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await p.goto(origin);
  await p.locator('input[name="email"]').fill(user.email);
  await p.locator('input[name="password"]').fill(user.password);
  await p.locator('form[data-form="login"] button[type="submit"]').click();
  await p.locator('button[data-page="ledger"]').waitFor();
  return p;
}

async function postOpeningUi(page) {
  await page.locator('button[data-page="ledger"]').click();
  const form = page.locator('form[data-form="voucher"]');
  await form.locator('input[name="date"]').fill(fixture.opening.date);
  await form.locator('input[name="text"]').fill(fixture.opening.text);
  for (const [index, line] of fixture.opening.lines.entries()) {
    const row = form.locator(".line-entry").nth(index);
    await row.locator('select[name="account"]').selectOption(line.account);
    await row.locator('input[name="debit"]').fill(line.debit || "0");
    await row.locator('input[name="credit"]').fill(line.credit || "0");
  }
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/vouchers") && r.request().method() === "POST");
  await form.getByRole("button", { name: "Bokför verifikation" }).click();
  assert.equal((await saved).status(), 200);
  await page.getByRole("cell", { name: fixture.opening.text, exact: true }).waitFor();
}

function decodeSie(bytes) {
  return execFileSync("iconv", ["-f", "CP437", "-t", "UTF-8"], { input: bytes, encoding: "utf8" });
}

function cents(amount) {
  assert.match(amount, /^-?\d+\.\d\d$/);
  const [whole, decimals] = amount.replace("-", "").split(".");
  return Number(whole + decimals) * (amount.startsWith("-") ? -1 : 1);
}

function readSie(text) {
  const periods = [];
  const balances = [];
  const openings = [];
  const exportedVouchers = [];
  const series = new Set();
  let currentVoucher;
  for (const row of text.split(/\r?\n/u)) {
    const parts = row.split(" ");
    switch (parts[0]) {
      case "#RAR":
        periods.push(parts.slice(1));
        break;
      case "#UB":
      case "#RES":
        balances.push([parts[2], cents(parts[3])]);
        break;
      case "#IB":
        openings.push([parts[2], cents(parts[3])]);
        break;
      case "#VER": {
        assert.equal(currentVoucher, undefined);
        series.add(parts[1].replaceAll('"', ""));
        currentVoucher = [Number(parts[2]), parts[3].replace(/^(\d{4})(\d{2})(\d{2})$/u, "$1-$2-$3"), []];
        exportedVouchers.push(currentVoucher);
        break;
      }
      case "#TRANS":
        assert.ok(currentVoucher);
        currentVoucher[2].push([parts[1], cents(parts[3])]);
        break;
      case "}":
        currentVoucher = undefined;
        break;
    }
  }
  assert.equal(currentVoucher, undefined);
  return { periods, balances, openings, exportedVouchers, series: [...series] };
}

const stem = await setup("grundprov");
let annual;
let encoding;
try {
  await stem.setCompany();
  if (browser) {
    openPage = await loginUi(stem.origin);
    await postOpeningUi(openPage);
  } else {
    await stem.send("POST", "/api/vouchers", fixture.opening);
  }
  const before = await stem.state();
  const unbalanced = await stem.send("POST", "/api/vouchers", fixture.imbalanced, 400);
  assert.deepEqual(await stem.state(), before);
  const wrong = (await stem.send("POST", "/api/vouchers", fixture.incorrect)).data;
  assert.deepEqual(wrong, { id: 2, number: 2 });

  const customer = (await stem.send("POST", "/api/customers", fixture.customer)).data;
  const invoice = (await stem.send("POST", "/api/invoices", { ...fixture.invoice, customerId: customer.id })).data;
  await stem.send("POST", `/api/invoices/${invoice.id}/issue`, { version: 1 });
  await stem.send("POST", `/api/invoices/${invoice.id}/payment`, fixture.payment);
  result("R-01", "godkänt", { ui: Boolean(browser), rejection: unbalanced,
    vouchersThroughPayment: vouchers(await stem.state()),
  });

  const lockedIssueDraft = (await stem.send("POST", "/api/invoices", {
    ...fixture.invoice, customerId: customer.id,
  })).data;
  await stem.send("POST", "/api/periods/lock", { through: "2026-04-30" });
  const locked = await stem.state();
  const lockedPost = await stem.send("POST", "/api/vouchers", { ...fixture.incorrect, date: "2026-04-30" }, 409);
  const lockedReverse = await stem.send("POST", `/api/vouchers/${wrong.id}/reverse`, { ...fixture.correction, date: "2026-04-30" }, 409);
  const lockedPayment = await stem.send("POST", `/api/invoices/${invoice.id}/payment`, { amount: "1", date: "2026-04-30" }, 409);
  const lockedDraft = await stem.send("POST", "/api/invoices", {
    ...fixture.invoice, customerId: customer.id,
  }, 409);
  const lockedIssue = await stem.send("POST", `/api/invoices/${lockedIssueDraft.id}/issue`, { version: 1 }, 409);
  assert.deepEqual(await stem.state(), locked);

  const correction = (await stem.send("POST", `/api/vouchers/${wrong.id}/reverse`, fixture.correction)).data;
  const duplicate = await stem.send("POST", `/api/vouchers/${wrong.id}/reverse`, fixture.correction, 400);
  const a6 = (await stem.send("POST", "/api/vouchers", fixture.expense)).data;
  const final = await stem.state();
  assert.equal(a6.number, 6);
  assert.equal(final.vouchers.find((v) => v.id === correction.id).reversal_of, wrong.id);
  assert.deepEqual(final.vouchers.find((v) => v.id === wrong.id), locked.vouchers.find((v) => v.id === wrong.id));
  assert.ok(final.audit.some(({ action, actor, detail }) => action === "voucher.reverse" &&
    actor === 1 && JSON.parse(detail).original === wrong.id));
  result("R-02", "godkänt", { lock: locked.periods[0], lockedPost, lockedReverse, lockedPayment, lockedDraft, lockedIssue,
    correction, correctionText: final.vouchers.find((v) => v.number === 5).text,
    duplicate, nextNumber: a6.number,
  });

  const actual = vouchers(final);
  assert.deepEqual(actual, fixture.expected.vouchers);
  const debit = sum(actual.map(([, , rows]) => debitTotal(rows)));
  const credit = sum(actual.map(([, , rows]) => creditTotal(rows)));
  assert.ok(actual.every(([, , rows]) => debitTotal(rows) === creditTotal(rows)));
  assert.equal(debit, fixture.expected.grossDebit);
  assert.equal(credit, debit);
  const report = final.reports;
  const totals = nonzero(report.trialBalance.map((row) => [row.number, row.balance]));
  const reportTotals = Object.fromEntries(Object.keys(fixture.expected.reports).map((k) => [k, report[k]]));
  const vatDue = -totals["2611"] - totals["2641"];
  assert.deepEqual(totals, fixture.expected.net);
  assert.deepEqual(reportTotals, fixture.expected.reports);
  assert.equal(vatDue, fixture.expected.vatDue);
  const openInvoice = final.invoices.find((i) => i.id === invoice.id);
  assert.equal(openInvoice.total - openInvoice.paid, totals["1510"]);
  assert.equal(openInvoice.status, "partial");
  result("R-03", "godkänt", { totals, reportTotals, vatDue, debit, credit,
    invoice: { id: openInvoice.id, number: openInvoice.number, total: openInvoice.total, paid: openInvoice.paid, status: openInvoice.status },
  });

  let ui;
  if (browser) {
    await openPage.reload();
    await openPage.locator('button[data-page="ledger"]').click();
    const ledger = await openPage.locator(".content table").innerText();
    assert.match(ledger, /A1\s+2026-01-01\s+Testkapital/);
    assert.match(ledger, /A5\s+2026-05-01\s+Rättelse V2:/);
    const presentedNumbers = (await openPage.locator(".content table tbody tr td:first-child").allTextContents()).sort();
    await openPage.locator('button[data-page="reports"]').click();
    const reportText = normalize(await openPage.locator(".content").innerText());
    for (const amount of ["6 000,00 kr", "38 000,00 kr", "2 000,00 kr", "36 000,00 kr", "31 500,00 kr"])
      assert.ok(reportText.includes(amount), amount);
    const reportsHeadings = await openPage.locator(".content h2").allTextContents();
    const reportLinks = await openPage.locator(".content a[href^='/api/export']").allTextContents();
    assert.deepEqual(reportLinks, ["Hämta SIE", "Hämta JSON"]);
    assert.match(reportText, /2611\s+Utgående moms 25 %\s+−2 000,00 kr/);
    assert.match(reportText, /2641\s+Ingående moms\s+500,00 kr/);
    ui = { chromium: browser.version(), reportsHeadings, reportLinks, presentedNumbers };
    if (process.env.BALANS_QA_OUTPUT) {
      await openPage.screenshot({ path: join(process.env.BALANS_QA_OUTPUT, "rapporter.png"), fullPage: true });
    }
    result("R-04", "godkänt", ui);
  } else {
    result("R-04", "blockerat", { reason: "PLAYWRIGHT_MODULE saknas" });
  }

  const sie = await stem.send("GET", "/api/export/sie");
  const json = await stem.send("GET", "/api/export/json");
  const sieText = decodeSie(sie.bytes);
  const parsed = readSie(sieText);
  assert.deepEqual(parsed.periods, [["0", "20260101", "20261231"]]);
  assert.ok(parsed.openings.length > 0 && parsed.openings.every(([, amount]) => amount === 0));
  assert.deepEqual(parsed.exportedVouchers, actual);
  assert.deepEqual(nonzero(parsed.balances), totals);
  assert.deepEqual(vouchers(json.data), actual);
  assert.deepEqual(json.data.reports, report);
  const exportedInvoice = json.data.invoices.find((i) => i.id === invoice.id);
  assert.equal(exportedInvoice.total - exportedInvoice.paid, report.receivables);
  assert.ok(exportedInvoice.snapshot);
  assert.deepEqual(json.data.periods, final.periods);
  assert.ok(json.data.audit.some((item) => item.action === "voucher.reverse"));
  if (process.env.BALANS_QA_OUTPUT) {
    await writeFile(join(process.env.BALANS_QA_OUTPUT, "bokforing.se"), sie.bytes);
    await writeFile(join(process.env.BALANS_QA_OUTPUT, "bokforing-json.json"), json.bytes);
  }
  result("R-05", "godkänt", {
    sha256SIE: createHash("sha256").update(sie.bytes).digest("hex"),
    sha256JSON: createHash("sha256").update(json.bytes).digest("hex"),
    entries: sieText.split("\r\n").filter((r) => /^#(?:RAR|VER|UB|RES) /u.test(r)).filter((r) => !r.endsWith(" 0.00")),
    jsonVoucherNumbers: vouchers(json.data).map(([number]) => number),
  });
  assert.deepEqual(parsed.series, ["V"]);
  if (ui) {
    assert.deepEqual(ui.presentedNumbers, ["A1", "A2", "A3", "A4", "A5", "A6"]);
    result("R-06", "underkänt", { ledgerNumbers: ui.presentedNumbers, sieSeries: parsed.series,
      text: final.vouchers.find((v) => v.number === 5).text,
    });
  }

  const missingViews = ["vat", "general-ledger", "fixed-assets", "depreciation", "closing"];
  const statuses = [];
  for (const path of missingViews) {
    const response = await stem.send("GET", `/api/reports/${path}`, undefined, 404);
    statuses.push(response.status);
  }
  const nav = browser ? await openPage.locator("nav button").allTextContents() : [];
  assert.equal(final.accounts.find((account) => account.number === "1220"), undefined);
  assert.equal(final.accounts.find((account) => account.number === "7832"), undefined);
  const asset = await stem.send("POST", "/api/vouchers", {
    date: "2026-05-10", text: "Fiktiv maskin",
    lines: [{ account: "1220", debit: "20000" }, { account: "1930", credit: "20000" }],
  }, 400);
  result("R-07A", "funktion saknas", {
    reportKeys: Object.keys(report), missing: "momsperiod/momsrapport", probeStatus: statuses[0],
  });
  result("R-07B", "funktion saknas", {
    nav, missing: "huvudbok med kontofilter och löpande saldo", probeStatus: statuses[1],
  });
  result("R-07C", "funktion saknas", {
    missing: "anläggningsregister och avskrivningsplan", asset, has1220: false, has7832: false,
    probeStatuses: statuses.slice(2, 4),
  });
  result("R-07D", "funktion saknas", {
    missing: "årsbokslut", probeStatus: statuses[4],
  });

  const payment = final.vouchers.find((v) => v.number === 4);
  const reversePayment = await stem.send("POST", `/api/vouchers/${payment.id}/reverse`, {
    date: "2026-05-10", reason: "Testbetalningen kom aldrig in",
  }, 400);
  const manualReverse = (await stem.send("POST", "/api/vouchers", {
    date: "2026-05-10", text: "Manuell rättelse av testbetalningen",
    lines: [{ account: "1510", debit: "4000" }, { account: "1930", credit: "4000" }],
  })).data;
  const different = (await stem.state()).reports;
  assert.equal(different.receivables, 600000);
  assert.equal(different.trialBalance.find((a) => a.number === "1510").balance, 1000000);
  result("R-08", "underkänt", { reversePayment, manualReverse, balance1510: 1000000,
    dashboardReceivables: different.receivables,
  });

  annual = await setup("arsgranser");
  await annual.setCompany();
  const decemberCustomer = (await annual.send("POST", "/api/customers", fixture.customer)).data;
  const december = (await annual.send("POST", "/api/invoices", {
    ...fixture.invoice, customerId: decemberCustomer.id, date: "2026-12-31", dueDate: "2027-01-30",
  })).data;
  const inYear = await annual.send("POST", `/api/invoices/${december.id}/issue`, { version: 1 });
  for (const date of ["2025-12-31", "2027-01-01"])
    await annual.send("POST", "/api/vouchers", { ...fixture.opening, date }, 400);
  const carriedPayment = await annual.send("POST", `/api/invoices/${december.id}/payment`, {
    date: "2027-01-05", amount: "10000",
  }, 400);
  const newYear = await annual.setCompany({ fiscalStart: "2027-01-01", fiscalEnd: "2027-12-31" }, 400);
  assert.equal((await annual.state()).reports.receivables, 1000000);
  result("R-09", "godkänt", { jan1Accepted: true, dec31Issue: inYear, rejectedDays: ["2025-12-31", "2027-01-01"] });
  result("R-10", "funktion saknas", { carriedPayment, newYear, receivables: 1000000 });

  encoding = await setup("exportgranser");
  await encoding.setCompany({ fiscalEnd: "2030-12-31" });
  const fiveYears = (await encoding.send("POST", "/api/vouchers", { ...fixture.opening, date: "2030-12-01" })).data;
  const longYear = decodeSie((await encoding.send("GET", "/api/export/sie")).bytes)
    .split("\r\n").find((line) => line.startsWith("#RAR "));
  assert.equal(longYear, "#RAR 0 20260101 20301231");
  result("R-11", "underkänt", { settingAccepted: true, booked: fiveYears, longYear });

  const unicode = await encoding.send("POST", "/api/vouchers", {
    ...fixture.expense, date: "2026-08-12", text: "Fiktivt kontorsinköp 🧾",
  });
  const brokenSie = await encoding.send("GET", "/api/export/sie", undefined, 400);
  const intactJson = await encoding.send("GET", "/api/export/json");
  assert.match(brokenSie.data.error, /CP437/);
  assert.ok(intactJson.data.vouchers.some((v) => v.number === unicode.data.number && v.text.includes("🧾")));
  result("R-12", "underkänt", { unicodeVoucher: unicode.data, brokenSie, jsonStatus: intactJson.status });
} finally {
  await browser?.close();
  await encoding?.close();
  await annual?.close();
  await stem.close();
  await rm(cwd, { recursive: true, force: true });
}
