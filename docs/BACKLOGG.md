# Prioriterad backlogg och kvalitetsgrindar

Datum 2026-10-21. Fas 0 är genomförd på den lokala lösningens nivå. Fas 1 är körbar och tekniskt verifierad med syntetiska data; ingen komplett produktacceptans eller skarp redovisningsacceptans har lämnats. Fas 2 är delvis implementerad. Fas 3 innehåller genomförda oberoende kodgranskningar och tekniskt återställningsprov, men drift- och extern redovisningskontroll återstår. Fas 4 planeras enbart.

## Nästa: avstämning och redovisningsfullständighet

1. Atomisk bank/fakturamatchning: en bankhändelse, betalningsallokering och verifikation ska skapas/kopplas i samma transaktion. Delbetalning, överbetalning, återbetalning och valutakursdifferenser måste provas. Matchning får inte dubbelbokföra manuellt registrerade betalningar.
2. Bankavstämning per kontoutdrag: ingående saldo + verkliga bokförda bankrader jämförs med utgående banksaldo, med datumgräns och granskningshistorik. Matcha KDP/Adtraction utan att intäkten bokförs en gång till vid betalning.
3. Flera fakturarader, tjänste-/leveransdatum, full organisationsnummerkontroll, ändring av utkast med versionskontroll, delkrediter, betalda fakturors krediter/återbetalningar samt frysta PDF-original. Faktura-PDF med Unicode-font.
4. Reskontraavstämning mot 1510. Begränsa även generella manuella journalposter så att oförenliga reskontraändringar synliggörs; 1510 i manuell journal behövs för vissa redovisningsfall men kan i dag göra reskontra/huvudbok olika. Första UI hänvisar kundbetalning till faktura.
5. Periodrapporter, full huvudbok med kontofilter, fler BAS-konton med kvalitetssäkrad version, ingående balanser, fler räkenskapsår och årsövergång. Ingående balanser är nu noll i SIE; syntetiskt startkapital bokas som årets händelse.
6. Verifierade momsfall, momskoder/giltighet och momsrapport. Ingen automatisering av KDP/Adtraction-moms före verifierad avtalspart, försäljningsart, land och betalningsflöde.
7. Leverantörers verkliga filformat: dokumenterade versionsspecifika adaptrar, källfiler, motparter, rapportperioder, status, avgifter, royaltysort och avstämning. Proveniens för originalfil behövs; nu lagras hash och normaliserade rader, inte original-CSV som arkiverat underlag.
8. Extern SIE-provimport i etablerat ekonomisystem och validering av hela räkenskapsårets öppning/avslut.

## Därefter: driftberedskap

- Inbjudan/kontoadministration, lösenordsbyte/återställning, MFA, inaktivering, asynkron/workerbaserad lösenordshashning, versionsmärkt hashformat och beständig inloggningsbegränsning.
- Migreringssystem, säker deployprocess, TLS, secret store, backup till separat skyddad lagring, dokumenterad arkivåterläsning, katastrofprov och exportprov efter längre tidsperioder.
- Filskanning/karantän, korrekt innehållsvalidering utöver magic bytes, OCR om affärsnytta finns, efterkoppling av underlag med append-only relationer och komplett originalfilarkivering.
- Ytterligare DB-försegling som hindrar att nya rader läggs till i redan slutna verifikationer även vid direkt SQL. Nu gör API alla rader atomärt och DB spärrar ändring/radering; DB-filen kräver skyddade OS-behörigheter.
- Beständig Playwright-svit, mobilskärmar, tillgänglighetsgranskning, längre belastningsprov, felinjicering under diskfull, processkrasch och avbruten backup.
- Extern redovisningskunnig granskar fakturor, verifikationer, moms, systemdokumentation, behandlingshistorik, arkivering och rutiner. Juridisk granskning av GDPR, avtal och geografisk lagring.

## Fas 4: planerad, inte implementerad

Vid verifierat kundbehov: utvärdera PostgreSQL och migrera det modulära datalagret. Inför organisationer och serverkontrollerad dataisolering med isoleringstester innan flera företag tillåts. Därefter kundadministration, abonnemang, betalningsleverantör, övervakning och kapacitetsplanering. SaaS-komplexitet har inte lagts i den nuvarande modellen.

## Godkännandekriterier

En funktion har inte full Definition of Done enbart för att kod finns. Pengar, journalposter och behörigheter kräver gröna relevanta domän-/HTTP-/integrationstester, felhantering, oberoende granskning och inga öppna kritiska fynd inom det stödda flödet. Drift och juridisk/redovisningsmässig acceptans är separata grindar. Riktiga uppgifter, bankanslutning eller produktionsdrift kräver dessutom ägarens uttryckliga godkännande enligt uppdraget.
