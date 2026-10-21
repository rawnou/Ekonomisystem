const root = document.querySelector("#app");
let session,
  state,
  page = "overview",
  busy = false,
  selectedBankId = null;
const pages = [
  ["overview", "Översikt", "◈"],
  ["invoices", "Fakturor", "▤"],
  ["customers", "Kunder", "♧"],
  ["ledger", "Bokföring", "▥"],
  ["bank", "Bank & import", "⇄"],
  ["documents", "Dokument", "▧"],
  ["reports", "Rapporter", "▦"],
  ["settings", "Inställningar", "⚙"],
];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
const money = (value) => {
  let n;
  try {
    n = BigInt(value ?? 0);
  } catch {
    return "—";
  }
  const sign = n < 0n ? "−" : "";
  if (n < 0n) n = -n;
  return (
    `${sign}${(n / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ,${(n % 100n).toString().padStart(2, "0")}`.replace(
      " ,",
      ",",
    ) + " kr"
  );
};
const canWrite = () => ["admin", "accountant"].includes(session?.user?.role);
const status = (s) =>
  `<span class="badge ${s === "draft" ? "neutral" : s === "issued" ? "warning" : ""}">${esc({ draft: "Utkast", issued: "Fastställd", partial: "Delbetald", paid: "Betald", credited: "Krediterad", credit: "Kreditfaktura" }[s] || s)}</span>`;
