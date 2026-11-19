"""Kör kontrollscenariot i Chromium mot en ny lokal Balans-instans."""
import argparse
import base64
import csv
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
FACIT = json.loads((HERE / "facit.json").read_text())
with (HERE / "kontoutdrag.csv").open() as csv_file:
    BANK = list(csv.DictReader(csv_file))


def write_receipt(destination):
    lines = (HERE / "kvitto.txt").read_text().splitlines()
    draw = "BT /F1 12 Tf 55 760 Td 19 TL " + " T* ".join(
        f"({line}) Tj" for line in lines
    ) + " ET"
    objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
        "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        f"<< /Length {len(draw)} >>\nstream\n{draw}\nendstream",
    ]
    contents = b"%PDF-1.4\n"
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(contents))
        contents += f"{number} 0 obj\n{obj}\nendobj\n".encode("ascii")
    start = len(contents)
    contents += (
        "xref\n0 6\n0000000000 65535 f \n"
        + "".join(f"{offset:010d} 00000 n \n" for offset in offsets)
        + f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n"
    ).encode("ascii")
    destination.write_bytes(contents)


def open_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(work, evidence, chromium):
    evidence.mkdir(parents=True, exist_ok=True)
    port = open_port()
    url = f"http://127.0.0.1:{port}"
    env = {**os.environ, "DATABASE_PATH": str(work / "control.sqlite"), "PORT": str(port)}
    setup = subprocess.check_output(
        ["node", REPO / "scripts/setup.mjs"], cwd=work, env=env, text=True
    )
    email, password = next(
        line.split() for line in setup.splitlines() if line.startswith("delagare1@")
    )
    with (work / "server.txt").open("w") as server_log:
        server = subprocess.Popen(
            ["node", REPO / "src/server.mjs"], cwd=work, env=env,
            stdout=server_log, stderr=subprocess.STDOUT,
        )
        try:
            for _ in range(100):
                try:
                    with urllib.request.urlopen(url, timeout=0.3):
                        break
                except OSError:
                    if server.poll() is not None:
                        raise RuntimeError((work / "server.txt").read_text())
                    time.sleep(0.1)
            else:
                raise RuntimeError("Servern startade inte.")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=chromium)
                context = browser.new_context(viewport={"width": 1400, "height": 960})
                page = context.new_page()
                trace = exercise(page, url, work, evidence, email, password)
                trace["browser"] = browser.version
                (evidence / "resultat.json").write_text(
                    json.dumps(trace, ensure_ascii=False, indent=2) + "\n"
                )
                browser.close()
        finally:
            server.terminate()
            server.wait(timeout=10)


