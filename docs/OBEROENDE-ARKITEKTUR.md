# Oberoende granskning: kodkvalitet och systemarkitektur

Datum 2026-10-21. Område 1. Produktionskod och befintliga filer har inte ändrats. Tidigare kvalitetsgranskning lästes som bakgrund; nedanstående beteenden verifierades självständigt mot aktuell implementation.

## Faktiskt utförda kontroller

Läst AGENTS.md, README, arkitektur- och kvalitetsdokument, src/domain.mjs, server.mjs, backup.mjs, imports.mjs, pdf.mjs, sie.mjs, setup/backup-skript och befintliga domän-/kvalitetstester. Node v24.19.0.

- `node --test tests/audit-architecture.test.mjs`: **5/5 godkända**.
- `node --test`: **51/51 godkända**, inklusive andra granskares då tillgängliga tester.

De nya testerna är karakteriseringstester: de verifierar att ett problem kan reproduceras och godkänt test betyder att fyndet finns kvar. Inga problem har rättats. En inledande testkörning hade 3/4 godkända eftersom ett test försökte ändra en beskrivning till dess befintliga värde; testet korrigerades till en faktisk ändring. Resultaten ovan gäller slutversionen.

## Kritiska risker

Inget verifierat kritiskt fynd i detta granskningsområde. Det betyder inte att systemet är granskat eller godkänt för skarp drift.

## Höga risker

### ARK-1: faktura kan bokföras och frysas trots att den aldrig kan exporteras som PDF

**Status:** verifierat fel. **Plats:** `src/domain.mjs:227–281` (kund/utkast), `src/domain.mjs:371–405` (fastställelse), `src/pdf.mjs:2–14,18–23,53–55` (sen fontvalidering).

**Reproduktion:** skapa kunden `测试 AB`, skapa en faktura på 100 kr + 25 % och fastställ den. Alternativt använd en vanlig svensk kund och beskrivningen `Tjänst 😀`. Fastställelse lyckas och kundfordran blir 12 500 öre. `invoicePDF(store,id)` kastar fel om Unicode-font. En efterföljande ändring av kundnamnet hjälper inte eftersom snapshot är fryst. Ändring av fakturainnehållet avvisas korrekt av triggern.

**Konsekvens:** en slutlig numrerad och bokförd faktura kan inte distribueras via systemets fakturaexport. Användaren hamnar i ett återvändsgrändsflöde efter en ekonomisk mutation. README uppger fontbegränsningen, men serverns fastställelse kontrollerar den inte.

**Åtgärd:** stöd en inbäddad Unicode-font eller validera samtliga fakturauppgifter och renderbarhet före slutlig fastställelse, inom samma transaktion. Förhandsvisa innan fastställelse. Behåll oföränderligheten; ändra inte frysta fakturor som kringgående.

**Test:** två A2-fall i `tests/audit-architecture.test.mjs`.

### ARK-2: inget fortsatt bokföringsflöde efter det första räkenskapsåret

**Status:** verifierad funktionsbegränsning, redan omnämnd i README, hög risk för skarp användning. **Plats:** `src/domain.mjs:186–207,406–442` samt `src/domain.mjs:300–301` (betalningsbokningen anropar periodkontrollen genom `_post`).

**Reproduktion:** skapa och fastställ faktura daterad 2026-12-31 med förfallodatum 2027-01-30. Registrera betalning 2027-01-02: avvisas som utanför räkenskapsåret. Försök ändra företagets år till 2027 med korrekt versionsnummer: avvisas eftersom en verifikation redan finns. Ingen API finns för nytt räkenskapsår, överföring av kundreskontra, ingående balanser eller årsavslut.

**Konsekvens:** normala obetalda årsskiftesfakturor kan inte slutbetalas, krediteras eller följas vidare i samma databas efter årsskiftet. Ny tom databas bevarar inte automatiskt relationen till den tidigare fakturan. Ingen databasmanipulation som kringgående rekommenderas.

**Åtgärd:** separat modell för räkenskapsår och perioder; öppna nästa år utan att ändra historiska årsgränser, bär över kontobalanser/reskontra och behåll globala fakturarelationer. Verifiera betalning och rättelse över årsskifte.

**Test:** A1.

## Medelhöga risker

### ARK-3: godkänd backupverifiering visar inte att återställd bokföring kan fortsätta

**Status:** verifierad verifieringslucka; testets initiala skada kräver direkt databasåtkomst. Ingen HTTP-attack eller vanlig användarväg till skadan påstås. **Plats:** `src/backup.mjs:16–44,53–60,79–93`, `src/domain.mjs:153–159,342–357`.

**Reproduktion:** bokför V1 i en syntetisk databas, sätt med direkt SQL `counters.value=0` för `name='voucher'`. Kör makeBackup och restoreBackup: båda accepterar filen och rapporterar en verifikation. Öppna den återställda databasen och gör en vanlig ny bokning: UNIQUE-fel för `vouchers.number`. Posten rullas tillbaka, vilket är korrekt.

