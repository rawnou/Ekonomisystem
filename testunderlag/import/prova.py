"""Isolerade körprov mot Balans i Chromium och genom appens lokala API."""
import hashlib
import importlib.metadata
import json
import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

from playwright.sync_api import expect, sync_playwright

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
FIXTURES = HERE / "fixturer"


def log(test_id, **result):
    print(f"{test_id} {json.dumps(result, ensure_ascii=False, sort_keys=True)}", flush=True)


def allocate_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def make_pdf(source, target):
    """Skriv en läsbar PDF 1.4 med en sida från det fiktiva textunderlaget."""
    lines = source.read_text(encoding="utf-8").splitlines()
    stream = "BT /F1 11 Tf 50 780 Td 16 TL " + " T* ".join(
        "(" + line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") + ") Tj"
        for line in lines
    ) + " ET"
    stream = stream.encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    data = b"%PDF-1.4\n"
    offsets = []
    for index, entry in enumerate(objects, 1):
        offsets.append(len(data))
        data += f"{index} 0 obj\n".encode() + entry + b"\nendobj\n"
    pointer = len(data)
    data += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    data += b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets)
    data += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{pointer}\n%%EOF\n".encode()
    target.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def request(origin, path, data=None, *, headers=None, method=None):
    wire_headers = {**(headers or {})}
    if data is not None:
        wire_headers.update({"Content-Type": "application/json", "Origin": origin})
    req = urllib.request.Request(
        origin + path,
        data=json.dumps(data).encode() if data is not None else None,
        headers=wire_headers,
        method=method,
    )
    try:
        response = urllib.request.urlopen(req, timeout=10)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read()
        if response.headers.get("Content-Type", "").startswith("application/json"):
            body = json.loads(body)
        return response.status, body, response.headers