def exercise(page, url, work, evidence, email, password):
    trace = {"utc": datetime.now(timezone.utc).isoformat(), "steps": []}
    page.goto(url)
    page.locator('[name="email"]').fill(email)
    page.locator('[name="password"]').fill(password)
    page.get_by_role("button", name="Logga in").click()
    expect(page.locator("nav")).to_be_visible()

    def navigate(name):
        page.locator(f'nav [data-page="{name}"]').click()

    def fill(form, data):
        for key, value in data.items():
            form.locator(f'[name="{key}"]').fill(value)

    def mutate(path, action):
        with page.expect_response(lambda r: r.url == url + "/api/state") as refreshed, page.expect_response(
            lambda r: r.url == url + path and r.request.method in ("POST", "PUT")
        ) as pending:
            action()
        response = pending.value
        assert response.status == 200, (path, response.status, response.text())
        assert refreshed.value.ok
        expect(page.locator("#notice.visible:not(.error)")).to_be_visible()
        return response.json()

    def state():
        response = page.request.get(url + "/api/state")
        assert response.ok
        return response.json()

    def assert_step(index, invoices=None):
        step = FACIT["steps"][index]
        current = state()
        report = current["reports"]
        nonzero = {
            a["number"]: a["balance"] for a in report["trialBalance"] if a["balance"]
        }
        expected = {
            account: amount * 100
            for account, amount in zip(FACIT["accounts"], step["balancesSek"]) if amount
        }
        assert nonzero == expected, (step["id"], nonzero, expected)
        vouchers = current["vouchers"]
        assert len(vouchers) == step["voucherCount"], (step["id"], vouchers)
        assert sorted(v["number"] for v in vouchers) == list(range(1, index + 1))
        assert all(sum(l["debit"] - l["credit"] for l in v["lines"]) == 0 for v in vouchers)
        posting = {}
        if vouchers:
            voucher = vouchers[0]
            posting = {l["account"]: (l["debit"] - l["credit"]) // 100 for l in voucher["lines"]}
            assert posting == step["postingsSek"], (step["id"], posting)
            expect(page.locator('nav [data-page="ledger"]')).to_be_visible()
        cash, receivables, revenue, costs, output_vat, input_vat, capital = (
            amount * 100 for amount in step["balancesSek"]
        )
        assert (report["cash"], report["receivables"], report["income"], report["expenses"], report["result"]) == (
            cash, receivables, -revenue, costs, -revenue - costs
        ), step["id"]
        assert report["balance"] == {
            "assets": cash + receivables + input_vat,
            "liabilities": -output_vat,
            "equity": -capital - revenue - costs,
        }, step["id"]
        invoice_state = {
            i["number"]: [i["status"], i["paid"], i["total"], i["original_id"]]
            for i in current["invoices"]
        }
        if invoices is not None:
            assert invoice_state == invoices, (step["id"], invoice_state, invoices)
        trace["steps"].append({
            "id": step["id"], "balancesSek": {k: v // 100 for k, v in nonzero.items()},
            "voucher": vouchers[0]["number"] if vouchers else None, "postingsSek": posting,
            "invoiceStatusPaidTotalOriginal_Ore": invoice_state,
            "netVatSek": (-output_vat - input_vat) // 100,
            "debitSek": sum(a["debit"] for a in report["trialBalance"]) // 100,
            "creditSek": sum(a["credit"] for a in report["trialBalance"]) // 100,
        })
        return current

    navigate("settings")
    form = page.locator('[data-form="company"]')
    fill(form, FACIT["company"])
    mutate("/api/company", lambda: form.get_by_role("button", name="Spara företagsuppgifter").click())
    navigate("customers")
    for customer in FACIT["customers"]:
        form = page.locator('[data-form="customer"]')
        fill(form, customer)
        mutate("/api/customers", lambda: form.get_by_role("button", name="Lägg till kund").click())
        expect(page.get_by_role("cell", name=customer["name"])).to_be_visible()
    initial = assert_step(0, {})
    assert not initial["bank"] and not initial["periods"]
    customers = {c["name"]: c["id"] for c in initial["customers"]}

    def manual_voucher(date, label, lines, document=None):
        navigate("ledger")
        form = page.locator('[data-form="voucher"]')
        fill(form, {"date": date, "text": label})
        if document:
            form.locator('[name="documentId"]').select_option(str(document))
        for _ in lines[2:]:
            form.locator('[data-action="add-line"]').click()
        for idx, (account, debit, credit) in enumerate(lines):
            row = form.locator(".line-entry").nth(idx)
            row.locator('[name="account"]').select_option(account)
            fill(row, {"debit": debit, "credit": credit})
        mutate("/api/vouchers", lambda: form.get_by_role("button", name="Bokför verifikation").click())
        expect(page.get_by_role("cell", name=label, exact=True)).to_be_visible()

    manual_voucher(BANK[0]["date"], BANK[0]["description"], [
        ("1930", BANK[0]["amount"], "0"), ("2081", "0", BANK[0]["amount"]),
    ])
    assert_step(1, {})

    def issue(index, expected_vouchers):
        navigate("invoices")
        data = FACIT["invoices"][index]
        customer = FACIT["customers"][index]["name"]
        form = page.locator('[data-form="invoice"]')
        form.locator('[name="customerId"]').select_option(str(customers[customer]))
        fill(form, data)
        draft = mutate("/api/invoices", lambda: form.get_by_role("button", name="Spara utkast").click())
        draft_state = state()
        record = next(i for i in draft_state["invoices"] if i["id"] == draft["id"])
        assert record["status"] == "draft" and record["number"] is None
        assert len(draft_state["vouchers"]) == expected_vouchers
        page.once("dialog", lambda dialog: dialog.accept())
        result = mutate(f'/api/invoices/{draft["id"]}/issue', lambda: page.locator(
            f'[data-action="issue"][data-id="{draft["id"]}"]'
        ).click())
        row = page.get_by_role("row").filter(has_text=customer)
        expect(row.get_by_role("link", name="PDF")).to_be_visible()
        assert result["number"] == index + 1
        return draft["id"]

    invoice_a = issue(0, 1)
    assert_step(2, {1: ["issued", 0, 2500000, None]})
    row_a = page.get_by_role("row").filter(has_text=FACIT["customers"][0]["name"])
    trace["invoiceA_dueDateUI"] = row_a.get_by_role("cell").nth(2).inner_text()
    assert trace["invoiceA_dueDateUI"] == FACIT["invoices"][0]["dueDate"]

    def prompt_values(values):
        iterator = iter(values)
        handler = lambda dialog: dialog.accept(next(iterator))
        page.on("dialog", handler)
        return handler

    handler = prompt_values([BANK[1]["amount"], BANK[1]["date"]])
    mutate(f"/api/invoices/{invoice_a}/payment", lambda: row_a.get_by_role("button", name="Betalning").click())
    page.remove_listener("dialog", handler)
    assert_step(3, {1: ["partial", 1000000, 2500000, None]})

    invoice_b = issue(1, 3)
    assert_step(4, {1: ["partial", 1000000, 2500000, None], 2: ["issued", 0, 1000000, None]})
    page.once("dialog", lambda dialog: dialog.accept("2026-10-05"))
    credit = mutate(f"/api/invoices/{invoice_b}/credit", lambda: page.locator(
        f'[data-action="credit"][data-id="{invoice_b}"]'
    ).click())
    assert credit["number"] == 3
    final_invoices = {
        1: ["partial", 1000000, 2500000, None], 2: ["credited", 0, 1000000, None],
        3: ["credit", 0, -1000000, invoice_b],
    }
    assert_step(5, final_invoices)
    page.screenshot(path=evidence / "fakturor.png", full_page=True)

    receipt = work / "KVITTO-001.pdf"
    write_receipt(receipt)
    navigate("documents")
    form = page.locator('[data-form="document"]')
    form.locator('[name="file"]').set_input_files(receipt)
    document = mutate("/api/documents", lambda: form.get_by_role("button", name="Ladda upp underlag").click())
    manual_voucher(BANK[2]["date"], "KVITTO-001 Programvara", [
        ("5420", "4000", "0"), ("2641", "1000", "0"), ("1930", "0", BANK[2]["amount"].lstrip("-")),
    ], document["id"])
    final = assert_step(6, final_invoices)
    assert final["vouchers"][0]["document_id"] == document["id"]
    assert trace["steps"][-1]["debitSek"] == FACIT["finalSek"]["turnoverDebit"]
    assert trace["steps"][-1]["creditSek"] == FACIT["finalSek"]["turnoverCredit"]
    assert trace["steps"][-1]["netVatSek"] == FACIT["finalSek"]["vatPayable"]
    trace["receiptSha256"] = hashlib.sha256(receipt.read_bytes()).hexdigest()
    assert final["documents"][0]["hash"] == trace["receiptSha256"]
    page.screenshot(path=evidence / "grundbok.png", full_page=True)

    navigate("reports")
    expect(page.get_by_text("Årets resultat", exact=True)).to_be_visible()
    ui = page.locator(".content").inner_text().replace("\xa0", " ").replace("\u202f", " ")
    assert all(value in ui for value in ["55 000,00", "16 000,00", "71 000,00", "15 000,00"])
    (evidence / "rapporter.txt").write_text(ui + "\n")
    page.screenshot(path=evidence / "rapporter.png", full_page=True)

    for name, filename in [("Hämta SIE", "bokforing.se"), ("Hämta JSON", "export.json")]:
        with page.expect_download() as download:
            page.get_by_role("link", name=name).click()
        download.value.save_as(work / filename)
    verify_exports(work, evidence, final, receipt, trace)
    for name, ident in [("A", invoice_a), ("B", invoice_b), ("kredit", credit["id"])]:
        response = page.request.get(url + f"/api/invoices/{ident}/pdf")
        assert response.ok and response.headers["content-type"] == "application/pdf"
        pdf = work / f"faktura-{name}.pdf"
        pdf.write_bytes(response.body())
        contents = subprocess.check_output(["pdftotext", "-layout", pdf, "-"], text=True)
        assert "Testkompassen AB" in contents
        expected_pdf = {
            "A": ("FAKTURA 1", "Fiktiva Fjällkund AB", "Förfallodatum: 2026-10-31",
                  "Beskattningsunderlag: 20000.00 SEK", "Moms 25 %: 5000.00 SEK", "TOTALT: 25000.00 SEK"),
            "B": ("FAKTURA 2", "Fiktiva Kustkund AB", "Förfallodatum: 2026-10-31",
                  "Beskattningsunderlag: 8000.00 SEK", "Moms 25 %: 2000.00 SEK", "TOTALT: 10000.00 SEK"),
            "kredit": ("KREDITFAKTURA 3", "Avser ursprunglig faktura 2",
                       "Beskattningsunderlag: -8000.00 SEK", "Moms 25 %: -2000.00 SEK", "TOTALT: -10000.00 SEK"),
        }
        assert all(text in contents for text in expected_pdf[name]), (name, contents)
        (evidence / f"pdf-{name}.txt").write_text(contents)
    return trace


def verify_exports(work, evidence, final, receipt, trace):
    json_export = json.loads((work / "export.json").read_text())
    assert json_export["vouchers"] == final["vouchers"]
    assert json_export["reports"] == final["reports"]
    assert base64.b64decode(json_export["documents"][0]["content"]) == receipt.read_bytes()
    assert json_export["invoices"][-1]["original_id"] == json_export["invoices"][1]["id"]
    assert all("Testkompassen AB" == json.loads(i["snapshot"])["company"]["name"] for i in json_export["invoices"])
    trace["jsonExport"] = {
        "vouchers": len(json_export["vouchers"]),
        "invoices": len(json_export["invoices"]),
        "auditEvents": len(json_export["audit"]),
        "documentBytes": len(receipt.read_bytes()),
        "reports": json_export["reports"],
    }

    sie = (work / "bokforing.se").read_bytes().decode("cp437").replace("\r\n", "\n")
    prefix = ("#FORMAT", "#PROGRAM", "#SIETYP", "#FNAMN", "#ORGNR", "#RAR", "#VALUTA", "#VER", "#TRANS", "#IB", "#UB", "#RES")
    (evidence / "sie-utdrag.txt").write_text("\n".join(
        line for line in sie.splitlines() if line.startswith(prefix) or line in ("{", "}")
    ) + "\n")
    assert "#FORMAT PC8" in sie and "#RAR 0 20260101 20261231" in sie
    parsed = {}
    for line in sie.splitlines():
        header = re.match(r'#VER "[^"]+" (\d+) (\d{8}) ', line)
        entry = re.fullmatch(r"#TRANS (\d+) \{\} (-?\d+\.\d{2})", line)
        if header:
            number = int(header[1])
            parsed[number] = {"date": header[2], "postingsOre": {}}
        if entry:
            parsed[number]["postingsOre"][entry[1]] = int(Decimal(entry[2]) * 100)
    assert len(parsed) == 6
    for v in final["vouchers"]:
        assert parsed[v["number"]] == {
            "date": v["date"].replace("-", ""),
            "postingsOre": {l["account"]: l["debit"] - l["credit"] for l in v["lines"]},
        }
    exported_balances = {
        account: int(Decimal(amount) * 100)
        for account, amount in re.findall(r"^#(?:UB|RES) 0 (\d+) (-?\d+\.\d{2})$", sie, re.MULTILINE)
        if Decimal(amount)
    }
    assert exported_balances == {a["number"]: a["balance"] for a in final["reports"]["trialBalance"] if a["balance"]}
    assert sum(exported_balances.values()) == 0
    assert all(Decimal(amount) == 0 for amount in re.findall(r"^#IB 0 \d+ (-?\d+\.\d{2})$", sie, re.MULTILINE))
    trace["sieExport"] = {"vouchers": parsed, "nonzeroBalancesOre": exported_balances}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="balans-kontroll-") as run_dir:
        run(Path(run_dir), args.output.resolve(), args.chromium)
    print("K-00 till K-08 passerade. Underlag:", args.output)
