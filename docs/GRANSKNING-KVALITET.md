# Oberoende kvalitetsgranskning

Datum: 2026-10-21. Granskare: separat kvalitetsagent. Endast detta dokument ändras av granskaren. Inget juridiskt godkännande lämnas.

## Underlag och faktiskt körda kontroller

Läst AGENTS.md, docs/ARKITEKTUR.md, användarens masterprompt, src/domain.mjs, imports.mjs, money.mjs, pdf.mjs, server.mjs, backup.mjs samt domäntester. `node --test` kördes: **25 tester, 25 godkända, 0 fel**. Detta omfattar domän, HTTP, SIE och backup/restore. Därefter kördes separata Node-program mot minnesdatabas för reproduktionerna nedan. En godkänd befintlig testsvit innebär inte att identifierade gränsfall är godkända.

## Konkreta fynd före rättning

### Q1 – P1: legitima importerade transaktioner försvinner i dubblettkontroll

Plats: `src/domain.mjs:181`, `_bank`.

Fingerprint består av källa, datum, belopp, valuta och referens eller beskrivning. Rapportperiod ingår inte. Importera följande som KDP:

```csv
date;description;amount;currency;period
2026-10-01;Marketplace;100.00;SEK;2026-08
2026-10-01;Marketplace;100.00;SEK;2026-09
```

Observerat: `{inserted:1,duplicates:1}`; endast augustiposten bevaras. Motsvarande problem finns för två verkliga bankhändelser med samma datum, belopp och beskrivning utan unik referens. Dessa kan inte säkert klassas som samma transaktion med nuvarande underlag.

Risk: ekonomiskt datatapp. Rättning: stabilt käll-ID när det finns, källa/rapportperiod i relevant identitet samt bevarande och explicit granskning av tvetydiga kollisioner. Ett hashvärde av identiska ekonomiska fält är inte bevis på dubbelimport. Testa både upprepad fil och flera legitima lika rader.

### Q2 – P1: felstavad valutamappning ändrar EUR till SEK utan fel

Plats: `src/imports.mjs:42–49`, `normalizeCSV`.

Anropa med CSV `date;description;amount;currency\n2026-10-01;EUR payout;100;EUR` och `mapping:{currency:'currncy'}`. Observerat: originalets EUR blir `currency:'SEK'`, `amount:10000`.

Risk: fel valuta kan därefter bokföras utan omräkning. Rättning: avvisa varje explicit mappad kolumn som inte finns, även valfria fält. Kräv tydlig bekräftelse på standardvaluta när valutakolumn faktiskt saknas. Testa felstavning av currency, reference och period.

### Q3 – P1: bankbokning mot kundfordran lämnar fakturan obetald

Plats: `src/domain.mjs:200–211`, `bookBank`, tillsammans med `payment` och `reports`.

Skapa och fastställ faktura 100 kr + 25 % moms. Registrera bankinbetalning 125 kr och bokför med `account:'1510',reviewed:true`. Observerat: huvudbok 1510 har saldo 0, men fakturan står kvar som issued och `reports().receivables` är 12500 öre. Registreras betalning i fakturaflödet också, bokförs 1930/1510 en gång till.

Risk: reskontra och huvudbok divergerar; användaren kan dubbelföra bankinbetalningen. Rättning: atomisk fakturamatchning med bokföring, reskontrauppräkning och bankkoppling i samma transaktion. En säker begränsning tills detta finns är att avvisa 1510 i det generella bankbokningsflödet och dokumentera separat fakturabetalningsväg.

### Q4 – P2: accepterat fakturautkast kan aldrig fastställas

Plats: `src/domain.mjs:95–99`, `src/money.mjs:21–25`, fakturafastställelse.

Skapa quantity='1', unitPrice='9000000000', vatRate=25. Utkastet accepteras med netto 900000000000 öre och total 1125000000000 öre. `issue` misslyckas med 'Beloppet är för stort' eftersom debetbeloppet passerar decimalfunktionens gräns 1000000000000 öre.

Risk: återvändsgränd och inkonsekvent validering. Rättning: validera totalbelopp mot samma beloppsgräns redan vid utkast eller definiera en konsekvent gemensam gräns för alla bokföringsled. Transaktionsåterställning vid misslyckad fastställelse fungerar i reproduktionen.

### Q5 – P1: giltiga fakturauppgifter hamnar utanför PDF-sidan

Plats: `src/pdf.mjs:22–28`.

PDF har alltid exakt en sida och 16 punkters radavstånd från y=790. Servern accepterar upp till 500 tecken per kund-/företagsfält. Med långa tillåtna namn, adresser, bankuppgifter och beskrivning ger reproduktionen 60 textrader: sista baslinje y=-154, betalningsuppgifter utanför sidan. En kund med namn 'K'.repeat(500) ger dessutom en obruten PDF-rad på 508 tecken som inte radbryts.

