# Svenskt regelverk och kontrollkrav

Granskningsdatum: **2026-10-21**. Omfattning: första versionen för ett svenskt aktiebolag. Detta är en källbaserad kravkartläggning, inte ett juridiskt godkännande eller en verifiering av att implementationen uppfyller samtliga krav. Teknisk rekommendation nedan anger ett konstruktionsval, inte alltid ett uttryckligt lagkrav.

## Bokföring och verifikationer

Alla affärshändelser ska bokföras och kunna presenteras i registreringsordning och systematisk ordning. Verifikationen behöver sammanställningsdatum, affärshändelsedatum, beskrivning, belopp, motpart och ett identifieringstecken som binder underlag till bokföring. Tidpunkt och utförare ska framgå vid rättelse. Systemdokumentation och behandlingshistorik krävs. Aktiebolag ska avsluta bokföringen med årsredovisning. Bevarandetiden löper till slutet av det sjunde året efter kalenderåret när räkenskapsåret avslutades: ett år som slutar 2026 ska bevaras till och med 2033-12-31. Elektronisk förvaring utomlands har särskilda villkor, bland annat anmälan, myndighetsåtkomst och utskriftsmöjlighet i Sverige. Se 4 kap. 1 §, 5 kap. 1, 5–11 §§, 6 kap. 1 § och 7 kap. 1–3 a §§ i [bokföringslagen, konsoliderad t.o.m. SFS 2024:342](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/).

**Tekniska kontrollpunkter:** skilj affärsdatum från registreringstid; ge varje bokförd verifikation beständig identitet; gör huvudbok och grundbok reproducerbara; håll företagets underlag kopplade till posterna. Arkivexport måste omfatta underlag och historik, inte enbart saldon.

## Rättelser, låsning och behandlingshistorik

