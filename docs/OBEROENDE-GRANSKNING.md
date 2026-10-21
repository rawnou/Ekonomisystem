# Oberoende granskning av ekonomisystemet

Granskningsdatum: 2026-10-21. Bedömning av aktuell arbetskopia för ett svenskt aktiebolag. **Systemet är inte redo för skarp bokföring. En övervakad lokal pilot med enbart syntetiska testdata är möjlig inom de begränsningar som anges nedan.**

Fem separata granskningsagenter arbetade med kod/arkitektur, ekonomiska beräkningar/dubbel bokföring, svenska regler, säkerhet/dataintegritet och användarflöden. Huvudagenten sammanställde, granskade bevisen och lade till kompletterande integrationstester. Ingen produktionskod ändrades och inga rättningar av fynden har gjorts. Befintliga lokala ändringar lämnades kvar. Ingen publicering, bankanslutning eller användning av verkliga bokföringsuppgifter genomfördes.

## Läsanvisning och bevisnivå

De fem delrapporterna är en del av denna rapport. Där finns varje fynds exakta plats, reproduktionssteg, observerade utfall, konsekvens och föreslagna rättning. Tabellen nedan sammanför överlappande fynd; samma backup- eller historikfel räknas inte som flera separata fel. Kompletterande fynd INT-1 beskrivs fullständigt längre ned.

| Oberoende område | Detaljerad rapport | Nya tester |
| --- | --- | --- |
| Kodkvalitet och systemarkitektur | [Arkitektur](OBEROENDE-ARKITEKTUR.md) | `tests/audit-architecture.test.mjs` |
| Beräkningar och dubbel bokföring | [Bokföring](OBEROENDE-BOKFORING.md) | `tests/audit-accounting.test.mjs` |
| Svenska bokförings- och momsregler | [Regelverk](OBEROENDE-REGELVERK.md) | `tests/audit-regulations.test.mjs` |
| Säkerhet, behörighet och dataintegritet | [Säkerhet](OBEROENDE-SAKERHET.md) | `tests/audit-security.test.mjs` |
| Användarflöden och funktionella tester | [Flöden](OBEROENDE-FLODEN.md) | `tests/audit-flows.test.mjs` |
| Huvudagentens kompletterande integration | INT-1 nedan och HTTP-bevis för AUD-A1 | `tests/audit-integration.test.mjs` |

**Verifierat fel** betyder att programbeteendet reproducerats; konsekvensen kan förutsätta exempelvis ett upprepat anrop eller en verklig valuta som saknas i filen. **Verifierad begränsning** betyder att funktionen saknas eller har en avsiktlig avgränsning som hindrar det aktuella affärsfallet. **Misstänkt risk** betyder att utfallet i verklig drift inte har bevisats. **Extern sakkunskap** betyder att den redovisningsmässiga/regulatoriska tillräckligheten behöver avgöras utifrån bolagets faktiska förhållanden. Ett känt backloggobjekt är fortfarande ett hinder när systemet bedöms för skarp bokföring.

Allvar bedöms efter konsekvens och förutsättningar. Kritisk innebär här allvarlig generell förlust eller obehörig förändring utan fungerande spärr. Hög innebär felaktiga belopp, missvisande ekonomisk status eller ett stopp i ett normalt centralt arbetsflöde. Medelhög innebär avgränsad integritets-, spårbarhets-, tillgänglighets- eller kontrollrisk. Låg innebär främst stöd-/användbarhetsbrist eller extra skydd utanför den dokumenterade tillitsgränsen. Bedömningarna är tekniska prioriteringar, inte juridiska klassificeringar.

## Kritiska risker

**Inget kritiskt fel har verifierats i denna granskning.** Detta är inte ett bevis på frånvaro av kritiska fel. Framför allt har inte diskfull, processkrasch, flerårig drift, alla samtidighetsfall eller en fullständig angreppsmatris provats.

## Höga risker

