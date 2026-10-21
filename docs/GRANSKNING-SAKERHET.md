# Oberoende säkerhets- och integritetsgranskning

Datum: 2026-10-21. Granskare: separat säkerhetsagent, som inte skrev implementationen. Omfattning: src/domain.mjs, security.mjs, server.mjs, money.mjs, imports.mjs, pdf.mjs, backup.mjs, sie.mjs och public/app.js. Inga implementationsfiler ändrades under granskningen. Implementationen utvecklades samtidigt; fynd nedan gäller observerad version och behöver verifieras efter rättning.

## Uppföljning efter rättning – verifierad 2026-10-21

De tre P1-fynden är stängda efter oberoende kodkontroll och regressionstester. JSON-exportens saknade snapshot är också rättad. Scrypt använder nu uttryckligen N=131072,r=8,p=1,maxmem=256 MiB; detta verifierades genom oberoende härledning med Node crypto. Hashformatet saknar fortfarande versions-/parameterfält och funktionen är fortfarande synkron. Dessa delar av P2-fyndet kvarstår som dokumenterad driftbegränsning, särskilt inför nätåtkomst och produktionsdrift.

Fem oberoende tester finns i tests/security-review.test.mjs: initiering/ominitieringsskydd, avvisade interna relationer med fortsatt fungerande riktig motbokning, atomär beloppsgräns med bevarade poster/historik/nummerserie/rapporter, fryst snapshot vid ändrade företagsuppgifter och explicit hashparameterkontroll.

Den valda beloppsrättningen sätter en global ackumulerad debetgräns på 100 000 000 000 000 öre. Kontrollen sker med BigInt i samma skrivtransaktion och före nummerserie, bokföringsrader och audit. Regressionstestet fyllde exakt gränsen med två stora verifikationer och kontrollerade att nästa bokning nekades utan mutationer samt att rapporterna fortfarande gick att läsa. Gränsen förbrukas även av rättelser och betalningar; om den nås krävs teknisk migrering innan ytterligare bokföring, även motbokningar. Denna lokala kapacitetsgräns ska vara tydlig i dokumentationen.

Kört kommando: `node --test`. Faktiskt resultat efter rättning: 30 tester, 30 godkända, 0 misslyckade, cirka 4,2 sekunder. Detta omfattar också huvudagentens HTTP-tester för roller/CSRF/Origin/Host/samtidighet, backup/restore och oberoende SIE-fixturetester. Första körningen av de fem nya testerna gav 4/5 på grund av ett fel i granskarens audit-jämförelse (prototyp och null-aktör), vilket rättades i testet; ingen produktionskod ändrades av granskaren.

Slutsats för den granskade lokala syntetiska versionen: inga kvarstående verifierade P1-fynd från denna granskning. Detta innebär inte produktionsgodkännande. Gränserna för lokal HTTP, synkron inloggningshashning, filskanning och extern driftberedskap gäller fortsatt.

## Ursprungliga fynd (historik; se status ovan)

### P1 – Klienten får ange interna rättelse- och fakturarelationer

Plats: src/domain.mjs, post() omkring rad 102 och \_post() omkring rad 116; src/server.mjs POST /api/vouchers.

post vidarebefordrar hela klientobjektet till \_post, som accepterar reversalOf och invoiceId utan den kontroll som finns i reverse respektive fakturaflödena. Ett vanligt bokföringsanrop kan därmed utge sig för att vara rättelse av en godtycklig verifikation, även en fakturaverifikation, med valfria balanserade rader och datum före originalet. Ett oförändrat debet/kredit-par kan markeras som rättelse. Den unika relationen gör därefter att en riktig motbokning nekas. Godtycklig invoiceId gör också att en manuell verifikation inte längre kan rättas genom reverse.

Verifierat i separat minnesdatabas: original 2026-01-02 D1930/K3041 100 SEK, sedan post 2026-01-01 med reversalOf=original.id och D1930/K3041 1 SEK accepterades. SQL returnerade {reversal_of:1,date:"2026-01-01"}. Riktig reverse gav fel att verifikationen bara får motbokas en gång.

Rättning: bygg uttryckligen ett publikt objekt med endast date, text, lines och documentId i post; avvisa interna relationsfält. Interna flöden får skapa relationer först efter sina egna kontroller. Lägg regressionstester via HTTP för både reversalOf och invoiceId, inklusive försök mot fakturaverifikation.

### P1 – Giltiga belopp kan permanent slå ut rapporter och hela webbgränssnittets dataladdning

Plats: src/domain.mjs reports(), omkring rad 221–225 och state() rad 228.

Radgränsen är 10^12 öre, men SUM returneras från SQLite till JavaScript Number utan BigInt-läsning. Ackumulerade belopp över Number.MAX_SAFE_INTEGER orsakar ERR_OUT_OF_RANGE. Alla poster accepteras först, sedan misslyckas /api/state eftersom den alltid beräknar rapporter. Felet kvarstår efter omstart. Även summeringar mellan flera säkra kontosaldon måste hållas exakta.