def book_fixtures(page, temp, credentials, status, state, origin):
    page.goto(origin)
    form = page.locator('form[data-form="login"]')
    form.locator('[name="email"]').fill(credentials[0])
    form.locator('[name="password"]').fill(credentials[1])
    form.locator("button").click()
    expect(page.locator("nav.nav")).to_be_visible()
    page.locator('nav [data-page="settings"]').click()
    company_form = page.locator('form[data-form="company"]')
    company_form.locator('[name="name"]').fill("Testkompassen AB")
    company_form.locator('[name="orgNumber"]').fill("559900-0006")
    company_form.locator('[name="vatNumber"]').fill("SE559900000601")
    company_form.get_by_role("button", name="Spara företagsuppgifter").click()
    expect(page.locator(".company-name")).to_have_text("Testkompassen AB")

    def upload(name):
        source = FIXTURES / f"{name}.txt"
        target = temp / f"{name}.pdf"
        expected_hash = make_pdf(source, target)
        page.locator('nav [data-page="documents"]').click()
        form = page.locator('form[data-form="document"]')
        form.locator('[name="file"]').set_input_files(target)
        form.get_by_role("button", name="Ladda upp underlag").click()
        row = page.get_by_role("row").filter(has_text=target.name)
        expect(row).to_be_visible()
        expect(row.locator("td[title]")).to_have_attribute("title", expected_hash)
        download = page.request.get(origin + row.get_by_role("link", name="Öppna").get_attribute("href"))
        assert download.status == 200 and download.body() == target.read_bytes()
        result = next(doc for doc in state()["documents"] if doc["name"] == target.name)
        return result["id"], expected_hash

    def voucher(date, description, document_id, lines):
        page.locator('nav [data-page="ledger"]').click()
        form = page.locator('form[data-form="voucher"]')
        form.locator('[name="date"]').fill(date)
        form.locator('[name="text"]').fill(description)
        form.locator('[name="documentId"]').select_option(str(document_id))
        for _ in lines[2:]:
            form.get_by_role("button", name="+ Lägg till rad").click()
        for index, (account, debit, credit) in enumerate(lines):
            row = form.locator(".line-entry").nth(index)
            row.locator('[name="account"]').select_option(account)
            row.locator('[name="debit"]').fill(debit)
            row.locator('[name="credit"]').fill(credit)
        form.get_by_role("button", name="Bokför verifikation").click()
        row = page.get_by_role("row").filter(has_text=description)
        expect(row).to_be_visible()
        return row, state()["vouchers"][0]

    receipt_id, receipt_hash = upload("kvitto")
    receipt_row, receipt = voucher("2026-10-06", "Kvitto K-701", receipt_id, [
        ("6110", "4000", "0"), ("2641", "1000", "0"), ("1930", "0", "5000"),
    ])
    report = state()["reports"]
    assert receipt["document_id"] == receipt_id and receipt["number"] == 1
    assert (report["expenses"], balance(report, "2641"), report["cash"]) == (400000, 100000, -500000)
    log("I-01", status="godkänt", rapport=pick(report, "1930", "2641", "6110"),
        verifikation=receipt, underlag_SHA256=receipt_hash, nedladdning_HTTP=200,
        analysnotis="Underlagslänk saknas på grundbokens rad" if receipt_row.get_by_role("link").count() == 0 else "",
        grundboksrad=receipt_row.inner_text())

    supplier_id, supplier_hash = upload("leverantorsfaktura")
    menu = page.locator("nav.nav").inner_text()
    _, supplier = voucher("2026-10-07", "Fiktionstjänst i Norden AB LF-712, förfallo 2026-11-06", supplier_id, [
        ("5420", "1000", "0"), ("2641", "250", "0"), ("2440", "0", "1250"),
    ])
    report = state()["reports"]
    assert (balance(report, "2440"), balance(report, "2641"), balance(report, "5420")) == (-125000, 125000, 100000)
    log("I-02", status="funktion saknas", navigation=menu, fakturaregister="ingen leverantörsvy",
        manuellt_upplupet=pick(report, "2440", "2641", "5420"), underlag_SHA256=supplier_hash,
        förfallodatum="2026-11-06 i verifikationstexten", verifikation=supplier)

    page.locator('nav [data-page="bank"]').click()
    form = page.locator('form[data-form="import"]')
    form.locator('[name="file"]').set_input_files(FIXTURES / "bank.csv")
    form.get_by_role("button", name="Importera transaktioner").click()
    expect(page.locator("#notice")).to_have_text("Import klar: 6 nya transaktioner, 0 dubbletter.")
    imported = state()
    assert len(imported["bank"]) == 6 and len(imported["vouchers"]) == 2
    log("I-03", status="godkänt", gränssnitt=page.locator("#notice").inner_text(),
        bankrader=len(imported["bank"]), verifikationer=len(imported["vouchers"]),
        importevidens=imported["imports"])

    def classify(reference, account):
        row = page.get_by_role("row").filter(has_text=reference)
        row.get_by_role("button", name="Klassificera").click()
        classification = page.locator('form[data-form="bank-book"]')
        classification.locator('[name="account"]').select_option(account)
        classification.locator('[name="reviewed"]').check()
        classification.get_by_role("button", name="Bokför bankhändelse").click()
        expect(row.get_by_text("Bokförd")).to_be_visible()
        return row.inner_text()

    bank_row = classify("BANK-LF712", "2440")
    post = state()
    supplier_payment = next(row for row in post["bank"] if row["reference"] == "BANK-LF712")
    replay = status(f'/api/bank/{supplier_payment["id"]}/book', {"account": "2440", "reviewed": True})
    assert replay[0] == 409 and len(state()["vouchers"]) == 3
    assert (balance(post["reports"], "2440"), post["reports"]["cash"]) == (0, -625000)
    log("I-04", status="godkänt", gränssnittsrad=bank_row, försök2=replay,
        bankrad=supplier_payment, verifikation=post["vouchers"][0],
        rapport=pick(post["reports"], "1930", "2440", "2641", "5420"))

    bank_row = classify("BANK-AVG01", "6570")
    after_fee = state()
    fee = next(row for row in after_fee["bank"] if row["reference"] == "BANK-AVG01")
    assert balance(after_fee["reports"], "6570") == 4900
    log("I-05", status="godkänt", gränssnittsrad=bank_row, bankrad=fee,
        verifikation=after_fee["vouchers"][0], rapport=pick(after_fee["reports"], "1930", "6570"))

    def platform_upload(source, file, mapping):
        form = page.locator('form[data-form="import"]')
        form.locator('[name="source"]').select_option(source)
        form.locator('[name="file"]').set_input_files(FIXTURES / file)
        if mapping:
            form.locator("summary").click()
            for field, column in mapping.items():
                form.locator(f'[name="map_{field}"]').fill(column)
        form.get_by_role("button", name="Importera transaktioner").click()
        expect(page.locator("#notice")).to_have_text("Import klar: 2 nya transaktioner, 0 dubbletter.")
        return page.locator("#notice").inner_text()

    kdp_notice = platform_upload("kdp", "kdp.csv", {})
    adt_notice = platform_upload("adtraction", "adtraction.csv", {
        "date": "Bokföringsdag", "description": "Källa", "amount": "Fiktiv provision",
        "currency": "ISO-valuta", "reference": "Rapportnyckel", "period": "Rapportmånad",
    })
    post = state()
    platform_rows = [row for row in post["bank"] if row["source"] != "bank"]
    assert len(platform_rows) == 4 and len(post["vouchers"]) == 4 and post["reports"]["income"] == 0
    assert sorted((row["currency"], row["amount"], row["period"]) for row in platform_rows) == [
        ("EUR", 1000, "2026-09"), ("SEK", 7500, "2026-08"), ("SEK", 7500, "2026-09"),
        ("USD", 2010, "2026-09"),
    ]
    assert all(row["voucher_id"] is None for row in platform_rows)
    expect(page.get_by_text("Manuell granskning", exact=True)).to_have_count(4)
    page.locator('nav [data-page="overview"]').click()
    dashboard = page.get_by_role("heading", name="Rapporterade originalbelopp").locator("..")
    dashboard_text = dashboard.inner_text()
    for fragment in ("10,00 EUR", "20,10 USD", "150,00 SEK"):
        assert fragment in dashboard_text, dashboard_text
    log("I-06", status="godkänt", UI_KDP=kdp_notice, UI_Adtraction=adt_notice,
        dashboard=dashboard_text, importerade=platform_rows, intäkter=post["reports"]["income"],
        verifikationer=len(post["vouchers"]))
    return fee, supplier_payment