**Konsekvens:** strukturellt korrekt SQLite, balanserade poster och oförändrade dokumenthashar kan ge en semantiskt felaktig återställning som inte längre kan bokföra. Kontrollsumman kan inte upptäcka ett fel som redan fanns när backupen togs. Granskningen visar inte att sådan skada uppstår genom befintliga API:er.

**Åtgärd:** versionerat schema och definierade semantiska verifieringsregler för bl.a. nummerserier, faktura/verifikationskopplingar, saldo/status och schema-kompatibilitet. Kör separat återställningsprov i isolerad kopia. Rapportera skillnaden mellan fysisk integritet och affärsmässig verifiering.

**Test:** A3; endast temporära syntetiska databasfiler, bortstädade efter test.

### ARK-4: tidigare företagsvärden och extra CSV-uppgifter bevaras inte

**Status:** verifierad informationsförlust i datamodellen; exakt lagstadgad arkiveringsomfattning kräver extern redovisningssakkunskap. **Plats:** `src/domain.mjs:214–224,600–630`, `src/imports.mjs:103–122`, `src/domain.mjs:811–823`.

**Reproduktion:** ändra företagets bankuppgift till en unik syntetisk sträng och ändra sedan igen innan någon faktura fastställs. JSON-export innehåller bara sista värdet; de två `company.update`-historikraderna innehåller endast `{version:2}` respektive `{version:3}`. Importera CSV med en extra `evidence`-kolumn: importen lyckas men kolumnvärdet finns varken i bankrader, importpost eller export. CSV-originalet sparas inte; dess hash är inte återställbar information.

**Konsekvens:** tidigare kritiska inställningar och bortnormaliserade källfält går inte att rekonstruera ur databasen, dess JSON-export eller en senare backup. Fakturasnapshots bevarar visserligen uppgifterna för redan fastställda fakturor, men inte alla mellanliggande ändringar. En lokalt sparad originalfil utanför systemet kan finnas; det flödet upprätthålls inte av applikationen.

**Åtgärd:** append-only historik med före/eftervärden för relevanta företagsinställningar samt arkiverad oförändrad importfil, mappning och normaliseringsversion med länk från importen. Låt extern sakkunnig specificera arkiveringskraven.

**Test:** A4.

### ARK-5: schema saknar versionerad migrations- och kompatibilitetskontroll

**Status:** misstänkt driftsrisk baserad på källkod; faktisk uppgradering från historisk produktionsdatabas har inte testats. **Plats:** `src/domain.mjs:70–110`, `src/backup.mjs:54–60`.

**Underlag/reproduktion att komplettera:** konstruktorn kör `CREATE TABLE/TRIGGER IF NOT EXISTS` vid varje öppning men saknar migrationsversion eller validering av befintliga kolumner/triggerdefinitioner. Backupmanifestets `format:1` versionssätter manifestet, inte databasschemat. Prova i nästa etapp en fixture med äldre schema och öppna med ny applikationsversion; nuvarande kod anger inget säkert stödd uppgraderingsintervall.

**Konsekvens:** framtida uppgraderingar kan öppna en inkompatibel databas och misslyckas först vid användaroperation, eller behålla tidigare triggerlogik. Att detta redan inträffat på en verklig äldre databas hävdas inte.

**Åtgärd:** explicit schema-/applikationsversion, transaktionella migrationer, kontrollerad nedgraderingsspärr samt tester av backup/restore mellan stödda versioner.

## Låga risker

### ARK-6: varje state-anrop hämtar all historik och gör en fråga per verifikation

**Status:** verifierat kodmönster, misstänkt prestandarisk; ingen kapacitetsgräns eller timeout har uppmätts. **Plats:** `src/domain.mjs:782–810`, `src/server.mjs:165`.

**Reproduktion att lastmäta:** skapa växande mängd syntetiska verifikationer och hämta `/api/state`. Alla fakturor, bankhändelser och verifikationer laddas; varje verifikation ger dessutom en egen SQL-fråga för raderna. Rapportfrågorna räknas om vid varje anrop. Synkron SQLite och JSON-serialisering körs i serverns enda Node-tråd.

**Konsekvens:** svarstid, minne och svarsstorlek växer med hela företagshistoriken; andra sessioner kan få vänta. Ingen belagd pilotblockerare med liten datamängd.

**Åtgärd:** paginering och separata avgränsade API:er för rapporter/grundbok, batcha radfrågor samt fastställ en testad kapacitetsnivå innan skarp användning.

## Teknisk bedömning

Det finns en användbar grund för en lokal pilot med små syntetiska datamängder inom ett år och med latinska fakturauppgifter, med redovisade begränsningar och utan att godkända tester tolkas som felfrihet. Transaktionella nummerserier, balansering, atomiska återställningar och oföränderlighet har tydliga kontroller.

Systemet är inte tekniskt färdigt för skarp löpande bokföring: fakturaexportens sena fel, räkenskapsårsövergång, rättelse-/avstämningsluckor från övriga granskningsområden, bevarande av originalinformation och kontrollerad schema-/återställningshantering återstår. Inget juridiskt godkännande lämnas. AI-tester ersätter inte verklig redovisningsmässig kontroll innan officiell bokföring.
