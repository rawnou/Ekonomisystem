# Etappleverans 2026-10-21

## Vad som byggts

Från tom mapp skapades Git-repository, AGENTS.md, modulär lokal webbapplikation och riktig SQLite-databas. Fas 0 är dokumenterad. Fas 1 omfattar två individuella inloggningar, bolagsinställningar, kunder, svenska tjänstefakturor och PDF, delbetalningar/full kredit av obetald faktura, begränsad kontoplan, dubbel bokföring, periodlås, spårbara rättelser, manuell bankregistrering, CSV och dashboard/resultat/balans. Delar av Fas 2: normaliserad KDP-/Adtraction-import, dokumentarkivering och SIE/JSON-export. Delar av Fas 3: oberoende granskningar, regressionstester, backup och testad återställning.

## Agentansvar

Tillgänglig samtidighet var fyra agenter inklusive huvudagenten. Roller schemalades därför i omgångar; inga separata branches/worktrees skapades eftersom projektet saknade historik. Avgränsade filägarskap användes i gemensam arbetskopia.

| Agent              | Faktiskt ansvar                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Huvudagent         | Arkitektur, datamodell/API, backend, bokföringsmotor, pengar, auth/HTTP, importmotor, PDF, backup, integration och domän-/HTTP-tester |
| Frontend           | public/\*: svensk webbklient, åtta vyer, formulär, responsiv CSS, dashboard, bankklassificering, dokument och renderingsprov          |
| Regelverk/SIE      | Aktuella primärkällor, regelverksdokument, självständig SIE-exportmodul och nio tester                                                |
| Säkerhetsgranskare | Säkerhetsplan, oberoende kodgranskning, reproducerade fel, omgranskning och fem regressionstester                                     |
| Kvalitetsgranskare | Oberoende kod-/gränsfallsgranskning, reproducerade fel, omgranskning och åtta regressionstester                                       |

Separata backend- och integrationsagenter användes inte; huvudagenten utförde dessa roller. Oberoende granskning hävdas endast för de två faktiska granskarna och regelverk/SIE-arbetet.

## Fynd och rättningar

- Fel antal SQL-värden vid initiering: rättat med explicit kolumnlista och testad initiering.
- Klientstyrda interna rättelse-/fakturareferenser: publikt bokföringsanrop avvisar dem, interna flöden skapar relationerna.
- Rapportkrasch efter stora ackumulerade belopp: atomär global beloppsgräns med BigInt-kontroll. Rapporternas tillåtna summeringar ryms nu exakt.
- Lösenordshashning: explicita scrypt-parametrar N=131072, r=8, p=1. JSON-export: historiska fakturasnapshots bevaras.
- Tappade rapportperioder i dubblettnyckel: period och källa ingår. Tvetydiga identiska rader inom fil avvisas före import; stabil unik referens krävs för att skilja identiska verkliga händelser mellan filer.
- Fel valutamappning: samtliga explicit angivna kolumner måste finnas.
- Bankbokning direkt mot 1510 kunde avvika från fakturareskontra: flödet spärras i väntan på riktig atomisk matchning. Manuell journal kräver fortfarande redovisningskontroll.
- För stora accepterade fakturautkast: totalgräns kontrolleras vid skapande.
- PDF-klippning: fasta teckenbredder, radbrytning även av långa ord, flera sidor och sidnummer. Renderat och visuellt granskat efter rättning.

## Verifiering och risker

`node --test`: 38/38 godkända. `node --check public/app.js`: godkänd. Webbläsarinloggning/dashboard/utkast och PDF-rendering verifierade. Faktiska kommandon, testfall och begränsningar i TESTER.md. Alla identifierade kritiska granskningsfynd inom stödda flöden har rättats eller spärrats och omgranskats.

Detta är **lokal syntetisk testdrift**. Teknikstacken är Node/JavaScript/SQLite, inte det föreslagna Next/TypeScript/PostgreSQL. Momsbedömningar för plattformar, full bankmatchning/avstämning, momsrapport, huvudbok med kontofilter, årsskifte, kontoadministration och övriga backloggspunkter återstår. TLS/extern backup/full filskanning/uthållig belastning är inte verifierade för produktion. SIE har inte provimporterats i externt system. Juridiskt eller redovisningsmässigt godkännande lämnas inte.

Ingen publicering, faktisk bankkoppling, betalningsöverföring eller verklig kund-/bokföringsdata har använts. Nästa utvecklingsetapp finns i BACKLOGG.md; produktionsdrift kräver användarens uttryckliga godkännande.
