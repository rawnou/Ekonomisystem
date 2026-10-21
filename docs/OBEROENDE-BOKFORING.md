# Oberoende granskning: ekonomiska beräkningar och dubbel bokföring

Datum: 2026-10-21. Endast syntetiska data och SQLite `:memory:`. Produktionskod och befintliga filer har inte ändrats. Detta är teknisk felanalys, inte redovisningsmässigt eller juridiskt godkännande.

## Utförda kontroller

Läst `src/domain.mjs`, `src/money.mjs`, `src/imports.mjs`, `src/pdf.mjs`, `src/sie.mjs`, relevanta klientflöden, arkitektur/backlogg och befintliga domän-/kvalitetstester. De begränsningar som redan står i backloggen har granskats som verkliga kvarvarande risker, inte räknats som lösta.

Faktiskt kört på Node v24.19.0:

- `node --test tests/audit-accounting.test.mjs`: 8/8 godkända.
- `node --test tests/domain.test.mjs tests/quality-review.test.mjs tests/audit-accounting.test.mjs`: 30/30 godkända.

**De sex första nya proven är reproduktionsprov som förväntar sig nuvarande fel/riskbeteende. Att de är gröna bekräftar fynden; det betyder inte att felen är åtgärdade.** Vid rättning ska relevanta prov ändras till att kräva avvisning, idempotens eller avstämd rättelse.

Två nya kontrollprov verifierar 1 000 deterministiska pris-/antalskombinationer mot en separat BigInt-formel, negativ valutaavrundning samt att avvisad överbetalning inte ändrar data, historik eller nummerserie. Befintliga prov täcker balans, ordinarie kreditering, periodlås, övre fakturagräns, dubbla fastställanden och backup/återställning. Ingen verifierad räkneavvikelse hittades i dessa avgränsade avrundnings-/balansfall.

## Kritiska risker

Inga verifierade kritiska fynd inom detta granskningsområde. Detta säger inget om övriga granskningsområden eller ännu oprövade driftsituationer.

## Höga risker: verifierade fel

### AUD-A1: Upprepad delbetalningsförfrågan bokför samma betalning igen

- **Plats:** `src/domain.mjs:406` (`payment`), särskilt betalningskontrollen och `paid=paid+?`; HTTP-flödet skickar vidare förfrågan utan betalningsidentitet.
- **Reproduktion:** Fastställ en faktura på 100 SEK + 25 SEK moms. Kör två gånger `payment(id, {amount:"50", date:"2026-10-02", idempotencyKey:"same-synthetic-payment"}, 1)`. Samma nyckel ignoreras.
- **Verifierat utfall:** Två betalningsverifikationer; bank 100 SEK, fakturans `paid` 100 SEK och rest 25 SEK. Om detta var retry av en verklig betalning på 50 SEK är bank och kundfordran fel med 50 SEK. Överbetalningsspärren skyddar endast när det återstående beloppet understigs.
- **Konsekvens:** Ett förlorat HTTP-svar följt av nytt försök, eller två användare som registrerar samma delbetalning, kan övervärdera bank och dölja obetald fordran. Nätverksförlust i sig är inte simulerad; det identiska återförsöket är verifierat på domännivå.
- **Åtgärd:** Beständig betalningsidentitet/idempotensnyckel med unikhetskrav och lagrat resultat, atomiskt med verifikation och reskontra. Koppla verklig bankhändelse/betalningsallokering till samma transaktion. Två verkliga lika betalningar ska fortfarande kunna ha olika identiteter.
- **Prov:** `AUD-A1` i `tests/audit-accounting.test.mjs`.

### AUD-A2: Felregistrerad kundbetalning kan inte rättas med bibehållen reskontra