| Fynd och status | Berörd plats | Reproduktion och konsekvens i korthet | Föreslagen åtgärd och detaljbevis |
| --- | --- | --- | --- |
| AUD-A1 – verifierat fel | `src/domain.mjs:406`, `payment`; HTTP-rutten i `src/server.mjs` | Faktura 125 kr, samma delbetalning 50 kr två gånger: bank och betalt blir 100 kr. Även två samtidiga identiska HTTP-anrop accepteras. | Beständig unik betalningsidentitet och idempotens atomiskt med bankallokering, verifikation och reskontra. [Bokföringsrapport AUD-A1](OBEROENDE-BOKFORING.md), test INT-2. |
| AUD-A2 – verifierat fel | `src/domain.mjs:406,443,497`, betalning/kredit/motbokning | Felregistrerad full betalning kan inte återföras via fakturaflödet. Manuell motbokning ger fordran i huvudboken men fakturan står kvar som betald och ny betalning nekas. | Samordnad append-only betalningsrättelse och återbetalnings-/kreditflöde. [AUD-A2](OBEROENDE-BOKFORING.md). |
| AUD-A4 – verifierat fel | `src/domain.mjs:282,766`, manuell bokning/rapporter | D1510/K3044 100 kr ger huvudboksfordran 100 kr men ”Att få betalt” 0 kr utan avstämningsvarning. | Reskontraallokering eller spårad avstämningspost; visa båda saldona och differensen. [AUD-A4](OBEROENDE-BOKFORING.md). |
| AUD-A5 – verifierat fel | `src/imports.mjs:105`, `src/domain.mjs:646` | Tom cell i uttrycklig valutakolumn blir SEK. Kurs 11 ignoreras vid bankbokning; om raden avsåg 100 EUR bokas 100 kr i stället för 1 100 kr. Den avsedda valutan kan inte härledas ur tom cell. | Avvisa saknad valuta i befintlig kolumn atomiskt; explicit filval om kolumn saknas och bevarad proveniens. [AUD-A5](OBEROENDE-BOKFORING.md). |
| ARK-1 – verifierat fel | `src/domain.mjs:371`, `src/pdf.mjs:2` | Kundnamn `测试 AB` eller beskrivning `Tjänst 😀` accepteras och fryses vid bokföring, men PDF-export misslyckas permanent för fakturan. | Unicode-font eller full renderbarhetskontroll före fastställelse, utan ändring av historiska fakturor. [ARK-1](OBEROENDE-ARKITEKTUR.md). |
| ARK-2 – verifierad begränsning | `src/domain.mjs:186,194,406` | Decemberfaktura med januariförfall kan inte betalas nästa år. Årsgränser får inte ändras efter bokning och nytt år kan inte öppnas. | Separata räkenskapsår, ingående balanser, bevarade relationer och tester över årsskifte. [ARK-2](OBEROENDE-ARKITEKTUR.md). |
| FL1 – verifierat fel | `public/app.js`, formulärhanterarens mutation/refresh/felhantering | Verifikationen sparas, efterföljande state-hämtning misslyckas, klienten visar fel och lämnar nytt sparförsök möjligt. Nästa tryck bokför igen. | Skilj sparresultat från uppdateringsfel; idempotens för ekonomiska mutationer, bevarat kvitto och kontrollerad omläsning. [FL1](OBEROENDE-FLODEN.md). |
| REG-01 – verifierat tekniskt fel | `src/pdf.mjs:27`, `src/domain.mjs:243` | Faktura 1 oktober med separat tjänstedatum 30 september: datumet ignoreras och PDF påstår att tjänsten utfördes 1 oktober. | Samla in, validera och frys separat datum/period; skriv endast verifierade uppgifter. [REG-01](OBEROENDE-REGELVERK.md). |
| REG-02 – verifierat kontrollgap; extern rättslig bedömning | `src/domain.mjs:84,282,337` | Bokför ”Inköp” utan motpart eller underlag. Senare uppladdat kvitto kan inte kopplas till posten. Externa register/rutiner kan i princip komplettera uppgifterna. | Fullständig verifikationsinformation och append-only kompletteringsrelation med granskningslista. [REG-02](OBEROENDE-REGELVERK.md). |
| REG-04 – verifierat funktionsgap | `src/domain.mjs:371,748`, `issue`/`reports` | Fakturans moms bokas, men rapporten saknar momsperiod, deklarationsrutor och registrerad metod. Det är inget bevis på fel belopp för bolagets verkliga moms. | Bestäm bolagets metod/period med sakkunnig; implementera spårbart och avstämt deklarationsunderlag för avsedda fall. [REG-04](OBEROENDE-REGELVERK.md). |