function notify(message, error = false) {
  const node = document.querySelector("#notice");
  node.textContent = message;
  node.className = `visible ${error ? "error" : ""}`;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    node.className = "";
    node.textContent = "";
  }, 7000);
}
async function api(path, method = "GET", data) {
  const headers = {};
  if (data !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = session?.csrf || "";
  }
  const response = await fetch(path, {
    method,
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      result.error || `Förfrågan misslyckades (${response.status}).`,
    );
  return result;
}
function field(label, name, type = "text", value = "", extra = "") {
  return `<label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
}
function select(label, name, options) {
  return `<label>${esc(label)}<select name="${name}">${options}</select></label>`;
}
function table(headers, rows, empty = "Det finns inga poster ännu.") {
  return `<div class="table-wrap"><table><thead><tr>${headers.map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
}
function card(title, body) {
  return `<section class="card"><h2>${title}</h2>${body}</section>`;
}
function submit(text = "Spara") {
  return `<div class="form-actions"><button type="submit">${text}</button></div>`;
}
function invoiceRows(list) {
  return list.map(
    (i) =>
      `<tr><td><strong>${esc(i.number || "Utkast")}</strong></td><td>${esc(i.customer_name || state.customers.find((c) => c.id === i.customer_id)?.name || "—")}</td><td>${esc(i.due_date)}</td><td>${status(i.status)}</td><td class="right">${money(i.total)}</td><td><div class="row-actions">${i.status !== "draft" ? `<a class="button secondary small" href="/api/invoices/${encodeURIComponent(i.id)}/pdf" target="_blank" rel="noopener">PDF</a>` : ""}${canWrite() && i.status === "draft" ? `<button class="small" data-action="issue" data-id="${esc(i.id)}">Fastställ</button>` : ""}${canWrite() && ["issued", "partial"].includes(i.status) && !i.original_id ? `<button class="small secondary" data-action="payment" data-id="${esc(i.id)}">Betalning</button>${BigInt(i.paid || 0) === 0n ? `<button class="small danger" data-action="credit" data-id="${esc(i.id)}">Kreditera</button>` : ""}` : ""}</div></td></tr>`,
  );
}
function overview() {
  const r = state.reports || {};
  const metrics = [
    ["Intäkter", r.income, "Samtliga bokförda perioder"],
    ["Kostnader", r.expenses, "Samtliga bokförda perioder"],
    ["Resultat", r.result, "Intäkter minus kostnader"],
    ["Att få betalt", r.receivables, "Saldo på kundfordringar"],
  ];
  let monthly = r.monthly || [];
  let max = monthly.reduce(
    (m, v) =>
      [v.income, v.expenses].reduce(
        (a, b) => (BigInt(b || 0) > a ? BigInt(b || 0) : a),
        m,
      ),
    1n,
  );
  const height = (n) =>
    Number(((BigInt(n || 0) < 0n ? 0n : BigInt(n || 0)) * 145n) / max);
  return `<div class="metrics">${metrics.map((m, i) => `<section class="card ${i === 2 ? "metric-accent" : ""}"><div class="metric-title">${m[0]} <span>${["↗", "↙", "◈", "◷"][i]}</span></div><div class="metric-value">${money(m[1])}</div><div class="metric-note">${m[2]}</div></section>`).join("")}</div><div class="grid-two"><section class="card"><div class="card-head"><h2>Så går verksamheten</h2><div class="legend"><span>Intäkter</span><span>Kostnader</span></div></div>${monthly.length ? `<div class="chart" role="img" aria-label="Månadsvis bokförda intäkter och kostnader">${monthly.map((m) => `<div class="chart-month"><div class="bars"><svg class="chart-svg" viewBox="0 0 40 155" role="img" aria-label="${esc(m.month)}: intäkter ${money(m.income)}, kostnader ${money(m.expenses)}"><rect class="chart-income" x="1" y="${155 - height(m.income)}" width="17" height="${height(m.income)}" rx="3"/><rect class="chart-expense" x="22" y="${155 - height(m.expenses)}" width="17" height="${height(m.expenses)}" rx="3"/></svg></div><span class="chart-label">${esc(m.month.slice(-2))}</span></div>`).join("")}</div>` : '<div class="empty">Diagrammet fylls på när du bokför din första verifikation.</div>'}<p class="chart-note">Baserat på bokförda verifikationer · belopp i SEK</p></section><section class="card"><h2>Nästa steg, enkelt.</h2><p class="subtitle">Håll ordning på företagets vardag.</p>${canWrite() ? '<button class="action-link" data-page="invoices">Skapa en faktura <span>↗</span></button><button class="action-link" data-page="bank">Importera transaktioner <span>↗</span></button><button class="action-link" data-page="documents">Lägg till ett underlag <span>↗</span></button>' : ""}<div class="callout">Lokal arbetsmiljö med syntetiska data. Ingen bankanslutning eller betalningsöverföring.</div></section></div>${dashboardDetails()}<section class="card"><div class="card-head"><h2>Senaste fakturorna</h2><button class="secondary small" data-page="invoices">Visa alla →</button></div>${table(["Faktura", "Kund", "Förfallodatum", "Status", "Belopp", ""], invoiceRows([...state.invoices].sort((a, b) => b.id - a.id).slice(0, 5)), "Inga fakturor ännu. Skapa en kund och din första faktura. ")}</section>`;
}
function invoices() {
  return `<div class="stack">${canWrite() ? card("Ny kundfaktura", `<form data-form="invoice"><div class="form-grid">${select("Kund", "customerId", '<option value="">Välj kund</option>' + state.customers.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join(""))}${field("Beskrivning", "description", "text", "", 'required maxlength="500"')}${field("Fakturadatum", "date", "date", today(), "required")}${field("Förfallodatum", "dueDate", "date", today(), "required")}${field("Antal", "quantity", "text", "1", 'required inputmode="decimal"')}${field("Pris per styck exkl. moms (SEK)", "unitPrice", "text", "", 'required inputmode="decimal"')}${select("Moms", "vatRate", '<option value="25">25 % · svensk försäljning</option>')}</div><p class="help">Utkastet får fakturanummer och bokförs när du väljer Fastställ. Det här fakturaflödet stöder svenska tjänster med 25 % moms. Utlandsförsäljning hanteras manuellt.</p>${submit("Spara utkast")}</form>`) : ""}${card("Alla fakturor", table(["Nummer", "Kund", "Förfallodatum", "Status", "Belopp", "Åtgärder"], invoiceRows([...state.invoices].sort((a, b) => b.id - a.id))))}</div>`;
}
function customers() {
  return `<div class="stack">${canWrite() ? card("Lägg till kund", `<form data-form="customer"><div class="form-grid">${field("Företagsnamn", "name", "text", "", "required")}${field("Organisationsnummer", "orgNumber")}${field("E-post", "email", "email")}${field("Adress", "address")}</div>${submit("Lägg till kund")}</form>`) : ""}${card(
    "Kundregister",
    table(
      ["Namn", "Organisationsnummer", "E-post", "Adress"],
      state.customers.map(
        (c) =>
          `<tr><td><strong>${esc(c.name)}</strong></td><td>${esc(c.org_number)}</td><td>${esc(c.email)}</td><td>${esc(c.address)}</td></tr>`,
      ),
    ),
  )}</div>`;
}
function accountOptions(excluded = []) {
  return (
    '<option value="">Välj konto</option>' +
    state.accounts
      .filter((a) => !excluded.includes(String(a.number)))
      .map(
        (a) =>
          `<option value="${esc(a.number)}">${esc(a.number)} · ${esc(a.name)}</option>`,
      )
      .join("")
  );
}
function ledger() {
  return `<div class="stack">${canWrite() ? card("Ny manuell verifikation", `<form data-form="voucher"><div class="form-grid">${field("Bokföringsdatum", "date", "date", today(), "required")}${field("Beskrivning", "text", "text", "", "required")}${select("Underlag (valfritt)", "documentId", '<option value="">Inget underlag</option>' + state.documents.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join(""))}</div><p class="help">Ange positiva belopp i antingen debet eller kredit. Summorna måste vara lika.</p><div id="voucher-lines">${voucherLine()}${voucherLine()}</div><button class="secondary small" type="button" data-action="add-line">+ Lägg till rad</button>${submit("Bokför verifikation")}</form>`) : ""}${card(
    "Verifikationer",
    table(
      ["Nummer", "Datum", "Beskrivning", "Kontering", ""],
      [...state.vouchers]
        .sort((a, b) => b.number - a.number)
        .map(
          (v) =>
            `<tr><td><strong>A${esc(v.number)}</strong></td><td>${esc(v.date)}</td><td>${esc(v.text)}</td><td>${(v.lines || []).map((l) => `${esc(l.account)}: D ${money(l.debit)} / K ${money(l.credit)}`).join("<br>")}</td><td>${canWrite() ? `<button class="small danger" data-action="reverse" data-id="${esc(v.id)}">Motboka</button>` : ""}</td></tr>`,
        ),
    ),
  )}</div>`;
}
function voucherLine() {
  return `<div class="line-entry"><select name="account" aria-label="Konto" required>${accountOptions()}</select><input name="debit" placeholder="Debet" aria-label="Debet i kronor" inputmode="decimal" value="0"><input name="credit" placeholder="Kredit" aria-label="Kredit i kronor" inputmode="decimal" value="0"><button type="button" class="small secondary" data-action="remove-line" aria-label="Ta bort konteringsrad">×</button></div>`;
}
function bank() {
  return `<div class="stack">${canWrite() ? `<div class="grid-two">${card("Importera CSV", `<form data-form="import"><div class="form-grid">${select("Källa", "source", '<option value="bank">Bank</option><option value="kdp">Amazon KDP</option><option value="adtraction">Adtraction</option>')}<label>CSV-fil<input type="file" name="file" accept=".csv,text/csv"></label><label class="wide">CSV-innehåll<textarea name="csv" placeholder="date,description,amount,currency,reference"></textarea></label></div><details class="section-space"><summary>Anpassa fältmappning</summary><p class="help">Ange dina exakta CSV-rubriker. Lämna tomt för automatisk igenkänning.</p><div class="form-grid">${field("Datumkolumn", "map_date")}${field("Beskrivningskolumn", "map_description")}${field("Beloppskolumn", "map_amount")}${field("Valutakolumn", "map_currency")}${field("Referenskolumn", "map_reference")}${field("Rapportperiodkolumn", "map_period")}</div></details><p class="help">Standardkolumner: date, description, amount, currency, reference. Datum YYYY-MM-DD. Belopp i originalvaluta. Importer är underlag och bokförs inte automatiskt.</p>${submit("Importera transaktioner")}</form>`)}${card("Manuell bankhändelse", `<form data-form="bank"><div class="form-grid">${field("Datum", "date", "date", today(), "required")}${field("Beskrivning", "description", "text", "", "required")}${field("Belopp · minus för utbetalning", "amount", "text", "", 'required inputmode="decimal"')}${field("Valuta", "currency", "text", "SEK", 'required maxlength="3"')}${field("Referens", "reference")}</div>${submit("Registrera händelse")}</form>`)}</div>` : ""}<div class="callout">Utlandsmoms och omräkning till SEK kräver manuell bedömning. Importer registrerar originalbelopp och valuta; bokför vid behov en separat verifikation med kontrollerat SEK-belopp.</div>${bankClassification()}${card(
    "Bank- och importhändelser",
    table(
      [
        "Datum",
        "Beskrivning",
        "Originalbelopp",
        "Valuta",
        "Referens",
        "Status",
      ],
      [...state.bank]
        .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
        .map(
          (b) =>
            `<tr><td>${esc(b.date)}</td><td>${esc(b.description)}</td><td>${money(b.amount).replace(" kr", "")}</td><td>${esc(b.currency)}</td><td>${esc(b.reference)}</td><td>${b.voucher_id ? `<span class="badge">Bokförd</span>` : canWrite() && b.source === "bank" ? `<button class="small secondary" data-action="classify" data-id="${esc(b.id)}">Klassificera</button>` : `<span class="badge warning">Manuell granskning</span>`}</td></tr>`,
        ),
    ),
  )}${card(
    "Importhistorik",
    table(
      ["Tid", "Källa", "Rader", "Kontrollsumma"],
      [...(state.imports || [])]
        .sort((a, b) => b.id - a.id)
        .map(
          (i) =>
            `<tr><td>${esc(i.created_at)}</td><td>${esc(i.source)}</td><td>${esc(i.rows ?? "—")}</td><td>${esc(i.hash?.slice(0, 12) || "—")}</td></tr>`,
        ),
    ),
  )}</div>`;
}
function documents() {
  return `<div class="stack">${canWrite() ? card("Spara underlag", `<form data-form="document"><div class="form-grid"><label>PDF, PNG eller JPEG<input type="file" name="file" accept="application/pdf,image/png,image/jpeg" required></label>${field("Namn (valfritt)", "name")}${select("Ny version av (valfritt)", "previousId", '<option value="">Nytt dokument</option>' + state.documents.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join(""))}</div><p class="help">Spara endast syntetiska underlag i den här miljön. Underlag lagras lokalt med kontrollsumma.</p>${submit("Ladda upp underlag")}</form>`) : ""}${card(
    "Dokumentarkiv",
    '<label class="document-search">Sök underlag<input type="search" name="documentSearch" placeholder="Sök på dokumentnamn"></label>' +
      table(
        ["Namn", "Typ", "Sparat", "Kontrollsumma", ""],
        state.documents.map(
          (d) =>
            `<tr data-doc-name="${esc(d.name.toLocaleLowerCase("sv-SE"))}"><td>${esc(d.name)}</td><td>${esc(d.type)}</td><td>${esc(d.created_at)}</td><td title="${esc(d.hash)}">${esc(d.hash?.slice(0, 12))}…</td><td><a class="button secondary small" href="/api/documents/${encodeURIComponent(d.id)}" target="_blank" rel="noopener">Öppna</a></td></tr>`,
        ),
      ),
  )}</div>`;
}
function reports() {
  const r = state.reports || {};
  return `<div class="stack"><div class="grid-two">${card(
    "Resultaträkning",
    table(
      ["Konto", "Benämning", "Saldo"],
      (r.profitLoss || []).map(
        (a) =>
          `<tr><td>${esc(a.number)}</td><td>${esc(a.name)}</td><td class="right">${money(a.balance)}</td></tr>`,
      ),
    ) +
      `<div class="status-line"><strong>Årets resultat</strong><strong>${money(r.result)}</strong></div>`,
  )}${card("Balansöversikt", `<div class="status-line"><span>Tillgångar</span><strong>${money(r.balance?.assets)}</strong></div><div class="status-line"><span>Skulder</span><strong>${money(r.balance?.liabilities)}</strong></div><div class="status-line"><span>Eget kapital inkl. resultat</span><strong>${money(r.balance?.equity)}</strong></div><div class="status-line"><span>Bankkonto, 1930</span><strong>${money(r.cash)}</strong></div><p class="help">Årets resultat redovisas separat ovan. Kontrollera rapporterna med redovisningskunnig före deklaration.</p>`)}</div>${card(
    "Saldobalans",
    table(
      ["Konto", "Benämning", "Saldo"],
      (r.trialBalance || []).map(
        (a) =>
          `<tr><td>${esc(a.number)}</td><td>${esc(a.name)}</td><td class="right">${money(a.balance)}</td></tr>`,
      ),
    ),
  )}${session.user.role === "admin" ? card("Exportera bokföring", '<p class="help">Exporterna innehåller företagets bokföringsdata. Förvara dem på en säker lokal plats.</p><div class="form-actions"><a class="button" href="/api/export/sie">Hämta SIE</a><a class="button secondary" href="/api/export/json">Hämta JSON</a></div>') : ""}</div>`;
}
function settings() {
  const c = state.company || {};
  return `<div class="stack">${
    session.user.role === "admin"
      ? card(
          "Företagsuppgifter",
          `<form data-form="company"><div class="form-grid">${field("Företagsnamn", "name", "text", c.name, "required")}${field("Organisationsnummer", "orgNumber", "text", c.org_number)}${field("Momsregistreringsnummer", "vatNumber", "text", c.vat_number)}${field("Adress", "address", "text", c.address)}${field("Bank / betalningsuppgift", "bank", "text", c.bank)}${field("Räkenskapsårets början", "fiscalStart", "date", c.fiscal_start, "required")}${field("Räkenskapsårets slut", "fiscalEnd", "date", c.fiscal_end, "required")}<label class="checkbox"><input type="checkbox" name="fTax" ${c.f_tax ? "checked" : ""}>Godkänd för F-skatt</label></div>${submit("Spara företagsuppgifter")}</form>`,
        ) +
        card(
          "Lås bokföringsperiod",
          `<p class="help">Låsningen hindrar ny bokföring och rättelser på eller före valt datum. Åtgärden kan inte ångras i gränssnittet.</p><form data-form="lock"><div class="form-grid">${field("Lås till och med", "through", "date", "", "required")}</div>${submit("Lås period")}</form><p class="help">Låst till och med: ${esc(
            (state.periods || [])
              .map((p) => p.through)
              .sort()
              .at(-1) || "Ingen period låst",
          )}</p>`,
        )
      : card(
          "Företag",
          `<p>${esc(c.name)}</p><p class="help">Endast administratör kan ändra företagsuppgifter och låsa perioder.</p>`,
        )
  }${card(
    "Behandlingshistorik",
    table(
      ["Tid", "Händelse", "Användare"],
      [...(state.audit || [])]
        .sort((a, b) => b.id - a.id)
        .slice(0, 100)
        .map(
          (a) =>
            `<tr><td>${esc(a.created_at)}</td><td>${esc(a.action)}</td><td>${esc(a.actor_name ?? a.actor ?? a.user_id)}</td></tr>`,
        ),
    ),
  )}</div>`;
}
function render() {
  if (!session?.user) {
    root.innerHTML = `<main class="login"><div class="brand"><span class="brand-mark">≋</span>balans</div><section class="card"><div class="eyebrow">Ditt företags ekonomi</div><h1>Välkommen tillbaka.</h1><p class="subtitle">Logga in till din lokala arbetsplats.</p><form data-form="login"><div class="form-grid">${field("E-post", "email", "email", "", 'required autocomplete="username"')}${field("Lösenord", "password", "password", "", 'required autocomplete="current-password"')}</div>${submit("Logga in →")}</form></section><p class="login-footer"><span class="local-dot"></span>Lokal miljö · Endast syntetiska data<br>Använd kontouppgifterna från den lokala installationen.</p></main>`;
    return;
  }
  const selected = pages.find((p) => p[0] === page);
  root.innerHTML = `<div class="layout"><aside class="sidebar"><div class="brand"><span class="brand-mark">≋</span><div>balans<small>EKONOMI I ORDNING</small></div></div><div class="company-name">${esc(state.company?.name || "Mitt aktiebolag")}</div><nav class="nav" aria-label="Huvudnavigation">${pages.map((p) => `<button data-page="${p[0]}" class="${page === p[0] ? "active" : ""}" ${page === p[0] ? 'aria-current="page"' : ""}><span class="nav-icon">${p[2]}</span>${p[1]}</button>`).join("")}</nav><div class="sidebar-footer"><span class="local-dot"></span>Lokalt & syntetiskt<br>Din ekonomi, på din dator.</div></aside><main class="main"><header class="topbar"><div class="crumb">Arbetsplats <span aria-hidden="true">/</span> ${selected[1]}</div><div class="user"><span class="badge neutral">${esc(session.user.role)}</span><span class="avatar">${esc(session.user.name?.slice(0, 1) || "A")}</span><span class="user-name">${esc(session.user.name)}</span><button class="small secondary" data-action="logout">Logga ut</button></div></header><div class="content"><div class="page-heading"><div><div class="eyebrow">${page === "overview" ? "En sak mindre att tänka på" : "Balans · " + selected[1]}</div><h1>${page === "overview" ? "En tydlig bild av din ekonomi." : selected[1]}</h1><p class="subtitle">${page === "overview" ? "Välkommen tillbaka. Här är läget i ditt företag." : "Samla, hantera och följ upp företagets " + { invoices: "fakturor", customers: "kunder", ledger: "bokföring", bank: "transaktioner", documents: "underlag", reports: "rapporter", settings: "uppgifter" }[page] + "."}</p></div><span class="badge neutral">SEK · ${esc(state.company?.fiscal_start?.slice(0, 4) || new Date().getFullYear())}</span></div>${{ overview, invoices, customers, ledger, bank, documents, reports, settings }[page]()}<p class="footer-note">Balans · Lokalt ekonomisystem · Endast syntetiska data.</p></div></main></div>`;
}
async function refresh() {
  state = await api("/api/state");
  for (const key of [
    "accounts",
    "customers",
    "invoices",
    "vouchers",
    "bank",
    "imports",
    "documents",
    "periods",
    "audit",
  ])
    state[key] ||= [];
  render();
}
root.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const form = event.target;
  const type = form.dataset.form;
  if (!type) return;
  const data = Object.fromEntries(new FormData(form));
  const button = form.querySelector("[type=submit]");
  busy = true;
  if (button) button.disabled = true;
  try {
    if (type === "login") {
      session = await api("/api/login", "POST", data);
      if (!session.user) session = await api("/api/session");
      await refresh();
      return;
    }
    let path,
      method = "POST",
      payload = data;
    if (type === "customer") path = "/api/customers";
    if (type === "invoice") path = "/api/invoices";
    if (type === "bank") path = "/api/bank";
    if (type === "bank-book") {
      path = "/api/bank/" + encodeURIComponent(selectedBankId) + "/book";
      payload = {
        account: data.account,
        exchangeRate: data.exchangeRate,
        reviewed: form.elements.reviewed.checked,
      };
    }
    if (type === "voucher") {
      path = "/api/vouchers";
      payload = {
        date: data.date,
        text: data.text,
        lines: [...form.querySelectorAll(".line-entry")].map((row) => ({
          account: row.querySelector("[name=account]").value,
          debit: row.querySelector("[name=debit]").value,
          credit: row.querySelector("[name=credit]").value,
        })),
      };
      if (data.documentId) payload.documentId = data.documentId;
    }
    if (type === "company") {
      path = "/api/company";
      method = "PUT";
      payload = {
        ...data,
        fTax: form.elements.fTax.checked,
        version: state.company.version,
      };
    }
    if (type === "lock") {
      if (
        !confirm(
          `Lås bokföringen till och med ${data.through}? Det kan inte ångras i gränssnittet.`,
        )
      )
        return;
      path = "/api/periods/lock";
    }
    if (type === "import") {
      path = "/api/imports";
      payload = {
        source: data.source,
        csv: data.csv || (await data.file.text()),
        mapping: Object.fromEntries(
          Object.entries(data)
            .filter(([key, value]) => key.startsWith("map_") && value)
            .map(([key, value]) => [key.slice(4), value]),
        ),
      };
    }
    if (type === "document") {
      const file = data.file;
      if (file.size > 5_000_000)
        throw new Error("Filen är för stor. Välj ett underlag på högst 5 MB.");
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("Kunde inte läsa filen."));
        reader.readAsDataURL(file);
      });
      path = "/api/documents";
      payload = { name: data.name || file.name, type: file.type, data: base64 };
      if (data.previousId) payload.previousId = data.previousId;
    }
    const result = await api(path, method, payload);
    selectedBankId = null;
    await refresh();
    if (type === "import") {
      notify(
        `Import klar: ${result.inserted ?? 0} nya transaktioner, ${result.duplicates ?? 0} dubbletter.`,
      );
      return;
    }
    if (type === "bank") {
      notify(
        result.inserted
          ? "Bankhändelsen är registrerad."
          : "Dubblett: bankhändelsen finns redan. Ingen ny händelse skapades.",
      );
      return;
    }
    notify(
      type === "invoice"
        ? "Utkastet är sparat. Fastställ när det är klart."
        : "Uppgifterna är sparade.",
    );
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    if (button) button.disabled = false;
  }
});
root.addEventListener("click", async (event) => {
  const nav = event.target.closest("[data-page]");
  if (nav) {
    page = nav.dataset.page;
    render();
    return;
  }
  const button = event.target.closest("[data-action]");
  if (!button || busy) return;
  const action = button.dataset.action,
    id = button.dataset.id;
  if (action === "classify") {
    selectedBankId = id;
    render();
    document
      .querySelector("#classification")
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (action === "remove-line") {
    if (document.querySelectorAll(".line-entry").length > 2)
      button.closest(".line-entry").remove();
    else notify("En verifikation behöver minst två rader.", true);
    return;
  }
  if (action === "add-line") {
    document
      .querySelector("#voucher-lines")
      .insertAdjacentHTML("beforeend", voucherLine());
    return;
  }
  busy = true;
  button.disabled = true;
  try {
    if (action === "logout") {
      await api("/api/logout", "POST", {});
      session = null;
      state = null;
      selectedBankId = null;
      page = "overview";
      render();
      return;
    }
    let payload, path;
    if (action === "issue") {
      const invoice = state.invoices.find((i) => String(i.id) === id);
      if (
        !confirm(
          "Fastställ fakturan och bokför den? Fakturan kan sedan endast rättas genom kreditering.",
        )
      )
        return;
      payload = { version: invoice.version };
      path = `/api/invoices/${encodeURIComponent(id)}/issue`;
    }
    if (action === "payment") {
      const invoice = state.invoices.find((i) => String(i.id) === id);
      const remaining = BigInt(invoice.total) - BigInt(invoice.paid || 0);
      const amount = prompt(
        "Betalt belopp i SEK:",
        `${remaining / 100n},${(remaining % 100n).toString().padStart(2, "0")}`,
      );
      if (amount === null) return;
      const date = prompt("Betalningsdatum (YYYY-MM-DD):", today());
      if (!date) return;
      payload = { amount, date };
      path = `/api/invoices/${encodeURIComponent(id)}/payment`;
    }
    if (action === "credit") {
      const date = prompt("Datum för full kreditering (YYYY-MM-DD):", today());
      if (!date) return;
      payload = { date };
      path = `/api/invoices/${encodeURIComponent(id)}/credit`;
    }
    if (action === "reverse") {
      const reason = prompt("Ange skäl till motbokningen:");
      if (!reason) return;
      const date = prompt("Motbokningsdatum (YYYY-MM-DD):", today());
      if (!date) return;
      payload = { reason, date };
      path = `/api/vouchers/${encodeURIComponent(id)}/reverse`;
    }
    await api(path, "POST", payload);
    await refresh();
    notify("Åtgärden är genomförd och sparad.");
  } catch (error) {
    notify(error.message, true);
  } finally {
    busy = false;
    button.disabled = false;
  }
});
try {
  session = await api("/api/session");
  if (session.user) await refresh();
  else render();
} catch (error) {
  render();
  notify(error.message, true);
}

function bankClassification() {
  if (!canWrite()) return "";
  const b = state.bank.find((b) => String(b.id) === String(selectedBankId));
  if (!b) return "";
  return `<section class="card" id="classification"><h2>Klassificera bankhändelse</h2><p class="help">${esc(b.date)} · ${esc(b.description)} · ${money(b.amount).replace(" kr", "")} ${esc(b.currency)}</p><form data-form="bank-book"><div class="form-grid">${select("Motkonto", "account", accountOptions(["1930", "1510"]))}${field("Växelkurs · SEK per valutaenhet", "exchangeRate", "text", b.currency === "SEK" ? "1" : "", 'required inputmode="decimal"')}<label class="checkbox wide"><input type="checkbox" name="reviewed" required>Jag har granskat kontering, belopp, växelkurs och moms. Eventuell moms bokförs separat.</label></div><p class="help">Händelsen bokförs mot bankkonto 1930. Kundbetalningar registreras via fakturans knapp Betalning så att kundfordran stäms av.</p>${submit("Bokför bankhändelse")}</form></section>`;
}

root.addEventListener("input", (event) => {
  if (event.target.name !== "documentSearch") return;
  const query = event.target.value.toLocaleLowerCase("sv-SE");
  for (const row of root.querySelectorAll("[data-doc-name]"))
    row.hidden = !row.dataset.docName.includes(query);
});

function sourceAmounts(source) {
  const totals = new Map();
  for (const entry of state.bank.filter((entry) => entry.source === source)) {
    const currency = entry.currency || "SEK";
    totals.set(
      currency,
      (totals.get(currency) || 0n) +
        BigInt(entry.original_amount ?? entry.amount),
    );
  }
  return (
    [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([currency, amount]) =>
          `<div class="status-line"><span>${esc(currency)}</span><strong>${money(amount).replace(" kr", "")} ${esc(currency)}</strong></div>`,
      )
      .join("") || '<p class="help">Ingen rapport importerad ännu.</p>'
  );
}

function dashboardDetails() {
  const tasks = [
    [
      "Utkast att fastställa",
      state.invoices.filter((i) => i.status === "draft").length,
      "invoices",
    ],
    [
      "Obetalda fakturor",
      state.invoices.filter((i) => ["issued", "partial"].includes(i.status))
        .length,
      "invoices",
    ],
    [
      "Bankhändelser att klassificera",
      state.bank.filter((b) => b.source === "bank" && !b.voucher_id).length,
      "bank",
    ],
    [
      "Rapportposter att granska manuellt",
      state.bank.filter((b) => b.source !== "bank" && !b.voucher_id).length,
      "bank",
    ],
  ];
  const recent = [...state.bank]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, 5);
  return `<div class="grid-two dashboard-details"><section class="card"><h2>Rapporterade originalbelopp</h2><p class="help">Importerade rapportbelopp från respektive källa. Beloppen är inte bokförda intäkter och visas separat per valuta.</p><div class="source-columns"><div><h3>Amazon KDP</h3>${sourceAmounts("kdp")}</div><div><h3>Adtraction</h3>${sourceAmounts("adtraction")}</div></div></section><section class="card"><h2>Att ta hand om</h2>${tasks.map(([label, count, target]) => `<button class="task-row" data-page="${target}"><span>${label}</span><span class="badge ${count ? "warning" : "neutral"}">${count}</span></button>`).join("")}</section></div><section class="card dashboard-details"><div class="card-head"><h2>Senaste bankhändelserna</h2><button class="secondary small" data-page="bank">Visa alla →</button></div>${table(
    ["Datum", "Beskrivning", "Källa", "Originalbelopp", "Status"],
    recent.map(
      (b) =>
        `<tr><td>${esc(b.date)}</td><td>${esc(b.description)}</td><td>${esc({ bank: "Bank", kdp: "Amazon KDP", adtraction: "Adtraction" }[b.source] || b.source)}</td><td>${money(b.original_amount ?? b.amount).replace(" kr", "")} ${esc(b.currency)}</td><td><span class="badge ${b.voucher_id ? "" : "warning"}">${b.voucher_id ? "Bokförd" : b.source === "bank" ? "Att klassificera" : "Manuell granskning"}</span></td></tr>`,
    ),
  )}</section>`;
}