- **Plats:** `src/domain.mjs:406` (`payment`), `src/domain.mjs:443` (`credit`), `src/domain.mjs:497`–`507` (`reverse`).
- **Reproduktion:** Fastställ faktura 125 SEK, registrera felaktigt full betalning. Försök motboka betalningsverifikationen: alla fakturakopplade verifikationer avvisas. Försök kreditera: endast helt obetalda fakturor tillåts. Bokför sedan manuellt D1510/K1930 125 SEK.
- **Verifierat utfall:** Huvudbokens fordran återställs till 125 SEK och bank till noll, men fakturan står kvar som `paid`, `paid=12500`; `reports().receivables` är noll och den verkliga efterföljande betalningen avvisas.
- **Konsekvens:** Ett normalt rättelsefall kräver att användaren väljer mellan felaktig huvudbok och felaktig reskontra. Även delbetalda/betalda fakturors sakliga kreditering och återbetalning saknar komplett flöde. Underliggande bokningar är oföränderliga vilket är bra; bristen är en samordnad rättelsetransaktion.
- **Åtgärd:** Append-only betalnings-/allokeringsposter med uttrycklig återföring, ny motverifikation i öppen period, omräknat restbelopp/status och historik i samma transaktion. Håll rättelse av betalning skild från kreditering av försäljning och från utbetalad återbetalning.
- **Prov:** `AUD-A2`.

### AUD-A4: Rapporten över kundfordringar kan motsäga huvudboken utan avstämningsvarning

- **Plats:** `src/domain.mjs:282` (`post` tillåter 1510), `src/domain.mjs:766`–`768` (`receivables` summerar enbart vissa fakturastatusar); `public/app.js:100` beskriver detta som ”Saldo på kundfordringar”.
- **Reproduktion:** Skapa manuell balanserad verifikation D1510 100 SEK / K3044 100 SEK, utan faktura. Läs rapporten.
- **Verifierat utfall:** Saldobalans 1510 = 100 SEK, `receivables`/”Att få betalt” = 0 SEK. Samma differens kan uppstå genom manuell rättelse enligt AUD-A2 eller manuell kredit på en befintlig fakturafordran.
- **Konsekvens:** Översikten kan dölja kundfordringar eller uppmana till indrivning av reglerade belopp. Total balans kan fortfarande vara matematiskt korrekt; dubbel bokföring garanterar inte att sidoreskontran är korrekt.
- **Åtgärd:** Visa separat reskontrasaldo, huvudbokssaldo och differens med konkret avstämningslista. Kontrollera alla manuella 1510-bokningar: kräv reskontraallokering eller uttrycklig, spårad avstämningspost. Att bara byta rubrik löser inte datadifferensen.
- **Prov:** `AUD-A4` samt AUD-A2. Risken är även dokumenterad i tidigare backlogg.

### AUD-A5: Saknad valuta i uttrycklig valutakolumn blir automatiskt SEK

- **Plats:** `src/imports.mjs:105`; `src/domain.mjs:646`–`649` (`bookBank` ignorerar angiven kurs för SEK).
- **Reproduktion:** Importera CSV med kolumn `currency`, explicit mappning `{currency:"currency"}`, en EUR-rad och en annan rad med tom valutacell, båda belopp 100. Klassificera den tomma raden med `exchangeRate:"11"`.
- **Verifierat utfall:** Den tomma cellen accepteras som SEK. Bokningen blir 100 SEK; angiven kurs ersätts med `1.000000`. Originalets ”okänd valuta” går inte längre att skilja från uttryckligt angiven SEK i normaliserad rad.
- **Konsekvens:** Om raden avsåg EUR är bokfört belopp 100 SEK i stället för 1 100 SEK. Den avsedda valutan kan inte bestämmas automatiskt; det verifierade felet är att saknad information omvandlas till en giltig valuta och kan bokföras utan att luckan synliggörs. Ingen verklig leverantörsfil har använts.
- **Åtgärd:** När valutakolumn finns eller uttryckligen mappats, kräv ifylld giltig valutakod på varje rad och avvisa importen atomiskt. För filer utan valutakolumn: kräva ett synligt, bekräftat filomfattande valutaval och bevara detta val i proveniensen. Bevara originalfilen.
- **Prov:** `AUD-A5`.

## Medelhöga risker: verifierade fel

### AUD-A3: Motbokad bankrad visas fortfarande som bokförd och kan inte klassificeras på nytt

