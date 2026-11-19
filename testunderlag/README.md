# Kör om Balans testkampanj

Kör från reporoten vid commit `1a70661b38bd86ba9ada8eb970f9f6140dac5fd7`. I ett nytt utcheckat repo kan du kopiera in hela katalogen `testunderlag/`. Programkoden och dess dokumentation följer med git-repot. Testprogrammen använder loopback och skapar en ny, separat temporär testdatabas per delkörning. De skriver aldrig till den ordinarie databasen. Testidentiteterna använder reserverade `example.test` och inga externa anslutningar ingår i flödena.

Krav för samma körning är Node.js 24+, Python med Playwright, Playwright Core för Node, Chromium, `pdftotext` (Poppler) och `iconv`. Nodepaket och webbläsare behövs för UI-testverktygen. Balans har inga externa runtime-beroenden. Sökvägen till Playwright Core nedan användes i den testade miljön. Peka den till modulens katalog om den finns på en annan plats. Delrapporterna innehåller körspecifika detaljer.

```bash
set -o pipefail
balans_qa_output="$(mktemp -d)"
balans_playwright_core="/opt/codex/cua_node/lib/node_modules/playwright-core"

# Befintlig svit. Exitkod 1 observerades på Linux, se T-01.
node --test > "$balans_qa_output/befintlig-testsvit.txt" 2>&1
node --check public/app.js

# Kontrollscenario, försäljning, import, bokföring och återställning.
python testunderlag/kontroll/kor.py --output "$balans_qa_output/kontroll"
PLAYWRIGHT_CORE="$balans_playwright_core" \
  node testunderlag/forsaljning/kor.mjs "$balans_qa_output/forsaljning"
python testunderlag/import/prova.py > "$balans_qa_output/import.txt"
PLAYWRIGHT_MODULE="$balans_playwright_core" BALANS_QA_OUTPUT="$balans_qa_output" \
  node testunderlag/bokforing/kor.mjs > "$balans_qa_output/bokforing.jsonl"
python testunderlag/aterstallning/kor.py > "$balans_qa_output/aterstallning.json"
```

En lyckad körning av ett testprogram innebär att de förväntade observationerna återkom, även i scenarier där resultatet är underkänt. Status i rapporten mäter Balans mot arbetsflödets facit. Datum för körning, port, filhash för SQLite-backup och tidsstämplar i exporten kan variera. Fiktiva PDF-underlag och säkerhetskopior skapas lokalt av testprogrammen. Rapportpaketet innehåller läsbara utdrag, skärmbilder och testfiler för att återskapa resultaten.

| Körning | Filer |
| --- | --- |
| Befintlig testsvit | [Körutskrift](befintlig-testsvit.txt) · [Miljö](miljo.txt) |
| Kontrollscenario K | [Stegfacit](kontroll/facit.json) · [Kontoutdrag](kontroll/kontoutdrag.csv) · [Kvittoförlaga](kontroll/kvitto.txt) · [Utfallet steg för steg](kontroll/utfall/resultat.json) · [Avkodad SIE](kontroll/utfall/sie-utdrag.txt) |
| Försäljning F | [Fiktiva testdata](forsaljning/testdata.json) · [Utfallet per test](forsaljning/utfall.json) |
| Import I | [Prova import](import/prova.py) · [Körutskrift](import/korning.txt) |
| Bokföring R | [Facit](bokforing/facit.json) · [Utfallet per test](bokforing/korning.jsonl) |
| Återställning A | [Fiktiva testdata](aterstallning/testdata.json) · [Utfallet per test](aterstallning/resultat.json) |