Risk: exporterad faktura saknar synliga betalnings- eller andra uppgifter. Rättning: sidbrytning, faktisk teckenbreddsbaserad radbrytning och delning av långa ord, alternativt tydliga servergränser som garanterar layouten. Rendera PDF visuellt efter rättning; befintligt test kontrollerar bara PDF-signatur och textsträngar. Reproduktionen har kontrollerat innehållsström/geometri, inte en bildrendering.

## Styrkor och kontrollerade gränser

Transaktioner använder BEGIN IMMEDIATE; nummerserie, verifikation och historik skrivs tillsammans. Fakturafastställelse och company-inställningar har versionskontroll. Testsviten verifierar avvisad dubbel fastställelse, överbetalning, låst period, motbokning, rollkontroll, CSRF och dokumenthash. Snapshot bevarar ursprungliga kunduppgifter i PDF trots ändrad kundpost.

Backup/restore-testet jämför återställda rapporter, avvisar fel checksumma och befintligt återställningsmål samt tar bort sessioner. Granskningen omfattar inte processkrasch under backup, full disk, parallell backup/restore eller uppstart av återställd databas från en annan programversion. Sådan driftsäkerhet är ännu inte verifierad.

`reports()` beräknar grundläggande resultat, balans och månadstal. Ingen separat stress-/prestandakörning utfördes. Testad HTTP-samtidighet ska inte beskrivas som verifierad flernods- eller SaaS-drift.

## Kravluckor och slutbedömning

Fas 1 har körbar databas, API, grundläggande bokföring, fakturor och tester. Fas 2 är inte färdig: KDP/Adtraction använder generisk CSV-normalisering; avtalspart, utbetalningsstatus och bankmatchning saknas. Bankens invoice_id används inte av nuvarande flöde, och inget explicit avstämningsflöde med bankens externa slutsaldo finns. Rapporternas belopp ska inte beskrivas som kompletta momsrapporter. Automatiserad backup, full redovisningskontroll och produktionsberedskap får inte härledas från backupkommandot eller godkända enhetstester.

Ovanstående fynd gäller den lästa versionen före huvudagentens eventuella rättningar. P1-fynd behöver åtgärdas och få regressionstester innan respektive funktion uppfyller användarens definition of done. Granskaren har inte ändrat implementationen och har inte godkänt skarp användning.

## Återgranskning efter huvudagentens rättningar

Utförd oberoende 2026-10-21. Åtta regressionstester skrivna av kvalitetsgranskaren i `tests/quality-review.test.mjs`. `node --test tests/quality-review.test.mjs` kördes efter de första sex testerna: **6/6 godkända**. Efter komplettering och huvudagentens sista importfix kördes hela `node --test`: **38 tester, 38 godkända, 0 fel**. Testsviten innehåller då även andra agenters tester; endast åtta tester i quality-review-filen är skrivna av denna granskare.

Status för fynd:

- **Q1 rättad inom dokumenterad importbegränsning:** källa, rapportperiod och referens skiljer legitima poster. Samma fil och samma rader i ändrad fil dubbelimporteras inte. Flera tvetydigt identiska rader inom en fil avvisas innan importhistorik eller bankrader skapas. Testat för bank, KDP och Adtraction. Utan stabila unika referenser kan en ny likadan händelse i en annan fil fortfarande inte skiljas säkert från en redan importerad händelse. Användaren måste ge skilda verkliga händelser skilda referenser; ingen automatisk säker identifiering av sådana händelser påstås.
- **Q2 rättad:** felaktig explicit mappning för valuta, referens och period avvisas atomiskt; korrekt EUR-kolumn förblir EUR. När valutakolumn helt saknas används fortsatt SEK som standard; det är en dokumentations-/användningsbegränsning att kontrollera före import av utlandsrapporter.
- **Q3 säkert begränsad:** bankbokning direkt mot 1510 avvisas utan ändring av verifikationer, reskontra, bankkoppling eller rapporter. Full faktura-/bankmatchning är fortfarande inte implementerad. Fakturans betalningsflöde är separat och importerad motsvarande bankrad måste hanteras medvetet tills matchning finns.
- **Q4 rättad:** för stort totalbelopp avvisas redan före utkast. Exakt totalgräns 1000000000000 öre accepterades och fastställdes med balanserade poster.
- **Q5 rättad på struktur- och geometrinivå:** långa ord delas, sidor har högst 44 rader med högst 80 tecken i Courier 10. Syntetiskt maxlängdsfall ger flera sidor och bevarar kundnamn, total och betalningsuppgifter. Testet verifierar sidantal, sidobjekt, innehållsströmmar, textpositioner och samtliga xref-offsetar. Ingen bildrendering av PDF har utförts av denna granskare; full visuell QA ska inte påstås utifrån dessa tester.

Inga reproducerade P1-fynd i ovanstående åtta regressionstester kvarstår efter rättningarna och införda begränsningar. Kvarstående funktionsluckor i föregående avsnitt består; detta är inte ett godkännande av hela Fas 2 eller skarp drift. Tidigare fyndbeskrivningar bevaras som granskningshistorik och beskriver versionen före rättning.
