import hashlib
import json
import os
import re
from pathlib import Path
import secrets
import shutil
import socket
import sqlite3
import subprocess
import tempfile

from playwright.sync_api import expect, sync_playwright


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DATA = json.loads((HERE / "testdata.json").read_text())
COST_TEXT = DATA["voucher"]["text"]


def local_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def seed(path):
    users = [dict(user, password=secrets.token_urlsafe(24)) for user in DATA["users"]]
    subprocess.run(
        ["node", "--input-type=module", "-e", """
import { readFileSync } from "node:fs";
import { Store } from "./src/domain.mjs";
const store = new Store(process.argv[1]);
store.seed(JSON.parse(readFileSync(0, "utf8")));
store.close();
""", str(path)],
        cwd=REPO, input=json.dumps(users), text=True, check=True,
    )
    return users


class Server:
    def __init__(self, directory, database, port):
        self.directory = directory
        self.env = {**os.environ, "DATABASE_PATH": str(database), "PORT": str(port)}
        self.origin = f"http://127.0.0.1:{port}"
        self.process = None

    def start(self):
        self.process = subprocess.Popen(
            ["node", str(REPO / "src/server.mjs")], cwd=self.directory, env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        startup = []
        for line in self.process.stdout:
            startup.append(line.strip())
            if line.startswith("Ekonomisystem lokalt:"):
                return startup
        raise RuntimeError(f"Serverstart misslyckades: {startup}")

    def stop(self):
        if self.process is not None:
            self.process.terminate()
            self.process.communicate(timeout=20)
            assert self.process.returncode == 0
            self.process = None

    def backup_cli(self, *args, expected=0):
        proc = subprocess.run(
            ["node", str(REPO / "scripts/backup.mjs"), *map(str, args)],
            env=self.env, cwd=self.directory, capture_output=True, text=True, timeout=30,
        )
        if expected == 0:
            assert proc.returncode == 0, proc.stderr
            return "\n".join(line for line in proc.stdout.strip().splitlines() if line)
        assert proc.returncode != 0
        return proc.stderr


def receipt(path):
    # Generate a one-page PDF with valid object offsets and a fictional receipt line.
    content = f"BT /F1 12 Tf 40 110 Td ({DATA['receipt']['text']}) Tj ET\n".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 160] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n"
        + content + b"endstream",
    ]
    pdf = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, payload in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{number} 0 obj\n".encode() + payload + b"\nendobj\n")
    xref = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        pdf.extend(f"{offset:010} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    path.write_bytes(pdf)
    return bytes(pdf)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def navigate(page, name, heading):
    page.locator(f"nav [data-page={name}]").click()
    expect(page.get_by_role("heading", level=1)).to_have_text(heading)


def fill_form(form, values):
    for name, value in values.items():
        control = form.locator(f"[name={name}]")
        if isinstance(value, bool):
            control.set_checked(value)
        else:
            control.fill(str(value))


def login(browser, origin, user):
    context = browser.new_context()
    page = context.new_page()
    page.goto(origin)
    fill_form(page.locator("form[data-form=login]"), {
        "email": user["email"],
        "password": user["password"],
    })
    page.get_by_role("button", name="Logga in").click()
    expect(page.locator(".user-name")).to_have_text(user["name"])
    expect(page.locator(".user .badge")).to_have_text(user["role"])
    return page


def api(context, origin, path, method="GET", data=None):
    options = {"method": method}
    if data is not None:
        session = context.request.get(origin + "/api/session").json()
        options.update(
            data=data,
            headers={
                "Origin": origin,
                "X-CSRF-Token": session["csrf"],
                "Content-Type": "application/json",
            },
        )
    return context.request.fetch(origin + path, **options)


def state(page, origin):
    response = api(page.context, origin, "/api/state")
    assert response.status == 200
    return response.json()


def submit(page, form, expected_notice):
    form.get_by_role("button", name=expected_notice[0]).click()
    expect(page.locator("#notice")).to_have_text(expected_notice[1])


def update_company(page, bank):
    navigate(page, "settings", "Inställningar")
    form = page.locator("form[data-form=company]")
    fill_form(form, {**DATA["company"], "bank": bank})
    submit(page, form, ("Spara företagsuppgifter", "Uppgifterna är sparade."))


def role_matrix(page, origin, company, document_id, invoice_id, voucher_id):
    results = {}
    for key, method, path, body, expected in [
        ("läs företag och rapporter", "GET", "/api/state", None, 200),
        ("läs kvitto", "GET", f"/api/documents/{document_id}", None, 200),
        ("läs faktura-PDF", "GET", f"/api/invoices/{invoice_id}/pdf", None, 200),
        ("ändra företag", "PUT", "/api/company", company, 403),
        ("lås period", "POST", "/api/periods/lock", {"through": "2026-10-31"}, 403),
        ("SIE", "GET", "/api/export/sie", None, 403),
        ("JSON", "GET", "/api/export/json", None, 403),
        *([] if page.locator(".user .badge").inner_text() == "accountant" else [
            ("skapa kund", "POST", "/api/customers", DATA["customer"], 403),
            ("spara utkast", "POST", "/api/invoices", {"customerId": 1, **DATA["invoice"]}, 403),
            ("registrera betalning", "POST", f"/api/invoices/{invoice_id}/payment",
             {"date": "2026-11-05", "amount": "100.00"}, 403),
            ("kreditera faktura", "POST", f"/api/invoices/{invoice_id}/credit",
             {"date": "2026-11-05"}, 403),
            ("bokför verifikation", "POST", "/api/vouchers",
             {**DATA["voucher"], "documentId": document_id}, 403),
            ("motboka verifikation", "POST", f"/api/vouchers/{voucher_id}/reverse",
             {"date": "2026-11-05", "reason": "Fiktiv rättelse"}, 403),
        ])
    ]:
        response = api(page.context, origin, path, method, body)
        assert response.status == expected, (method, path, response.status)
        results[key] = response.status
    return results


def prove_roles_and_history(server, browser, users, receipt_path, result):
    origin = server.origin
    admin, bookkeeper, viewer = [login(browser, origin, user) for user in users]
    update_company(admin, "Fiktivbank A")

    navigate(bookkeeper, "customers", "Kunder")
    form = bookkeeper.locator("form[data-form=customer]")
    fill_form(form, DATA["customer"])
    submit(bookkeeper, form, ("Lägg till kund", "Uppgifterna är sparade."))
    expect(bookkeeper.get_by_role("cell", name=DATA["customer"]["name"])).to_be_visible()

    navigate(bookkeeper, "documents", "Dokument")
    form = bookkeeper.locator("form[data-form=document]")
    form.locator("[name=file]").set_input_files(receipt_path)
    fill_form(form, {"name": DATA["receipt"]["name"]})
    submit(bookkeeper, form, ("Ladda upp underlag", "Uppgifterna är sparade."))
    document_id = state(bookkeeper, origin)["documents"][0]["id"]

    navigate(bookkeeper, "ledger", "Bokföring")
    form = bookkeeper.locator("form[data-form=voucher]")
    fill_form(form, {field: DATA["voucher"][field] for field in ("date", "text")})
    form.locator("[name=documentId]").select_option(str(document_id))
    form.get_by_role("button", name="Lägg till rad").click()
    for row, line in zip(form.locator(".line-entry").all(), DATA["voucher"]["lines"], strict=True):
        row.locator("[name=account]").select_option(line["account"])
        fill_form(row, {field: line.get(field, "0") for field in ("debit", "credit")})
    submit(bookkeeper, form, ("Bokför verifikation", "Uppgifterna är sparade."))
    expect(bookkeeper.get_by_role("cell", name=COST_TEXT)).to_be_visible()

    navigate(bookkeeper, "invoices", "Fakturor")
    form = bookkeeper.locator("form[data-form=invoice]")
    form.locator("[name=customerId]").select_option(label=DATA["customer"]["name"])
    fill_form(form, {key: value for key, value in DATA["invoice"].items() if key != "vatRate"})
    submit(bookkeeper, form, ("Spara utkast", "Utkastet är sparat. Fastställ när det är klart."))
    draft = state(bookkeeper, origin)["invoices"][0]
    bookkeeper.once("dialog", lambda dialog: dialog.accept())
    faststall = bookkeeper.get_by_role("button", name="Fastställ")
    faststall.dblclick()
    expect(bookkeeper.get_by_role("cell", name="Fastställd")).to_be_visible()
    after_issue = state(bookkeeper, origin)
    retries = [
        api(bookkeeper.context, origin, f"/api/invoices/{draft['id']}/issue", "POST",
            {"version": version}).status
        for version in [draft["version"], after_issue["invoices"][0]["version"]]
    ]
    assert retries == [409, 409]
    assert state(bookkeeper, origin) == after_issue
    invoice = after_issue["invoices"][0]
    issue_vouchers = [v for v in after_issue["vouchers"] if v["invoice_id"] == invoice["id"]]
    issue_audit = [a for a in after_issue["audit"] if a["action"] == "invoice.issue"]
    assert len(issue_vouchers) == len(issue_audit) == 1
    invoice_voucher = issue_vouchers[0]
    assert invoice["status"] == "issued" and invoice["number"] == 1
    assert invoice_voucher["number"] == 2 and after_issue["vouchers"][-1]["document_id"] == document_id
    assert after_issue["reports"]["receivables"] == 100000
    result["A-03"] = {
        "faktura": invoice["number"], "verifikation": f"A{invoice_voucher['number']}",
        "rest_ore": after_issue["reports"]["receivables"],
        "upprepade_api_status": retries, "faststallelser_i_historik": len(issue_audit),
        "forekomst_i_verifikationer": len(issue_vouchers),
    }

    before = state(admin, origin)
    update_company(admin, "Fiktivbank B")
    admin.once("dialog", lambda dialog: dialog.accept())
    lock_form = admin.locator("form[data-form=lock]")
    fill_form(lock_form, {"through": "2026-10-31"})
    submit(admin, lock_form, ("Lås period", "Uppgifterna är sparade."))
    expect(admin.get_by_text("Låst till och med: 2026-10-31")).to_be_visible()

    before_matrix = state(admin, origin)
    changed_company = {**DATA["company"], "bank": "Otillåten teständring",
                       "version": before_matrix["company"]["version"]}
    role_results = {}
    for page, role in ((bookkeeper, "accountant"), (viewer, "viewer")):
        page.reload()
        expect(page.locator(".user .badge")).to_have_text(role)
        navigate(page, "settings", "Inställningar")
        expect(page.locator("form[data-form=company]")).to_have_count(0)
        expect(page.locator("form[data-form=lock]")).to_have_count(0)
        expect(page.get_by_role("heading", name="Behandlingshistorik")).to_be_visible()
        navigate(page, "reports", "Rapporter")
        expect(page.get_by_role("heading", name="Saldobalans")).to_be_visible()
        expect(page.get_by_role("link", name="Hämta SIE")).to_have_count(0)
        expect(page.get_by_role("link", name="Hämta JSON")).to_have_count(0)
        if role == "viewer":
            for key, heading, selector in [
                ("customers", "Kunder", "form[data-form=customer]"),
                ("invoices", "Fakturor", "form[data-form=invoice], [data-action=payment]"),
                ("ledger", "Bokföring", "form[data-form=voucher], [data-action=reverse]"),
                ("documents", "Dokument", "form[data-form=document]"),
                ("bank", "Bank & import", "form[data-form=import], form[data-form=bank]"),
            ]:
                navigate(page, key, heading)
                expect(page.locator(selector)).to_have_count(0)
                if key == "invoices":
                    expect(page.get_by_role("link", name="PDF")).to_be_visible()
                if key == "documents":
                    expect(page.get_by_role("link", name="Öppna")).to_be_visible()
        role_results[role] = role_matrix(page, origin, changed_company, document_id, invoice["id"], 1)
    assert state(admin, origin) == before_matrix

    navigate(admin, "reports", "Rapporter")
    export_statuses = {}
    historic_company = []
    for label, path in (("Hämta SIE", "/api/export/sie"), ("Hämta JSON", "/api/export/json")):
        expect(admin.get_by_role("link", name=label)).to_be_visible()

        response = api(admin.context, origin, path)
        export_statuses[label] = response.status
        if path.endswith("/json") and response.ok:
            historic_company = [
                json.loads(event["detail"]) for event in response.json()["audit"]
                if event["action"] == "company.update"
            ]
    assert list(export_statuses.values()) == [200, 200]
    result["A-01"] = {
        "roller_i_chromium": [page.locator(".user .badge").inner_text() for page in (admin, bookkeeper, viewer)],
        "admin": {"företag_version": before_matrix["company"]["version"],
                  "periodlåst": before_matrix["periods"][0]["through"], **export_statuses},
        "bokförare": {"registrerade": ["kund", "underlag", "verifikation A1", "faktura 1"],
                      "http": role_results["accountant"]},
        "läsbehörig": role_results["viewer"],
        "inga_mutationer_av_nekade_försök": True,
    }

    reader_before_logout = viewer.context.cookies()
    viewer.get_by_role("button", name="Logga ut").click()
    expect(viewer.locator("form[data-form=login]")).to_be_visible()
    logged_out = browser.new_context()
    logged_out.add_cookies(reader_before_logout)
    denied = api(logged_out, origin, "/api/state").status
    assert denied == 401
    logged_out.close()

    navigate(admin, "settings", "Inställningar")
    fields = admin.locator("section").filter(has=admin.get_by_role("heading", name="Behandlingshistorik"))
    expect(fields.get_by_role("row").filter(has_text="invoice.issue")).to_contain_text("Bo Testbokförare")
    columns = fields.get_by_role("columnheader").all_text_contents()
    assert columns == ["Tid", "Händelse", "Användare"]
    current = state(admin, origin)
    rows = {}
    for action, actor_name in {
        "customer.create": "Bo Testbokförare", "document.archive": "Bo Testbokförare",
        "invoice.draft": "Bo Testbokförare", "invoice.issue": "Bo Testbokförare",
        "voucher.post": "Bo Testbokförare", "company.update": "Ada Testadmin",
        "period.lock": "Ada Testadmin", "auth.logout": "Liv Testläsare",
    }.items():
        row = next(a for a in current["audit"] if a["action"] == action)
        assert row["actor_name"] == actor_name
        assert row["created_at"].endswith("Z")
        rows[action] = {key: row[key] for key in ("id", "actor", "actor_name", "created_at")}
        rows[action]["detail"] = json.loads(row["detail"])
    assert rows["invoice.issue"]["detail"] == {"id": invoice["id"], "number": invoice["number"]}
    result["A-02a"] = {"ui_kolumner": columns, "händelser": rows, "gammal_cookie_efter_logout": denied}
    company_detail = rows["company.update"]["detail"]
    result["A-02b"] = {
        "fore_bank": before["company"]["bank"], "efter_bank": current["company"]["bank"],
        "detalj_i_api": company_detail,
        "företagsändringar_i_json_export": historic_company,
        "bankvärden_i_historik": all(value in json.dumps(company_detail)
                                     for value in [before["company"]["bank"], current["company"]["bank"]]),
    }
    result["A-07"] = {
        "rubriker_i_inställningar": admin.locator(".content h2").all_text_contents(),
        "kontohantering_sedd_i_inställningar": bool(admin.get_by_text(
            re.compile("lösenord|användarhantering|ändra roll", re.I)).count()),
    }
    return admin, document_id, invoice["id"]


def manifests(directory):
    return [
        {key: manifest[key] for key in ("format", "vouchers", "documents")}
        for file in sorted(directory.glob("backups/auto-*.sqlite.json"))
        for manifest in [json.loads(file.read_text())]
    ]


def ledger_state(snapshot):
    return {key: snapshot[key] for key in snapshot if key != "audit"}


def prove_recovery(directory, server, browser, users, receipt_bytes, admin, document_id, invoice_id, result):
    origin = server.origin
    original = state(admin, origin)
    document = api(admin.context, origin, f"/api/documents/{document_id}").body()
    pdf = api(admin.context, origin, f"/api/invoices/{invoice_id}/pdf").body()
    assert document == receipt_bytes
    assert original["reports"]["cash"] == -25000
    assert original["reports"]["receivables"] == 100000
    assert original["reports"]["result"] == 60000

    server.stop()
    restart = server.start()
    admin.reload()
    expect(admin.locator(".user-name")).to_have_text(users[0]["name"])
    assert state(admin, origin) == original
    automatic = manifests(directory)
    assert automatic == [
        {"format": 1, "vouchers": 0, "documents": 0},
        {"format": 1, "vouchers": 2, "documents": 1},
    ]
    result["A-04"] = {"startlogg": restart, "manifest": automatic, "samma_state_efter_omstart": True}

    backup_path = directory / "manual.sqlite"
    restored_path = directory / "restored.sqlite"
    create = server.backup_cli("create", backup_path)
    manifest = json.loads(backup_path.with_suffix(".sqlite.json").read_text())
    assert manifest["sha256"] == sha(backup_path.read_bytes())
    assert (manifest["vouchers"], manifest["documents"]) == (2, 1)
    server.stop()
    restore = server.backup_cli("restore", backup_path, restored_path)
    with sqlite3.connect(restored_path) as db:
        sessions = db.execute("SELECT COUNT(*) FROM sessions").fetchone()[0]
    assert sessions == 0

    duplicate = server.backup_cli("restore", backup_path, restored_path, expected=1)
    assert "Återställ endast till en ny databasfil" in duplicate
    corrupt = directory / "kopians-filfel.sqlite"
    corrupt.write_bytes(backup_path.read_bytes() + b"FIKTIVT FILFEL")
    shutil.copyfile(backup_path.with_suffix(".sqlite.json"), corrupt.with_suffix(".sqlite.json"))
    bad_target = directory / "avvisad.sqlite"
    checksum = server.backup_cli("restore", corrupt, bad_target, expected=1)
    assert "Backupens kontrollsumma stämmer inte." in checksum and not bad_target.exists()

    restored = Server(directory, restored_path, local_port())
    try:
        restored.start()
        old_cookie_http = api(admin.context, restored.origin, "/api/state").status
        assert old_cookie_http == 401
        restored_admin = login(browser, restored.origin, users[0])
        current = state(restored_admin, restored.origin)
        for key in ledger_state(original):
            assert current[key] == original[key], key
        new_event = current["audit"][0]
        assert new_event["action"] == "auth.login" and new_event["actor_name"] == users[0]["name"]
        assert current["audit"][1:] == original["audit"]
        assert api(restored_admin.context, restored.origin, f"/api/documents/{document_id}").body() == document
        assert api(restored_admin.context, restored.origin, f"/api/invoices/{invoice_id}/pdf").body() == pdf
        navigate(restored_admin, "reports", "Rapporter")
        result_line = restored_admin.locator(".status-line").filter(has_text="Årets resultat")
        expect(result_line).to_contain_text("600,00 kr")
        post = api(restored_admin.context, restored.origin, "/api/vouchers", "POST", {
            "text": "Fiktivt funktionsprov efter återställning", "date": "2026-11-05",
            "lines": [{"account": "1930", "debit": "10"}, {"account": "2081", "credit": "10"}],
        })
        assert post.status == 200 and post.json()["number"] == 3
    finally:
        restored.stop()

    result["A-05"] = {
        "cli_create": create.replace(str(directory), "<temporärkatalog>"),
        "cli_restore": restore, "sha256_kvitto": sha(document), "sha256_faktura_pdf": sha(pdf),
        "bank_ore": original["reports"]["cash"], "kundfordran_ore": original["reports"]["receivables"],
        "resultat_ore": original["reports"]["result"], "historikrader_jämförda": len(original["audit"]),
        "ekonomiska_state_falt_jamforda": list(ledger_state(original)),
        "dokumentreferens": original["vouchers"][-1]["document_id"],
        "sessioner_efter_aterstallning": sessions, "gammal_session_http": old_cookie_http,
        "ny_bokning_efter_aterstallning": f"A{post.json()['number']}",
        "befintligt_mal": "Avvisat", "trasig_kontrollsumma": "Avvisad, ingen måldatabas skapades",
    }


def prove_counter_fault(directory, browser, user, result):
    fault_dir = directory / "felprov"
    fault_dir.mkdir()
    source = fault_dir / "provdatabas.sqlite"
    backup_path = fault_dir / "backup.sqlite"
    target = fault_dir / "aterstalld.sqlite"
    shutil.copyfile(directory / "manual.sqlite", source)
    # Model a damaged sequence in a new, otherwise balanced synthetic database.
    with sqlite3.connect(source) as db:
        assert db.execute("SELECT MAX(number) FROM vouchers").fetchone()[0] == 2
        assert db.execute("SELECT value FROM counters WHERE name='voucher'").fetchone()[0] == 2
        db.execute("UPDATE counters SET value=1 WHERE name='voucher'")
    fixture = Server(fault_dir, source, local_port())
    create = fixture.backup_cli("create", backup_path)
    restore = fixture.backup_cli("restore", backup_path, target)
    recovered = Server(fault_dir, target, local_port())
    try:
        recovered.start()
        page = login(browser, recovered.origin, user)
        before = state(page, recovered.origin)
        response = api(page.context, recovered.origin, "/api/vouchers", "POST", {
            "text": "Fiktivt funktionsprov efter nummerseriefel", "date": "2026-11-05",
            "lines": [{"account": "1930", "debit": "10"}, {"account": "2081", "credit": "10"}],
        })
        after = state(page, recovered.origin)
        assert response.status in (400, 409) and before == after, (response.status, response.text())
        result["A-06"] = {
            "max_befintlig_verifikation": 2, "felinjicerad_raknare": 1,
            "cli_create": create.replace(str(directory), "<temporärkatalog>"),
            "cli_restore": restore, "bokforing_http": response.status,
            "bokforing_fel": response.json()["error"], "oforandrad_bokforing": before == after,
        }
    finally:
        recovered.stop()


def main():
    result = {}
    with tempfile.TemporaryDirectory(prefix="balans-aterstallning-") as temp, sync_playwright() as playwright:
        directory = Path(temp)
        database = directory / "original.sqlite"
        users = seed(database)
        server = Server(directory, database, local_port())
        browser = playwright.chromium.launch(
            executable_path=os.environ.get("BALANS_CHROMIUM", "/usr/bin/chromium"),
            args=["--no-sandbox"],
        )
        try:
            server.start()
            receipt_path = directory / "R-001.pdf"
            receipt_bytes = receipt(receipt_path)
            admin, document_id, invoice_id = prove_roles_and_history(
                server, browser, users, receipt_path, result
            )
            prove_recovery(directory, server, browser, users, receipt_bytes, admin, document_id, invoice_id, result)
            prove_counter_fault(directory, browser, users[0], result)
        finally:
            browser.close()
            server.stop()
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
