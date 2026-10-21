# Oberoende säkerhets- och integritetsgranskning

Datum 2026-10-21. Separat granskningsagent; inga produktionsfiler ändrade. Omfattning: server, autentisering, behörighet, databasrestriktioner, periodlås, behandlingshistorik och backup/restore. Endast ny minnesdatabas och tillfälliga syntetiska filer användes. Detta är en teknisk granskning, inte redovisningsmässigt eller juridiskt godkännande.

## Resultat och bevisnivå

Inga verifierade kritiska eller höga säkerhetsfel hittades inom den granskade lokala HTTP-tillitsgränsen. Fyra medelhöga fynd och ett lågt fynd nedan är verifierade, men S2 och S3 kräver felaktigt databasinnehåll eller direkt databasåtkomst. De är inte verifierade HTTP-intrång. Att kunna skriva direkt i databasfilen ligger utanför applikationens dokumenterade säkerhetsgräns; en sådan angripare kan även avlägsna triggers. S3 beskriver därför ett ofullständigt extra integritetsskydd, inte att appbehörighet kan kringgås med ett webbanrop.

## Medelhöga risker

### S1 – En mutation som väntar på sin body kan genomföras efter utloggning

- **Status:** verifierat via riktig HTTP. Kräver en session och dess CSRF-token som var giltiga när begäran började.
- **Plats:** `src/server.mjs:56–62`, `:91–96`, `:151–156`.
- **Reproduktion:** skapa giltig syntetisk session; skicka headers till `POST /api/vouchers` med korrekt Origin, CSRF och Content-Length men håll inne bodyn. Vänta tills servern läst sessionen. Logga ut via separat HTTP-anrop och kontrollera att sessionsraden är borta. Skicka därefter den balanserade verifikationens body. Servern svarar 200 och bokför trots att samma cookie nu ger 401 för nya anrop.
- **Konsekvens:** utloggning och sessionsrotation återkallar inte tidigare påbörjade men ännu inte validerade mutationer. Även sessionsutgång under bodyläsning saknar ny kontroll. Angreppsfönstret begränsas av HTTP-timeout och kräver redan känd session; detta är inte anonym obehörig bokföring.
- **Åtgärd:** läs/validera session igen efter bodyläsning, omedelbart före CSRF-kontroll och anrop till domänmutationen. Kontrollera även aktuell utgångstid. Regressionstest ska kräva 401 och oförändrad nummerserie, verifikation och historik.
- **Bevis:** test `audit reproduktion S1`.

### S2 – Backupverifieringen godkänner en nummerserie som gör fortsatt bokföring omöjlig

- **Status:** verifierat fel i backupkontrollen, med avsiktligt injicerad databasinkonsistens. Ingen vanlig HTTP-väg till korruptionen är visad.
- **Plats:** `src/backup.mjs:16–40`, `:52–58`, `:79–92`; `src/domain.mjs:154–161` (`next`).
- **Reproduktion:** skapa V1 normalt. Sätt i en isolerad testdatabas `UPDATE counters SET value=0 WHERE name='voucher'`. Kör `verifyDatabase`, `makeBackup` och `restoreBackup`; alla lyckas. Försök skapa nästa verifikation i återställd databas: UNIQUE-fel på `vouchers.number`, eftersom nummerserien åter försöker skapa V1. Återställningens transaktionsrullning behåller räknaren på noll, så felet upprepas.
- **Konsekvens:** meddelandet att backup är verifierad garanterar inte användbar affärsstatus. Ett logiskt databasfel kan spridas till säkerhetskopior och upptäcks först efter återställning, när bokföringen inte kan fortsätta. Dokumenterad säkerhetsplan kräver kontroll av nummerserier vid restore, men den saknas.
- **Åtgärd:** kontrollera schemaversion och räknare mot respektive högsta använda nummer, saknade räknare samt faktura-/verifikationsrelationer och beloppsinvarianter i separat valideringssteg. Neka inkonsistent backup och restore med tydligt fel. Lägg inte till en tyst automatisk reparation av bokföringen.
- **Bevis:** test `audit reproduktion S2`; faktisk backup och återställning till ny tillfällig databas ingår.