def balance(report, account):
    return next(row["balance"] for row in report["trialBalance"] if row["number"] == account)


def pick(report, *accounts):
    return {account: balance(report, account) for account in accounts}


def test_api(page, status, state, fee, supplier_payment):
    def import_csv(file, source="bank", mapping=None):
        return status("/api/imports", {
            "source": source, "csv": (FIXTURES / file).read_text(encoding="utf-8"),
            "mapping": mapping or {},
        })

    base = state()
    same = import_csv("bank.csv")
    overlap = import_csv("bank-overlapp.csv")
    manual = status("/api/bank", {"date": "2026-10-10", "description": "Manuell samma avgift",
                                 "amount": "-49", "currency": "SEK", "reference": "BANK-AVG01"})
    assert same == (200, {"inserted": 0, "duplicates": 6})
    assert overlap[0] == 200 and (overlap[1]["inserted"], overlap[1]["duplicates"]) == (1, 1)
    assert manual == (200, {"inserted": False})
    log("I-07", status="godkänt", omimport=same, överlappande_fil=overlap, manuell=manual,
        bankrader=[len(base["bank"]), len(state()["bank"])])

    before = state()
    errors = {file: import_csv(file) for file in [
        "bank-fel.csv", "bank-identisk.csv", "bank-innehall-fel.csv", "bank-ogiltig-valuta.csv",
    ]}
    errors["felaktig mappning"] = import_csv("bank.csv", mapping={"currency": "felrubrik"})
    assert all(result[0] == 400 for result in errors.values())
    assert state() == before
    log("I-08", status="godkänt", avvisade=errors, tillstånd_oförändrat=True,
        antal={key: len(before[key]) for key in ("bank", "imports", "vouchers", "audit")})

    before = state()
    gate = threading.Barrier(2)
    def do_import():
        gate.wait(timeout=5)
        return import_csv("bank-parallell.csv")
    with ThreadPoolExecutor(max_workers=2) as workers:
        tasks = [workers.submit(do_import) for _ in range(2)]
        results = [task.result() for task in tasks]
    after = state()
    assert sorted((code, data["inserted"], data["duplicates"]) for code, data in results) == [(200, 0, 2), (200, 2, 0)]
    assert len(after["bank"]) - len(before["bank"]) == 2
    assert len(after["imports"]) - len(before["imports"]) == 1
    assert len(after["vouchers"]) == len(before["vouchers"])
    log("I-09", status="godkänt", samtidiga_HTTP=results, nya_bankrader=2, nya_importposter=1, nya_verifikationer=0)

    fx = next(row for row in state()["bank"] if row["reference"] == "BANK-EUR01")
    path = f'/api/bank/{fx["id"]}/book'
    missing_rate = status(path, {"account": "5410", "reviewed": True})
    zero_rate = status(path, {"account": "5410", "exchangeRate": "0", "reviewed": True})
    long_rate = status(path, {"account": "5410", "exchangeRate": "11.1234567", "reviewed": True})
    unreviewed = status(path, {"account": "5410", "exchangeRate": "11.123456", "reviewed": False})
    assert all(reply[0] == 400 for reply in (missing_rate, zero_rate, long_rate, unreviewed))
    assert not next(row for row in state()["bank"] if row["id"] == fx["id"])["voucher_id"]
    ok = status(path, {"account": "5410", "exchangeRate": "11.123456", "reviewed": True})
    duplicate = status(path, {"account": "5410", "exchangeRate": "11.123456", "reviewed": True})
    after = state()
    bank_fx = next(row for row in after["bank"] if row["id"] == fx["id"])
    assert ok[0] == 200 and duplicate[0] == 409
    assert (bank_fx["original_amount"], bank_fx["currency"], bank_fx["exchange_rate"]) == (-1234, "EUR", "11.123456")
    assert balance(after["reports"], "5410") == 13726
    log("I-10", status="godkänt", avvisade=[missing_rate, zero_rate, long_rate, unreviewed],
        upprepning=duplicate, bankrad=bank_fx, verifikation=after["vouchers"][0],
        rapport=pick(after["reports"], "1930", "5410"))

    blank = import_csv("bank-blank-valuta.csv", mapping={"currency": "valuta"})
    invented = import_csv("bank-okand-valuta.csv")
    after = state()
    blank_row = next((row for row in after["bank"] if row["reference"] == "BANK-TOMVAL"), None)
    invented_row = next((row for row in after["bank"] if row["reference"] == "BANK-QQQ"), None)
    log("I-11", status="underkänt" if blank_row or invented_row else "godkänt", tom=blank,
        blankrad=blank_row, påhittad=invented, påhittad_rad=invented_row)

    lost_first = import_csv("bank-referenslost-1.csv")
    lost_second = import_csv("bank-referenslost-2.csv")
    fees = [row for row in state()["bank"] if row["description"] == "Fiktiv kortavgift"]
    log("I-12", status="underkänt" if len(fees) != 2 else "godkänt", första_fil=lost_first,
        andra_fil=lost_second, sparade_kortavgifter=len(fees),
        testantagande="De två referenslösa avgifterna är olika verkliga händelser i det fiktiva kontoutdraget.")

    customer_status, customer = status("/api/customers", {
        "name": "Fiktiv Kundverkstan AB", "orgNumber": "559900-0014",
        "email": "kund@example.test", "address": "Testgatan 10, 111 11 Teststad",
    })
    assert customer_status == 200
    draft_status, draft = status("/api/invoices", {
        "customerId": customer["id"], "date": "2026-10-08", "dueDate": "2026-11-07",
        "description": "Fiktiv testtjänst", "quantity": "1", "unitPrice": "400", "vatRate": 25,
    })
    assert draft_status == 200
    issue = status(f'/api/invoices/{draft["id"]}/issue', {"version": 1})
    assert issue[0] == 200
    payment = status(f'/api/invoices/{draft["id"]}/payment', {"amount": "500", "date": "2026-10-12"})
    payment_retry = status(f'/api/invoices/{draft["id"]}/payment', {"amount": "500", "date": "2026-10-12"})
    before = state()
    bank_payment = next(row for row in before["bank"] if row["reference"] == "BANK-KUND01")
    method = f'/api/bank/{bank_payment["id"]}/book'
    rejected_1510 = status(method, {"account": "1510", "reviewed": True})
    assert payment[0] == 200 and payment_retry[0] == 400 and rejected_1510[0] == 400
    assert before["reports"]["receivables"] == 0 and not bank_payment["voucher_id"]
    assert state() == before
    # Facit för just ursprungsutdraget; övriga CSV-filer prövar dubbletter och validering.
    statement_balance = -500000 - 125000 - 4900 - 13726 + 50000 + 10000
    book_balance = before["reports"]["cash"]
    assert statement_balance - book_balance == 10000
    page.reload()
    page.locator('nav [data-page="bank"]').click()
    for reference in ("BANK-KUND01", "BANK-K701"):
        row = page.get_by_role("row").filter(has_text=reference)
        expect(row.get_by_role("button", name="Klassificera")).to_be_visible()
        expect(row.get_by_role("button")).to_have_count(1)
    log("I-13", status="funktion saknas", faktura=issue, fakturabetalning=payment,
        upprepad_helbetalning=payment_retry, bokföring_mot_1510=rejected_1510,
        bankrad=bank_payment, restfordran=0, betalningsverifikation=before["vouchers"][0],
        direktbetalt_kvitto_bankrad=next(row for row in before["bank"] if row["reference"] == "BANK-K701"),
        manuell_bankavstämning={"utdrag_SEK_omräknat": statement_balance, "bokfört_1930": book_balance,
                              "differens_utdrag_minus_bok": statement_balance - book_balance},
        gränssnitt="Klassificera är enda åtgärden för både BANK-KUND01 och BANK-K701")

    duplicate_booking = status(method, {"account": "3041", "reviewed": True})
    after = state()
    log("I-14", status="underkänt" if duplicate_booking[0] == 200 else "godkänt",
        dubbelregistrering_mot_3041=duplicate_booking, före=pick(before["reports"], "1930", "3041", "1510"),
        efter=pick(after["reports"], "1930", "3041", "1510"),
        senast_bokförda=after["vouchers"][0])

    before = state()
    reversal = status(f'/api/vouchers/{fee["voucher_id"]}/reverse', {"date": "2026-10-18", "reason": "Felklassad fiktiv avgift"})
    after = state()
    bank_fee = next(row for row in after["bank"] if row["id"] == fee["id"])
    replay = status(f'/api/bank/{fee["id"]}/book', {"account": "6110", "reviewed": True})
    assert reversal[0] == 200
    page.reload()
    page.locator('nav [data-page="bank"]').click()
    bank_row = page.get_by_role("row").filter(has_text="BANK-AVG01")
    expect(bank_row).to_be_visible()
    log("I-15", status="underkänt" if bank_fee["voucher_id"] and replay[0] != 200 else "godkänt",
        rättelse=reversal, motbokning=after["vouchers"][0], fortsatt_bankkoppling=bank_fee["voucher_id"],
        omklassificering=replay, gränssnitt=bank_row.inner_text(), före=pick(before["reports"], "1930", "6570"),
        efter=pick(after["reports"], "1930", "6570"))

    before = state()
    kdp_row = next(row for row in before["bank"] if row["reference"] == "KDP-FIKT-EUR")
    payout = next(row for row in before["bank"] if row["reference"] == "BANK-KDP01")
    direct = status(f'/api/bank/{kdp_row["id"]}/book', {
        "account": "3044", "exchangeRate": "10", "reviewed": True,
    })
    assert direct[0] == 400 and before == state()
    manual = status("/api/vouchers", {"date": "2026-10-13", "text": "Manuellt bedömd fiktiv KDP-utbetalning",
                                       "lines": [{"account": "1930", "debit": "100"},
                                                 {"account": "3044", "credit": "100"}]})
    assert manual[0] == 200
    after = state()
    assert after["reports"]["income"] - before["reports"]["income"] == 10000
    log("I-16", status="funktion saknas", försök_att_bokföra_plattformsrad=direct,
        manuell_verifikation=after["vouchers"][0], plattformsrad=kdp_row,
        bankens_utbetalningsrad=payout, rapport=pick(after["reports"], "1930", "3044"),
        leverantörsutbetalning_redan_länkad_till_verifikation=supplier_payment["voucher_id"])

    final = state()
    trial = final["reports"]["trialBalance"]
    total_debit = sum(item["debit"] for item in trial)
    total_credit = sum(item["credit"] for item in trial)
    assert total_debit == total_credit
    log("SUMMERING", debet_i_öre=total_debit, kredit_i_öre=total_credit,
        verifikationsnummer=sorted(v["number"] for v in final["vouchers"]))