- **Plats:** `src/domain.mjs:497` (`reverse`), `src/domain.mjs:635`, `src/domain.mjs:679`; `public/app.js:175`, `public/app.js:554`.
- **Reproduktion:** Registrera bankutbetalning −100 SEK, bokför mot 5410, motboka verifikationen påföljande dag på grund av fel konto, försök bokföra samma bankrad mot 5420.
- **Verifierat utfall:** Nettobokföring på bank blir noll, men bankraden har kvar `voucher_id`. Ny klassificering avvisas som redan bokförd; klienten visar ”Bokförd” och utesluter raden från att-göra-antalet.
- **Konsekvens:** Verklig bankhändelse kan lämnas obokförd medan arbetslistan påstår motsatsen. Manuell ny verifikation är möjlig men dess koppling till bankraden saknas och rättad kontering syns inte som bankradens aktuella bokning.
- **Åtgärd:** Modellera append-only bankallokeringar/rättelser och härled aktuellt bokföringsläge från dessa. Samordna motbokning och ny klassificering med historik och periodkontroller; behåll referenser till ursprung och samtliga rättelser.
- **Prov:** `AUD-A3`.

## Medelhöga risker: misstänkta risker och produktbegränsningar

### AUD-A6: Dubblettheuristik kan undertrycka en annan verklig bankhändelse

- **Plats:** `src/domain.mjs:29`–`43` (`bankFingerprint`), `src/domain.mjs:562` (`INSERT OR IGNORE`), `src/domain.mjs:593`–`600` (dublettkontroll).
- **Reproduktion:** Registrera två syntetiskt olika verkliga kortköp samma datum, belopp och beskrivning, utan unik källreferens. Första skapas; andra returnerar `inserted:false`. I samma fil avvisas tvetydiga dubbletter i stället, vilket är bättre än tyst bortfall.
- **Verifierat utfall:** Heuristiken kan inte representera båda händelserna utan att användaren tillför olika referenser. Huruvida två rader i verklig fil är samma eller olika ekonomiska händelser kräver källmaterial; faktisk dataförlust i verklig import är inte verifierad.
- **Konsekvens:** Fullständighet kan inte garanteras för banker vars filer saknar stabil transaktionsidentitet. Mellan filer kan en verklig händelse rapporteras som dubblett trots annan verklig identitet.
- **Åtgärd:** Bankformatspecifika stabila identiteter, separat markering av möjliga dubbletter, granskat beslut att slå samman eller behålla, originalfiler samt saldoavstämning. Inför inte en generell ”tillåt dubblett” utan spårning.
- **Prov:** `AUD-A6`.

Ytterligare betydande, redan dokumenterade begränsningar: ingen atomisk bank-/fakturamatchning, inga rapporter per vald brytdag, inga ingående balanser/flerårsövergångar, begränsad kontoplan, ingen momsrapport och inget komplett kundkredit-/återbetalningsflöde. De är hinder för bred skarp användning även om enskilda stödjade bokningar balanserar. SIE hanterar ingående balanser som noll enligt sin uttryckliga funktionsbeskrivning; det har inte här tolkats som en felaktig implementation av en utlovad öppningsbalansfunktion.

## Låga risker

Inga separata verifierade lågriskfynd prioriterade inom detta område.

## Extern sakkunskap och redo-bedömning

En verklig redovisningskunnig behöver kontrollera de avsedda affärsfallen, kontoplan och momskoder, fakturainnehåll och avrundningspolicy, hantering av ingående balanser och årsavslut, valuta- och avstämningsrutiner samt provimport i mottagande ekonomisystem. De tekniska proven visar endast vad programmet gör, inte att samtliga redovisningskrav är uppfyllda.

**Tekniskt:** Möjligt att använda som avgränsad lokal pilot med enbart syntetiska testdata, aktiv manuell avstämning och tydligt kända begränsningar. Fel- och rättelsefallen ovan bör ingå i piloten. Den är inte redo för obevakad eller bred redovisningspilot där korrekta reskontra-/bankstatusar förutsätts.

**Skarp bokföring:** Inte redo. Hindren omfattar framför allt betalningsidempotens, fullständiga betalningsrättelser, bank-/reskontraavstämning, explicit validerad valuta samt de dokumenterade funktionella luckorna. Denna bedömning omfattar ekonomimotorn; säkerhet, drift och svensk regelverksgranskning bedöms separat.

AI-agenternas tester och granskning ersätter inte en verklig redovisningsmässig kontroll innan systemet används för bolagets officiella bokföring. Ingen juridisk acceptans lämnas.