Sammanställningen innehåller **10 höga fynd**, varav vissa avser verifierade funktions-/kontrollgap och kräver extern bedömning av faktisk redovisningskonsekvens.

## Medelhöga risker

| Fynd och status | Berörd plats | Reproduktion/konsekvens | Föreslagen åtgärd och detaljbevis |
| --- | --- | --- | --- |
| AUD-A3 – verifierat fel | `src/domain.mjs:497,631`, `reverse`/`bookBank` | Bokför bankkostnad, motboka den: bankrad står kvar som bokförd och ny klassificering nekas trots noll netto i bankbokföringen. | Historiska allokeringar och härledd aktuell status; samordnad omklassificering. [AUD-A3](OBEROENDE-BOKFORING.md). |
| ARK-3/S2 – verifierad kontrollbrist | `src/backup.mjs:16`, `verifyDatabase` | Direkt SQL sätter räknaren till noll efter V1. Backup och restore godkänns, men nästa normala bokning får UNIQUE-fel. **Ingen vanlig API-väg till skadan har visats.** | Semantisk kontroll av serie, schema, faktura-/verifikationsrelationer och återställd driftförmåga. [ARK-3](OBEROENDE-ARKITEKTUR.md), [S2](OBEROENDE-SAKERHET.md). |
| ARK-4/S5 – verifierad informationsförlust | `src/domain.mjs:194,224`, företagsändring | Två inställningsändringar skriver över tidigare värden; audit innehåller bara versionsnummer. Fakturasnapshots täcker endast fastställelsetillfällen. | Append-only relevant före/efter-historik i samma transaktion. [ARK-4](OBEROENDE-ARKITEKTUR.md), [S5](OBEROENDE-SAKERHET.md). |
| ARK-4, CSV – verifierad informationsförlust; extern arkivbedömning | `src/imports.mjs:73`, `src/domain.mjs:586` | Importera extra källkolumn: import lyckas men kolumnen och originalfilen saknas i export/backup. Hash kan inte återskapa filen. | Bevara källfil, mappning och normaliseringsversion med importrelation. [ARK-4](OBEROENDE-ARKITEKTUR.md). |
| INT-1 – verifierat integrationsfel | `src/domain.mjs:282`, `src/sie.mjs:43,178` | Bokför text med `€`: hela årets SIE-export stoppas. Motbokning tar inte bort den oföränderliga originaltexten. JSON finns kvar. | Förutsägbar exporthantering utan tyst teckenförlust, kontroller före bokning och bevarad historisk originaltext. Fullständigt bevis nedan. |
| S1 – verifierat fel | `src/server.mjs:56,91,151` | Påbörja POST med giltiga headers men håll body; logga ut i annat anrop; skicka body. Bokföring lyckas efter återkallad session. Kräver tidigare giltig session/CSRF. | Validera aktuell session och utgångstid efter bodyläsning omedelbart före mutation. [S1](OBEROENDE-SAKERHET.md). |
| S4 – verifierad tillgänglighetsrisk | `src/server.mjs:105` | Tio felaktiga försök mot okänt konto gör att även korrekt ägarinloggning ger 429 i 15 minuter. Kräver lokal Origin. | Kontobaserad begränsning kombinerad med global kapacitetskontroll och dokumenterad återhämtning. [S4](OBEROENDE-SAKERHET.md). |
| AUD-A6 – misstänkt fullständighetsrisk | `src/domain.mjs:29,562` | Två verkligt skilda händelser med lika datum/belopp/text utan unik referens kan inte representeras. Test verifierar kollisionen; verklig dataförlust är inte visad. | Stabil källidentitet, möjlig-dubblettbeslut, originalfiler och bankavstämning. [AUD-A6](OBEROENDE-BOKFORING.md). |
| ARK-5 – misstänkt uppgraderingsrisk | `src/domain.mjs:70`, schemaöppning | Ingen versionerad migration/kompatibilitetskontroll. Verklig äldre databasuppgradering har inte provats. | Versionerat schema, transaktionella migrationer och stödda restore-/uppgraderingsmatriser. [ARK-5](OBEROENDE-ARKITEKTUR.md). |
| REG-03 – verifierat valideringsfel | `src/domain.mjs:200`, `src/sie.mjs:95` | Admin ställer in 2026-01-01–2030-12-31 före första bokning. Femårsperioden godtas, kan bokföras i och exporteras som ett räkenskapsår. | Validera tillåtna årsgränser och särskilda förlängningsfall; gör motsvarande exportkontroll. [REG-03](OBEROENDE-REGELVERK.md). |
| FL2 – verifierat formulärfel | `public/app.js:118`, `src/domain.mjs:234` | Org.nr, e-post och adress saknar required i formuläret men tomma värden nekas av servern. | Samstämmig policy, tydlig märkning och fältspecifika fel; behåll servervalideringen. [FL2](OBEROENDE-FLODEN.md). |
| FL3 – verifierad flödesbrist | `public/app.js:88,115` | Spara utkast med unik beskrivning/antal/pris: listan visar bara delar av fakturan, utan granskning, ändring eller makulering före Fastställ. | Detalj-/förhandsgranskning och versionskontrollerad utkastredigering/makulering. [FL3](OBEROENDE-FLODEN.md). |
| FL4 – verifierad spårbarhetsbrist | `public/app.js:142`, `ledger` | Bokför med ett uppladdat dokument. Kopplingen finns i databasen men ingen underlagslänk eller referens visas från verifikationen. | Visa autentiserad dokumentlänk/version och hänvisningar åt båda håll. [FL4](OBEROENDE-FLODEN.md). |

