# Verifiering av rättningar i Balans

Testat lokalt med fiktiva uppgifter från TESTRAPPORT.md, Node.js 24.22.1, SQLite 3.53.4 och Chromium 156.0.8078.79. Varje körning använde egna tillfälliga databaser.

| Tidigare test | Omprov |
| --- | --- |
| F-11, T-03 | Samma betalnings-ID gav ett resultat och en betalningsverifikation vid två samtidiga och två senare försök. Samma ID med ändrad summa eller faktura avvisades. En filbaserad SQLite-kopia behöll begärande-ID för betalning och manuell verifikation efter omstart. |
| F-12, I-13–I-15, R-08 | I Chromium matchades kundbetalningen på 500 kr och kvittot på 5 000 kr utan extra kontering. Återföringen öppnade den matchade bankraden. I det separata R-08-provet fick konto 1510 och reskontran båda 10 000 kr. En motbokad bankhändelse kunde omklassificeras. |
| F-14/F-15, I-08–I-12 | Okända faktura- och kreditfält samt tom och ogiltig valuta avvisades atomärt. Två samtidiga importer gav en importpost och två unika bankrader. Två referenslösa avgifter bevarades. Den tvetydiga raden kunde godkännas som separat händelse i Chromium och bokföras efter granskning i regressionstestet. |
| R-09, R-11 | Fem år avvisades vid inställning, bokföring och SIE. Giltigt brutet år, förkortat första år och 18 månader exporterades med korrekta datum. Ett tidigare sparat ogiltigt intervall kunde rättas när alla poster rymdes i den nya perioden. |
| A-01/A-02a, T-04 | Återkallad session nekades före skrivning. De befintliga rollkontrollerna passerade. |
| A-06 | CLI skapade och återställde en giltig kopia, och nästa verifikation fick A2. En efterföljande kopia med A2 men räknare 1 avvisades. Regressionstester kontrollerade även att en korrekt filhash inte räcker vid ogiltig serie och att en frisk kopia fortsätter med både nästa verifikation och nästa fakturanummer. |
| K-00–K-08 | Sex balanserade verifikationer med 110 000 kr vardera i debet och kredit. Bank 55 000 kr, kundfordran 15 000 kr, resultat 16 000 kr och nettomoms 4 000 kr. Avkodad SIE och JSON-export kontrollerades mot bokföringen. |

[Körutskrift för Node](rattningar-svit.txt) · [Chromiumprov för matchning, rättelse och dubblettgranskning](rattningar-ui.txt) · [Kontrollscenariots belopp och exportjämförelser](rattningar-kontroll.json)

## Återskapa

```sh
node --test
node --check public/app.js
python testunderlag/kontroll/kor.py --output "$(mktemp -d)"
python testunderlag/kontroll/kor-p0.py
```

## Kod och databas

- `src/domain.mjs` och `src/server.mjs` hanterar beständiga begärande-ID:n, matchning, betalningsrättelse, dubblettgranskning och sessionskontroll i skrivtransaktionen.
- `src/imports.mjs`, `src/fiscal.mjs` och `src/sie.mjs` validerar valuta och räkenskapsår. `src/backup.mjs` kontrollerar nummerserier vid backup och återställning.
- `public/app.js` använder beständiga begärande-ID:n vid återförsök och visar förslag, explicit matchning och granskning. `README.md` och `docs/ARKITEKTUR.md` beskriver gränssnitt och API.
- Berörda `tests/audit-*.test.mjs` och `tests/quality-review.test.mjs` verifierar rättningarna. Chromiumprovet återanvänder fiktiva CSV-filer från den ursprungliga rapporten.
- Nästa start av en befintlig SQLite-databas skapar `booking_requests`, `bank_reviews` och ett index för bankradens verifikationslänk. Banken öppnar tidigare motbokade länkar och loggar varje förändring. Befintliga verifikationer skrivs aldrig om vid uppgraderingen.

Matchningsförslag använder samma omräknade belopp och ett intervall på tre dagar. Kända verifikationer kan matchas med nummer även utanför intervallet. Äldre API-klienter som utelämnar begärande-ID behöver lägga till en stabil nyckel för säkra återförsök. Tidigare tappade importposter och manuella rättelser behöver stämmas av mot sina källunderlag. Balans har fortfarande ett enda konfigurerat räkenskapsår. Flerradsfakturor, delkredit, årsövergång och extern SIE-provimport ligger kvar som separata delar av utvecklingsplanen. [Ursprunglig testrapport](../../TESTRAPPORT.md)