I datorbaserad bokföring ska rättelse ske med en särskild rättelsepost och ny verifikation. Ursprungsposten ska förbli läsbar. Rättelse hänförs till perioden där felet upptäcks när arbetet med den ursprungliga perioden redan är avslutat. Historiken ska visa registreringsdatum och förändringar som påverkar behandling av poster. Se punkterna 2.1, 2.17–2.18 och 9.15–9.16 i [BFNAR 2013:2 med vägledning Bokföring, uppdaterad genom BFNAR 2024:1](https://www.bfn.se/wp-content/uploads/vl13-2-bokforing.pdf).

**Tekniskt konstruktionsval:** bokförda poster och rader ska skyddas mot UPDATE/DELETE även i databasen. Rättelse skapar motbokning och eventuell ersättningspost i en transaktion, med länk åt båda håll och användare, tid och orsak. Utkast kan ändras; de är inte bokförda poster. Avslutad period spärras för nya bokningar. Versionsspara regler, momskoder, kontoplan och relevanta systemändringar så att äldre beräkningar går att förstå. Automatisk omskrivning av historiska poster vid ändrad momssats är förbjuden i systemets konstruktion.

## Underlag och arkivering

Mottagna digitala kvitton behöver bevaras i mottaget format. Överföring från papper till digital form kan medge att pappret förstörs, men endast om överföringen inte innebär risk för ändring eller förlust av räkenskapsinformationen. Att bara fotografera ett kvitto utgör därför inte ett generellt tillstånd att kasta det. Se [BFN:s frågor och svar om arkivering](https://www.bfn.se/fragor-och-svar/arkivering/), särskilt överföring och utlägg.

**Tekniskt konstruktionsval:** lagra originalfil separat från OCR och miniatyrbild, med hash, filtyp, uppladdningstid och koppling till verifikation. Ge ingen automatisk rekommendation om förstöring. Dokumentera arkivplats, behörigheter, säkerhetskopiering och testad återställning. Behåll läsbar export när applikationen avvecklas. En lokal databas utan återställningsprov är inte en färdig arkivlösning.

## Kundfakturor

Fullständig faktura ska ha utfärdandedatum, unikt löpnummer i en eller flera serier, säljarens momsnummer, båda parters namn/adress, varans mängd/art eller tjänstens omfattning/art, relevant leverans-/betalningsdatum, enhetspris exklusive moms, underlag per momssats/undantag, rabatt, momssats och momsbelopp. Köparens momsnummer behövs vid omvänd betalningsskyldighet. Särskilda hänvisningar kan krävas, exempelvis vid undantag eller omvänd betalningsskyldighet. Kreditnota ska otvetydigt hänvisa till ursprungsfakturan och löpnumret. Om svensk moms ska betalas och redovisningsvalutan är SEK behöver moms i utländsk valuta också anges i SEK. Se [Skatteverkets faktureringsregler](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/fakturering.4.58d555751259e4d66168000403.html).

**Tekniskt konstruktionsval:** validera uppgifterna vid utfärdande; tilldela nummer atomärt och återanvänd dem aldrig. Frys säljare, kund, rader och skatteuppgifter vid utfärdandet så att registerändringar inte ändrar gamla fakturor. Spara fakturans presentationsformat. Hantera rättelse med kreditfaktura och ny faktura när det behövs. Ett betalningsdatum är inte samma sak som fakturans utfärdandedatum.

## Moms och internationella intäkter

Svenska momssatser är normalt 25, 12 och 6 procent; undantagen försäljning behöver särskild behandling. Se [Skatteverkets aktuella momssatser](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momssatserochundantagfranmoms.4.58d555751259e4d66168000409.html). Livsmedel har **6 procent 2026-04-01–2027-12-31**, medan restaurangtjänster fortfarande har 12 procent. Se [Skatteverkets beslutade förändring](https://www.skatteverket.se/omoss/pressochmedia/nyheter/2026/nyheter/livsmedelsmomsensankstill6procent.5.70685bee19c85dd5dd0a3f.html).

**Tekniskt konstruktionsval:** spara skattebehandling, skattesats, beskattningsunderlag, skattebelopp och regelversion på varje bokförd fakturarad. Använd heltalsöre eller decimalaritmetik och dokumenterad avrundning. Skilj momsfri försäljning, nollskattesats och omvänd betalningsskyldighet. Momsrapporten ska kunna härledas till verifikationsrader och manuell justering ska vara spårbar.

Amazon KDP och Adtraction får inte ges generell automatisk momskod enbart på leverantörsnamn eller banktext. Verifiera avtalspart, land, köparstatus, tjänstens karaktär, självfakturering, valuta, avgifter och eventuell källskatt för varje rapporttyp. CSV-import ger granskningsunderlag; användaren ska granska kontering innan bokföring. Denna kartläggning fastställer inte hur bolagets specifika KDP- och affiliateavtal ska beskattas.

## SIE typ 4

[SIE-Gruppens publicerade specifikation, utgåva 4C daterad 2025-08-06](https://sie.se/wp-content/uploads/2026/02/SIE_filformat_ver_4C_2025-08-06.pdf) är tekniskt underlag. PDF-metadata säger DRAFT; dokumentets omslag anger utgåva 4C och filen är länkad från föreningens [formatsida](https://sie.se/format/). Bekräfta versionsstatus vid produktionsvalidering.

Export 4E kräver fler uppgifter än import 4I. Följ obligatorietabellen i kapitel 6; en fil med endast #VER/#TRANS är inte fullständig 4E-export. Kontrollera bland annat #FLAGGA, #PROGRAM, #FORMAT, #GEN, #SIETYP, företagsnamn, räkenskapsår, konton, relevanta saldon och verifikationer. Formatet kräver CP437, datum ÅÅÅÅMMDD, punkt som decimalavskiljare och högst två decimaler för belopp. Positivt belopp motsvarar debet, negativt kredit. Text ska citeras/escapas enligt specifikationen och otillåtna kontrolltecken avvisas.

**Verifiering före leverans:** testa svenska tecken, citationstecken, negativa belopp, ingående saldon och flera räkenskapsår. Stäm av exporterade saldon mot huvudbok. Validera en syntetisk export i [SIE-Gruppens testtjänst](https://sietest.sie.se/) och gör provimport i mottagarsystem. Skicka inte verklig bokföring till extern testtjänst utan behörig instruktion. Påstå inte att produkten är SIE-godkänd utan sådan status.

## Kvarstående kontroll före användning för skarp bokföring

1. Redovisningskonsult bekräftar bolagets bokföringsmetod, momsperiod, kontoplan och KDP-/affiliatehantering utifrån verkliga avtal och rapporter.
2. Stäm av momsrapportens rutor, valutaomräkning och kreditfakturor mot verkliga exempel. Ingen myndighetsinlämning ska markeras genomförd genom enbart lokal export.
3. Dokumentera vald drift- och arkivplats inklusive externa säkerhetskopior; pröva behov av anmälan eller tillstånd enligt lagens förvaringsregler.
4. Genomför återställningsprov samt oberoende granskning av bokföringsspärrar, behörigheter och behandlingshistorik. Dokumentera testbevis och kvarstående fel.
5. Årsredovisning, inkomstdeklaration, K2/K3-val, utdelning och lönefrågor kräver separat omfattning och sakgranskning. Rapporter i applikationen är inte automatiskt färdig årsredovisning.
6. Kontrollera primärkällorna igen när regelverk, affärsmodell eller driftform ändras. Detta dokument beskriver kontrollkrav; uppfyllelse ska visas genom implementation och testresultat.