### S4 – Tio felaktiga försök på ett obefintligt konto låser ut samtliga användare

- **Status:** verifierat via riktig HTTP. Kräver möjlighet att anropa lokal server med godkänd Origin; en vanlig främmande webbsida uppfyller inte Origin-kontrollen.
- **Plats:** `src/server.mjs:105–127`.
- **Reproduktion:** skicka tio loginanrop med `email=nonexistent@example.test`, `password=null` och korrekt lokal Origin. Alla svarar 401. Logga därefter in med ägarens korrekta uppgifter: 429 och uppmaning att vänta 15 minuter.
- **Konsekvens:** felaktiga försök på vilket användarnamn som helst påverkar alla konton. En lokal klient kan omedelbart skapa en tillgänglighetsstörning utan lösenord; `null` avvisas innan kostsam scrypt och gör spärren billig att utlösa. Detta är en avvägning i nuvarande globala brute-force-skydd, inte läckta uppgifter eller en direkt väg till bokföringsändring.
- **Åtgärd:** kombinera begränsning per normaliserat konto med en global kapacitetsgräns/backoff som inte ger alla konton en gemensam lång spärr. Dokumentera återställningsväg och att minnesbaserad spärr försvinner vid omstart. Testa kontooberoende, även för okända konton.
- **Bevis:** test `audit reproduktion S4`.

### S5 – Historiken kan inte återskapa ändringar i företagsinställningar

- **Status:** verifierat genom ordinarie domänfunktion, utan direkt databasmanipulation.
- **Plats:** `src/domain.mjs:195–225`, särskilt `:224`.
- **Reproduktion:** ändra företagets namn och bankuppgift via `company()`/`PUT /api/company` med korrekt version. Företagsraden skrivs över och enda detaljen i `company.update` är `{"version":2}`. Varken föregående eller nytt fältvärde sparas i behandlingshistoriken. Fastställda fakturors snapshots täcker endast tillfällen då en faktura fastställdes, inte varje inställningsändring.
- **Konsekvens:** aktör och tid finns, men det går inte att avgöra vilka betalnings-/identitetsuppgifter som faktiskt ändrades eller rekonstruera tidigare inställningar mellan fakturor. Det försvårar felsökning och utredning av felaktiga eller obehöriga inställningsändringar. Detta avviker från säkerhetsplanens krav på relevant före/efter-beskrivning; dokumentet hävdar ingen juridisk skyldighet för ett visst loggformat.
- **Åtgärd:** spara en avgränsad fältdiff med före/efter i samma transaktion som ändringen, utan lösenord eller sessionstoken. Testa två successiva ändringar och att en misslyckad versionskontroll inte skapar historik.
- **Bevis:** test `audit reproduktion S5`.

## Låga risker

### S3 – Databasens extra immutabilitetsskydd är ofullständigt

- **Status:** verifierat på SQL-nivå; kräver direkt skrivåtkomst till databasen eller framtida felaktig intern skrivväg. Ingen sådan HTTP-väg har verifierats.
- **Plats:** `src/domain.mjs:94–95` och `:102–103`.
- **Reproduktion A:** fastställ faktura normalt. Direkt ändring av dess beskrivning nekas av trigger. Kör därefter `UPDATE invoices SET status='draft' WHERE id=?`; detta tillåts. Nu tillåts även ändring av `description` och `total`. Fakturan försvinner ur reskontran medan ursprungliga 1510-poster kvarstår.
- **Reproduktion B:** skapa balanserad verifikation, lås perioden och använd SQL INSERT för att lägga till ett nytt balanserat par entries på samma verifikation. Det tillåts utan att triggers tas bort, ändrar historiskt saldo och skapar ingen revisionshändelse.
- **Konsekvens:** triggers blockerar UPDATE/DELETE för vissa objekt men säkerställer inte alla påstådda invariander på databasskiktet. En framtida intern metod kan därför förstöra låst historik trots befintliga triggers. Direktskrivande lokal administratör måste fortfarande betraktas som betrodd/utanför appens skydd.
- **Åtgärd:** förbjud återgång från fastställd faktura till draft, begränsa tillåtna statusövergångar och inför ett explicit färdigställt verifikationstillstånd där nya entries nekas. Kontrollera lås även på lämpligt DB-skikt om det ingår i avsedd tillitsmodell. Säkerställ att interna bokningsfunktioner fortfarande kan skapa hela verifikationen atomärt. Skydda i första hand databasfil och backup med OS-behörigheter.
- **Bevis:** två tester med prefix `audit reproduktion S3`.