Sammanställningen innehåller **13 medelhöga fynd**. Misstänkta risker och förutsättningar som direkt databasskada är uttryckligen märkta.

## Låga risker

| Fynd och status | Berörd plats | Reproduktion/konsekvens | Föreslagen åtgärd och detaljbevis |
| --- | --- | --- | --- |
| S3 – verifierad lucka i extra DB-skydd | `src/domain.mjs:94,102` | Med direkt SQL kan issued bli draft och därefter ändras; nya rader kan läggas på låst verifikation. **Ingen HTTP-kringgång har visats.** | Tillåtna statusövergångar och förseglade verifikationer samt OS-skydd av filerna. [S3](OBEROENDE-SAKERHET.md). |
| ARK-6 – misstänkt prestandarisk | `src/domain.mjs:782`, `state` | All historik laddas och en separat radfråga körs per verifikation. Ingen timeout eller kapacitetsgräns har uppmätts. | Paginering, avgränsade rapporter, batchfrågor och mätt kapacitetsnivå. [ARK-6](OBEROENDE-ARKITEKTUR.md). |

Sammanställningen innehåller **2 låga fynd**. Totalt 25 konsoliderade fynd: 0 verifierade kritiska, 10 höga, 13 medelhöga och 2 låga. Flera är funktions-/kontrollgap eller misstänkta risker enligt respektive status; siffran betyder inte 25 bevisade exploateringar eller lagöverträdelser.

## INT-1: accepterad bokföringstext blockerar SIE för hela året