def main():
    with tempfile.TemporaryDirectory(prefix="balans-import-") as dirname:
        temp = Path(dirname)
        port = allocate_port()
        origin = f"http://127.0.0.1:{port}"
        env = {**os.environ, "DATABASE_PATH": str(temp / "import.sqlite"), "PORT": str(port)}
        setup = subprocess.run(["node", ROOT / "scripts/setup.mjs"], env=env, cwd=temp, check=True,
                               text=True, capture_output=True)
        credentials = next(line.split() for line in setup.stdout.splitlines() if line.startswith("delagare1@"))
        chromium = os.getenv("BALANS_TEST_CHROMIUM", "/usr/bin/chromium")
        log("MILJÖ", node=subprocess.check_output(["node", "-v"], text=True).strip(),
            sqlite=subprocess.check_output(["node", "-p", "process.versions.sqlite"], text=True).strip(),
            webbläsare=subprocess.check_output([chromium, "--version"], text=True).strip(),
            playwright=importlib.metadata.version("playwright"))
        with (temp / "server.log").open("w+") as server_log:
            server = subprocess.Popen(["node", ROOT / "src/server.mjs"], env=env, cwd=temp,
                                      stdout=server_log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:
                        if request(origin, "/api/session")[0] == 200:
                            break
                    except urllib.error.URLError:
                        if server.poll() is not None:
                            server_log.seek(0)
                            raise RuntimeError(server_log.read())
                        time.sleep(0.05)
                else:
                    raise RuntimeError("Den lokala servern blev inte klar i tid.")
                login_status, login, headers = request(origin, "/api/login", {
                    "email": credentials[0], "password": credentials[1],
                })
                assert login_status == 200
                request_headers = {"Cookie": headers["Set-Cookie"].split(";")[0], "X-CSRF-Token": login["csrf"]}

                def status(path, payload=None):
                    code, body, _ = request(origin, path, payload, headers=request_headers)
                    return code, body

                def state():
                    code, result = status("/api/state")
                    assert code == 200
                    return result

                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(executable_path=chromium, headless=True, args=["--no-sandbox"])
                    try:
                        page = browser.new_page()
                        fee, supplier_payment = book_fixtures(page, temp, credentials, status, state, origin)
                        test_api(page, status, state, fee, supplier_payment)
                    finally:
                        browser.close()
            finally:
                server.terminate()
                server.wait(timeout=10)


if __name__ == "__main__":
    main()
