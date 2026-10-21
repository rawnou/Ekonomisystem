# Faktisk verifiering

Granskningsdatum 2026-10-21, Windows, Node v24.19.0, SQLite 3.53.3. Syntetiska testdata. Inga produktions- eller verkliga bankuppgifter.

## Slutlig automatiserad körning

`node --test`: **38 tester, 38 godkända, 0 fel**, cirka 3,9 sekunder i den sista registrerade körningen före leveransdokumentation. Testfiler: `domain.test.mjs`, `http.test.mjs`, `sie.test.mjs`, `security-review.test.mjs`, `quality-review.test.mjs` i `tests/`.

`node --check public/app.js`: exit 0. Inga externa runtime-beroenden installerades; ingen byggtranspilering krävs.

Koden formaterades med den tillfälligt hämtade utvecklingsverktygsversionen `pnpm dlx prettier@3.6.2 --write ...`; ingen Prettier-kod ingår i applikationens runtime. `git diff --check` passerade efter normalisering av radslut. Testsviten kördes också efter formateringen: fortfarande 38/38 gröna. CLI-backup och återställning av den lokala demodatabasen verifierade dessutom 12 verifikationer och ett underlag i en ny databasfil.

| Begärt testfall          | Observerad kontroll                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Faktura 20 000 + 25 %    | Faktura 2 500 000 öre, 1510/3041/2611 och balansekvation verifierade                                              |
| Delbetalning             | Restfordran, status, full betalning och avvisad överbetalning                                                     |
| Kredit                   | Separat numrerad negativ faktura, originalreferens, intäkts-/momsmotbokning                                       |
| Dubbelimport             | Samma fil, ändrad fil, manuell bankrad; olika perioder/källreferenser bevaras                                     |
| Felaktig CSV             | Fel kolumnantal, citat, datum, mappning och tvetydiga identiska rader ger atomärt avslag                          |
| Obalanserad verifikation | Avvisad utan poster eller förbrukat nummer                                                                        |
| Låst/oföränderlig post   | Periodspärr, DB UPDATE/DELETE-spärr och separat motbokning                                                        |
| Behörighet               | Domän samt HTTP: viewer skriver inte, adminexport spärras, okänd användare spärras                                |
| Utländsk valuta          | Original EUR bevaras, SEK-omräkning kräver kurs, ingen dubbelbokning                                              |
| Kursdifferens            | Manuellt bokförd SEK-fordran och separat kursvinst med 3960, ej automatiskt valutafakturaflöde                    |
| Backup/restore           | Riktig diskbackup till ny DB, jämförda rapporter/historik, sessioner borttagna, korrupt hash avvisad              |
| Samtidighet              | Två samtidiga HTTP-fastställelser och betalningar ger endast en giltig bokning; versionskonflikt                  |
| SIE                      | Känt oberoende saldoexempel, CP437-bytes, separat rättelse, brutet år, balans/resultat, BigInt, felposter avvisas |
| Saknade/brutna underlag  | Saknat id avvisas, fel filsignatur avvisas, oföränderlig lagring, korrupt innehåll stoppas vid nedladdning        |

Oberoende granskare skrev 13 egna regressionstester efter att ha reproducerat fel. Se granskarnas rapporter för fynd och omgranskning. SIE-agenten skrev dessutom nio separata exportspecifika tester.

## Faktiskt webbläsarprov

Den lokala servern startades med `node src/server.mjs`. I appens webbläsare öppnades http://127.0.0.1:3210, en av de två genererade användarna loggades in, dashboarden lästes och inspekterades visuellt, fakturavyn öppnades och en faktura med en rad à 20 000 kr sparades. Gränssnittet visade nytt utkast på 25 000 kr. Detta använder riktig databas/API, inte en statisk mock. Senare serveromstart gjordes för att ladda slutliga rättningar.

Frontendagenten körde dessutom JavaScript-VM-baserade renderingstester för åtta vyer som admin/viewer, escaping, BigInt-formattering och separata valutasummor. Dessa är utförda röktester, inte en incheckad automatisk Playwright-svit. Desktopvy provad; ingen komplett mobil-/tillgänglighetsmatris har genomförts. `docs/dashboard.png` visar det verkliga gränssnittet med syntetiska databasposter.

## PDF-verifiering

Generatorn exporterade en normal faktura och en extrem faktura med 500-teckens fält och obrutna ord. pypdf läste **1 respektive 2 sidor**. pdfplumber verifierade att samtliga **4 549 icke-blanka texttecken** låg inom kontrollerade marginaler (x 45–547, y 35–810 på A4). Båda dokumenten renderades med den bundlade Poppler `pdftoppm.exe`, och alla tre sidor inspekterades visuellt. Inga avklippta rader eller överlappningar observerades. Poppler skrev varningar om oanvända systemfonter Symbol/ArialUnicode; de använda Courier-sidorna renderades och kontrollerades. Mellanfiler ligger under ignorerade `data/qa/`.

## Begränsat prestandaprov

Faktiskt kört som fristående Node-script mot en ny minnesdatabas:

- 1 000 CSV-rader: 1 000 införda, 0 dubbletter, **31 ms**.
- 100 atomära verifikationer: **11 ms**.
- SIE-export av 100 verifikationer: **12 520 byte, 23 ms**.

Detta är ett litet syntetiskt snabbprov, inte ett belastningslöfte. Disk, många års data, samtidiga processer, stress, diskfull och kraschåterställning är inte provade.

## Kvarvarande verifieringsgränser

Extern SIE-validator/provimport, verkliga leverantörsfiler, extern redovisnings-/juridikgranskning, full momsrapport, drift-TLS, filskanning och oberoende extern backup är inte godkända eller slutförda. Inga påståenden om juridiskt godkänt ekonomisystem eller komplett Definition of Done görs.