## Misstänkta risker och ej verifierade driftkrav

- `scryptSync` i `src/security.mjs` blockerar HTTP-händelseloopen; parametrarna N=131072,r=8,p=1 används men hashformatet sparar inte versions-/parameterfält. Avsaknaden är verifierad i kod; någon kvantifierad överbelastningsattack ingår inte här. Inför asynkron hashning med begränsad samtidighet och versionsformat före produktionsdrift.
- Ingen färdig lösenordsrotation, kontospärr eller administrativ återkallelse av alla användarsessioner identifierades i HTTP-API:t. Behov och säkert driftförfarande måste beslutas före verklig användning; detta är en saknad funktion, inte verifierad autentiseringsbypass.
- Lokal HTTP, samma disk för automatiska backuper, saknad separat retention/krypterad extern lagring och ospecificerade Windows-ACL:er återstår som driftgranskning. OS-behörigheter på användarens verkliga databas/backup ändrades eller provades inte. Inga bankanslutningar eller publicering genomfördes.
- Magiska filsignaturer och nedladdning som attachment är inte skanning av skadliga PDF/JPEG/PNG. Ingen aktiv exploatering av dokumentvisare testades.
- Juridisk tillräcklighet av behandlingshistorik, arkivering och åtkomstkontroll kräver extern sakkunskap; denna granskning ersätter inte verklig redovisningsmässig kontroll.

## Körda kontroller

Nya testfilen är `tests/audit-security.test.mjs`. Nio tester: tre positiva säkerhetskontroller och sex reproduktionstester. Reproduktionstesterna **förväntar det observerade felbeteendet** och är gröna när risken bekräftas; grönt betyder inte att dessa risker är rättade. Vid framtida rättning ska respektive test vändas till att kräva skyddat beteende.

Faktiskt kört med Node v24.19.0:

```text
node --test tests/audit-security.test.mjs tests/http.test.mjs tests/security-review.test.mjs
16 tester, 16 godkända, 0 misslyckade, cirka 4,1 sekunder
```

Den nya behörighetsmatrisen prövade viewers direkta åtkomst till samtliga tolv ekonomiska POST-rutter samt företagets PUT och export-GET; accountant nekades adminrutter. Avvisade anrop skrev ingen behandlingshistorik. Utgången session, fel/saknad CSRF och främmande Origin nekades. Låst period nekades atomärt för manuell verifikation, fakturabetalning, kredit och bankbokning med helt oförändrat state. Befintliga HTTP-tester verifierade även Host, cookies, riktig inloggning, parallell fakturafastställning, betalningskonflikt och dokumenthash.

## Avgränsad beredskapsbedömning

Säkerhetsdelen hindrar inte en övervakad lokal pilot med enbart syntetiska testdata på loopback, förutsatt att verifierade fel är synliga och pilotens resultat kontrolleras. Det är inte en bedömning av hela systemets redovisningsmässiga korrekthet. S1, backupvalidering, spårbarhet och drift-/kontoförvaltning behöver hanteras före skarpa data; redovisningsgranskning och extern sakkunnig kontroll återstår oavsett testutfall.