**Allvar:** medelhög. **Status:** verifierat integrationsfel. SIE-exportören gör rätt i att avvisa tecken som den inte kan representera; problemet är att bokningsflödet accepterar oföränderlig text utan en fungerande exportväg eller förvarning. JSON-export och backup fungerar fortfarande, så detta är inte total informationsförlust.

**Plats:** `src/domain.mjs:282` (`post`), `:342` (verifikationstext), `src/sie.mjs:43` (`quoted`/kodning), `:178` (varje originalverifikation exporteras).

**Reproduktion:** kör INT-1 i `tests/audit-integration.test.mjs`. Skapa syntetisk minnesdatabas. Bokför D5410/K1930 100 kr med texten `Syntetiskt köp i €`. Bokningen lyckas och kostnaden blir 10 000 öre. `exportSIE(store)` kastar CP437-fel. Motboka nästa dag med vanlig svensk rättelsetext: kostnad blir noll men SIE misslyckas fortfarande eftersom originalverifikationen alltid ingår och inte får skrivas om.

**Konsekvens:** en vardaglig textuppgift kan stoppa överföring av hela året till mottagarsystemet. Samma typ av integrationsproblem finns för kontrolltecken. Befintliga SIE-tester visar korrekt avvisning av otillåtna tecken, men inte att uppströms bokningsflöde undviker återvändsgränden.

**Åtgärd:** besluta och testa en uttrycklig exportpolicy som bevarar originaltext och spårbarhet. Ge validering/varning innan bokningen fastställs. Eventuell särskild exportrepresentation och normalisering måste vara definierad och provad i mottagarsystem; skriv inte om redan bokförd originaltext eller ersätt tecken tyst. Bekräfta SIE-hanteringen med redovisningssakkunnig.

## Regelverk och frågor för extern sakkunskap

