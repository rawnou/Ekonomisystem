"""Verifiera bankmatchning och betalningsrättelse i Chromium med kontrollfixtures."""
import sys
from pathlib import Path
import tempfile

from playwright.sync_api import expect

sys.dont_write_bytecode = True
import kor


def verify(page, url, work, evidence, email, password):
    original = exercise(page, url, work, evidence, email, password)

    def state():
        response = page.request.get(url + "/api/state")
        assert response.ok
        return response.json()

    def navigate(name):
        page.locator(f'nav [data-page="{name}"]').click()

    def submit(path, button):
        with page.expect_response(lambda r: r.url == url + path and r.request.method == "POST") as saved:
            button.click()
        response = saved.value
        assert response.status == 200, response.text()

    def prompts(*values):
        answers = iter(values)
        handler = lambda dialog: dialog.accept(next(answers))
        page.on("dialog", handler)
        return handler

    navigate("invoices")
    invoice = state()["invoices"][-1]
    handler = prompts("500", "2026-10-12")
    invoice_row = page.get_by_role("row").filter(has_text="Fiktiva Fjällkund AB")
    submit(f'/api/invoices/{invoice["id"]}/payment', invoice_row.get_by_role("button", name="Betalning"))
    page.remove_listener("dialog", handler)
    navigate("bank")
    for csv in [kor.HERE / "kontoutdrag.csv", kor.HERE.parent / "import/fixturer/bank.csv"]:
        form = page.locator('[data-form="import"]')
        form.locator('[name="file"]').set_input_files(csv)
        submit("/api/imports", form.get_by_role("button", name="Importera transaktioner"))
        expect(page.locator("#notice")).to_contain_text("Import klar")

    prior = state()
    for reference, voucher_number in [("BANK-KUND01", 7), ("KVITTO-001", 6)]:
        bank_row = page.get_by_role("row").filter(has=page.get_by_role("cell", name=reference, exact=True))
        bank_id = next(b["id"] for b in prior["bank"] if b["reference"] == reference)
        bank_row.get_by_role("button", name="Klassificera").click()
        form = page.locator('[data-form="bank-match"]')
        expect(form.get_by_role("combobox")).to_contain_text(f"A{voucher_number}")
        submit(f"/api/bank/{bank_id}/match", form.get_by_role("button", name="Matcha utan ny bokföring"))
        expect(bank_row).to_contain_text(f"Bokförd · A{voucher_number}")
        assert state()["vouchers"] == prior["vouchers"]
        assert state()["reports"] == prior["reports"]

    navigate("ledger")
    payment = prior["vouchers"][0]
    handler = prompts("Felregistrerad fiktiv betalning", "2026-10-13")
    submit(f'/api/vouchers/{payment["id"]}/reverse',
           page.get_by_role("button", name="Återför betalning").first)
    page.remove_listener("dialog", handler)
    current = state()
    assert current["reports"]["receivables"] == 1_500_000
    assert current["reports"]["cash"] == 5_500_000
    assert next(a for a in current["reports"]["trialBalance"] if a["number"] == "1510")["balance"] == 1_500_000
    assert current["vouchers"][0]["reversal_of"] == payment["id"]
    assert next(b for b in current["bank"] if b["reference"] == "BANK-KUND01")["voucher_id"] is None
    assert next(b for b in current["bank"] if b["reference"] == "KVITTO-001")["voucher_id"] == 6
    print("I-13/I-14 Chromium: 500 kr kundbetalning och 5 000 kr kvitto matchade utan ny verifikation.")
    print("F-12 Chromium: återföring via A8 öppnade betalningens bankrad och återställde 1510 till 15 000 kr.")
    navigate("bank")
    for name in ["bank-referenslost-1.csv", "bank-referenslost-2.csv"]:
        form = page.locator('[data-form="import"]')
        form.locator('[name="file"]').set_input_files(kor.HERE.parent / "import/fixturer" / name)
        submit("/api/imports", form.get_by_role("button", name="Importera transaktioner"))
        expect(page.locator("#notice")).to_contain_text("Import klar")
    ambiguous = page.get_by_role("button", name="Granska möjlig dubblett")
    ambiguous.click()
    fees = [b for b in state()["bank"] if b["description"] == "Fiktiv kortavgift"]
    assert len(fees) == 2
    review = page.locator('[data-form="bank-review"]')
    review.locator('[name="decision"]').select_option("distinct")
    pending = next(b for b in fees if b["review_status"] == "pending")
    submit(f'/api/bank/{pending["id"]}/review', review.get_by_role("button", name="Spara bedömning"))
    expect(ambiguous).to_have_count(0)
    fees = [b for b in state()["bank"] if b["description"] == "Fiktiv kortavgift"]
    assert sorted(b["review_status"] or "" for b in fees) == ["", "distinct"]
    print("I-12 Chromium: båda referenslösa avgifter sparades, den möjliga dubbletten godkändes separat.")
    return original


if __name__ == "__main__":
    exercise = kor.exercise
    kor.exercise = verify
    with tempfile.TemporaryDirectory(prefix="balans-p0-ui-") as directory:
        work = Path(directory)
        kor.run(work, work / "evidence", "/usr/bin/chromium")