Verifierat i minnesdatabas med 181 giltiga verifikationer om 100 rader vardera, 50 debetrader på 1930 och 50 kreditrader på 3041, varje rad 10 000 000 000 SEK. state() gav: ERR_OUT_OF_RANGE Value is too large to be represented as a JavaScript number: 9050000000010100. Testet hade även originalposterna från föregående kontroll.

Rättning: läs aggregat som BigInt, summera med BigInt och skicka decimalsträngar för öre till klienten (klientens money stöder redan strängar). Undvik även SQL SUM-överflöde över 64-bitarsgränsen genom att summera individuella rader med BigInt eller dokumentera och atomärt upprätthålla en totalgräns. Testa kontosumma, rapporttotal och export över safe-integer-gränsen.

### P1 – Första installationen misslyckades i observerad version

Plats: src/domain.mjs seed(), omkring rad 64.

INSERT INTO company VALUES(1,?,?,?,?,?,?,?,?,?,1) anger elva värden för tio kolumner. Körning av Store(':memory:').seed(...) misslyckades med table company has 10 columns but 11 values were supplied. Fortsatta granskningstester initierade därför endast syntetiska testposter direkt i separata minnesdatabaser.

Rättning: explicit kolumnlista och korrekt antal parametrar. Testa setup på helt ny katalog och att omkörning inte skriver över användare. Detta är en körbarhetsblockerare, inte ett intrångsfynd.

### P2 – Lösenordshashningen använder svagare parametrar än säkerhetsplanen

Plats: src/security.mjs rad 7 och 12.

scryptSync anropas utan parametrar. Algoritmparametrar/version sparas inte med hashen. Det följer inte dokumenterad minneskostnad och försvårar säker uppgradering. Synkron hashning blockerar dessutom HTTP-loopens övriga arbete. Global begränsning efter tio misslyckade försök hjälper, men lyckade försök nollställer räknaren och varje lyckad inloggning gör en ny synkron beräkning.

Rättning: explicit scrypt N=131072,r=8,p=1,maxmem minst 256 MiB, lagra algoritm/version/parametrar; asynkron beräkning med begränsad samtidighet. Testa fel lösenord, hashformat och att samtidiga loginanrop inte blockerar session/rapportanrop under lång tid. Mät resursbehov på den lokala miljön.

### P2 – JSON-exporten saknar en del oföränderliga fakturauppgifter

Plats: src/domain.mjs state() rad 228 och exportData() rad 230.

state tar avsiktligt bort snapshot ur fakturorna, och exportData bygger på state utan att lägga tillbaka snapshot. Därmed försvinner fakturans fastställda företags- och kunduppgifter ur JSON-exporten. Om företagsuppgifter ändrats kan exportens aktuella företagsuppgifter inte återskapa historiska fakturor korrekt. SQLite-backupen innehåller snapshot, men JSON-exporten är därför inte en fullständig arkivexport.

Rättning: inkludera snapshot i adminexport med dokumenterat format och testa att företagets adress kan ändras utan att export av tidigare fakturas fastställda uppgifter ändras.

## Utförda positiva kontroller och gränser

Körda Node.js 24.19.0-kontroller genom PowerShell-here-string till node --input-type=module. Ingen befintlig datafil användes.

- HTTP-login med syntetiskt viewer-konto: 200; cookie hade HttpOnly, SameSite=Strict, Path=/ och åtta timmars livstid.
- Viewer POST /api/periods/lock med korrekt session/CSRF/Origin: 403.
- Samma anrop utan CSRF: 403.
- Samma anrop med främmande Origin: 403.
- Viewer GET /api/state: 200.
- Kodkontroll: parametriserad SQL, fast lista av statiska resurser, loopback-bindning, Host-kontroll, generiska loginfel och sessionshash i databasen finns.
- Kodkontroll: de observerade dynamiska HTML-fälten escapas, felmeddelanden visas med textContent och PDF-litteraler escapas. Ingen konkret lagrad XSS hittades. Detta ersätter inte en fullständig webbläsarpenetrationstest.
- Kodkontroll: ekonomiska skrivflöden använder BEGIN IMMEDIATE, periodkontrollen i \_post ligger i skrivtransaktionen och immutabilitet skyddas med triggers. Inget konkret kringgående av datumlås genom de granskade normala bokningsrutterna identifierades. Rättelserelationen ovan kringgår däremot rättelseinvarianter.
- Kodkontroll av backup: SQLite backup API, checksumma, integrity_check, foreign_key_check, balanserade verifikationer, underlagshash och sessionsinvalidering vid restore finns. Återställningen vägrar befintligt mål. Automatisk schemaläggning och faktiskt restore-test var ännu inte granskade här.

## Återstående innan godkännande

De två verifierade integritetsfelen och installationsfelet rättades och deras regressionstester passerade vid uppföljningen ovan. Ingen produktionsberedskap, juridisk efterlevnad eller fullständig säkerhet hävdas av detta dokument. Lokal HTTP saknar transportkryptering och är endast avsedd för syntetiska uppgifter på loopback enligt säkerhetsplanen.