Källkontroll gjordes mot aktuella primärkällor, bland annat [bokföringslagen](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/), [BFN:s vägledning Bokföring](https://www.bfn.se/wp-content/uploads/vl13-2-bokforing.pdf) och [Skatteverkets faktureringsregler](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/fakturering.4.58d555751259e4d66168000403.html). Bolagets faktiska metod, momsperiod, avtal och arkivrutiner har inte tillhandahållits. Därför lämnas ingen generell regelacceptans.

- Separat tjänste-/leveransdatum saknas och PDF anger alltid fakturadatum. För affärer där dagarna skiljer sig kan fakturan innehålla fel uppgift. Bevis och rättning anges i regelverksrapporten.
- Räkenskapsårets längd och årsövergång behöver korrekt modellering och validering. Teknisk export av en period är inget bevis på att perioden är tillåten för bolaget.
- Manuell verifikation kan skapas utan motpart/underlag; fri text eller externa underlag kan täcka krav men systemet säkerställer inte fullständighet. Lagkravet ska inte förväxlas med krav på ett visst databasfält.
- Det finns ingen komplett momsrapport med momsperiod, deklarationsrutor och spårbar avstämning. 25-procentsflödet är uttryckligen avgränsat; avvisade 0/6/12 procent är inte felaktig momsberäkning. KDP/Adtraction, utland, omvänd moms och undantag kräver bedömning av verkliga avtal.
- Ingående balanser, flerårsflöde, årsavslut och fullständiga period-/huvudboksrapporter återstår. SIE-utdata har inte provimporterats i ett etablerat mottagarsystem eller externt validerats under denna granskning.
- Arkivets fullständighet, bevarandetid, läsbarhet, driftplats, separat skyddad backup och återställningsrutiner måste bedömas och prövas i bolagets faktiska miljö. Lokal backup på samma disk är inte skydd mot diskförlust.

Detaljer, källstöd och avgränsningar finns i [regelverksrapporten](OBEROENDE-REGELVERK.md). Årsredovisning, deklaration, K2/K3, löner och GDPR/driftfrågor är separata acceptansområden.

## Faktiska kontroller och begränsningar

Utgångsläget `node --test` gav **38/38 godkända** på Node v24.19.0. Slutlig sammanlagd körning med alla sex nya testfiler gav **72/72 godkända, 0 fel, 0 överhoppade**, cirka 6,1 sekunder. **34 nya tester** tillkom: 27 reproduktions-/karaktäriseringsprov av fel, risker eller omfattningsgap och 7 positiva kontrollprov. Produktionskoden ändrades inte för att få tester gröna.

`node --check public/app.js` och syntaxkontroll av befintliga `.mjs`-filer genomfördes utan syntaxfel. `git diff --check` passerade; även de nya granskningsfilerna kontrollerades separat för radslutsblanksteg. Inga `data/`- eller `backups/`-filer är spårade i Git. Slutkontroll av produktionsfilernas SHA-256 jämfördes med de värden som noterades under granskningen.

**Nya reproduktionstester förväntar sig det observerade felet och är gröna när felet finns kvar. De är bevis, inte acceptanstester för korrekt bokföring.** Vid rättning behöver de vändas till att kräva korrekt beteende och vid behov kompletteras. Positiva kontrollprov av avrundning, roller, periodlås och rollback anges separat i delrapporterna.

Detta uppdrag omfattade källkod, befintliga dokument, domän-, HTTP-, import-, export-, backup-/restore- och UI-logiktester. Alla nya prov använde syntetiska minnesdatabaser eller isolerade temporära filer. Flödestester körde verkliga app.js-handlers i VM; det är inte ett fullständigt webbläsar-, layout-, tillgänglighets- eller mobilprov. Ingen ny visuell PDF-renderingsgranskning gjordes; befintliga PDF-tester kördes och de nya proven granskade exporterbarhet och innehåll.

Ingen fullständig penetrationstestning, flerårig belastning, diskfull-/kraschfelinjicering, verklig bankavstämning, originalleverantörsfil, myndighetsinlämning eller extern redovisningsacceptans ingår. Godkända existerande tester ger stöd för sina avgränsade scenarier och upphäver inte de nya fynden.

## Bedömning och kvarstående grindar

**Pilot med testdata: villkorat tekniskt möjlig.** Begränsa till lokal loopback, ett företag, ett räkenskapsår, små syntetiska datamängder och det stödda svenska 25-procentsflödet. Piloten ska vara övervakad med oberoende förväntade belopp och manuell avstämning av bank, huvudbok och reskontra. Använd piloten till att undersöka fel-/rättelsefallen; utgå inte från att UI-status eller gröna reproduktionstester är en korrekthetsgaranti. Årsskifte, andra momsfall och felaktiga betalningar är fortsatt blockerade eller ofullständiga flöden.

**Skarp bokföring: tekniskt inte redo.** Före officiell bokföring behöver åtminstone följande uppfyllas och omgranskas:

1. Beständig idempotens och tydliga sparbesked; fullständiga betalnings-/kredit-/bankrättelser som håller huvudbok och reskontra avstämda.
2. Explicit valuta, tjänstedatum och tillåtet räkenskapsår; fakturor som kan granskas före fastställelse och exporteras efteråt.
3. Årsövergång, ingående balanser, periodrapporter och verifierat moms-/SIE-flöde för bolagets faktiska affärer.
4. Bevarade originalkällor och relevant ändringshistorik; kontrollerat schema och semantiskt verifierad återställning samt skyddad oberoende backup.
5. Rättad sessionsåterkallelse och genomgången konto-/driftförvaltning för verkliga data.
6. Verklig redovisningskunnig granskar bolagets fakturor, verifikationer, moms, rättelser, rapporter, systemdokumentation och arkivering. Därefter krävs ägarens uttryckliga beslut om verkliga data enligt projektets instruktioner.

**Inget juridiskt godkännande lämnas. AI-agenternas tester och granskning ersätter inte en verklig redovisningsmässig kontroll innan systemet används för bolagets officiella bokföring.**
