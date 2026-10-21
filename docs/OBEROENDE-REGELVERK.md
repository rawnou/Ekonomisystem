# Oberoende granskning: svenska bokförings- och momsregler

Granskad 2026-10-21. Endast syntetiska data i minnesdatabaser. Ingen produktionskod ändrad och ingen information uppladdad till extern testtjänst. Rapporten är teknisk kravprövning, inte juridiskt eller redovisningsmässigt godkännande. En verklig redovisningsmässig kontroll krävs före bolagets officiella bokföring.

## Resultat och bevisnivå

Inga nya kritiska fel verifierades inom detta delområde. Två höga och ett medelhögt tekniskt fynd redovisas nedan. Därutöver redovisas ett högt funktionsgap inför skarp användning och frågor som kräver sakkunnig bedömning. Fel från andra delgranskningar, exempelvis årsskifte, betalningsrättelser, Unicode-PDF och förlust av CSV-original, räknas inte igen här.

Kört: `node --test tests/audit-regulations.test.mjs tests/sie.test.mjs`: **14 tester, 14 godkända, 0 fel**. De fem REG-testerna är karaktäriseringsprover: grönt visar att det beskrivna nuläget reproduceras, även när nuläget är en brist. De är inte bevis på regelefterlevnad. SIE-sviten verifierar bl.a. balanser, CP437, rättelser, svensk registreringsdag och avvisning av obalanserade data. Ingen extern SIE-validering eller mottagarimport har utförts.

## Höga risker

### REG-01 – Faktura-PDF uppger ett tjänstedatum som inte har samlats in

**Status:** verifierat tekniskt fel. **Plats:** `src/pdf.mjs:27`, `src/domain.mjs:82`, `src/domain.mjs:243–278`.

**Reproduktion:** skapa kund; skapa faktura med `date: '2026-10-01'`, `deliveryDate: '2026-09-30'`, tjänst 10 000 SEK + 25 procent; fastställ och exportera PDF. Det separata datumet ignoreras, inget leveransdatum lagras och PDF skriver uttryckligen `Leverans-/tjänstedatum: 2026-10-01 (samma som fakturadatum)`. Även UI saknar detta fält (`public/app.js:116`). Riskprovet REG-01 kör hela kedjan i domänen och inspekterar PDF-innehållet.

**Konsekvens:** en vanlig tjänst som slutförts föregående månad kan få felaktig datumuppgift på fakturan. Fri fakturatext kan innehålla det riktiga datumet, men tar inte bort den motsägande automatiska uppgiften. Det går därför inte att generellt hänvisa till att användaren kan beskriva leveransen manuellt. Uppgiften kan också ge missvisande stöd för periodbedömning.

**Föreslagen åtgärd:** samla in och frys separat tjänste-/leveransdatum eller period; tillåt explicit bekräftelse när datum verkligen sammanfaller; återge endast verifierade uppgifter. Avvisa ej stödda förskotts- och samlingsfakturafall tills särskilda flöden finns. Prova månadsgräns, samlingsfaktura och kreditfakturans hänvisning.

**Regelanknytning:** datum för leverans/tillhandahållande ska anges när det kan fastställas och avviker från fakturadagen. Skatteverkets [faktureringsregler, Fakturans innehåll](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/fakturering.4.58d555751259e4d66168000403.html), kontrollerad 2026-10-21. Fyndet gäller ett felaktigt automatiskt påstående, inte ett påstående att alla fakturor behöver olika datum.

### REG-02 – Ofullständigt beskriven affärshändelse kan bokföras utan spårbar komplettering

**Status:** verifierat tekniskt kontrollgap; rättslig konsekvens beror även på externa underlag/rutiner. **Plats:** `src/domain.mjs:84`, `src/domain.mjs:92`, `src/domain.mjs:282–295`, `src/domain.mjs:337–353`; journalformulär `public/app.js:143`.

**Reproduktion:** bokför `text: 'Inköp'`, datum 2026-10-01, debet 6110 100 SEK/kredit 1930 100 SEK, utan `documentId`. Det godtas. Verifikationen innehåller ingen motpart och ingen underlagshänvisning. Ladda därefter upp ett syntetiskt underlag. Underlaget kan arkiveras men det finns ingen domän-/API-funktion för att koppla det till den befintliga verifikationen; direkt UPDATE hindras korrekt av oföränderlighetstriggern. Exporten visar fortfarande `document_id: null`. REG-02 bekräftar detta.

**Konsekvens:** ett normalt fall med försenat kvitto lämnas utan maskinellt sökbart samband mellan bokföring och underlag. Det går att bokföra med enbart allmän beskrivning utan motpart. Ett separat manuellt register kan i princip komplettera uppgifterna; testet bevisar alltså inte att varje manuell verifikation är rättsstridig. Däremot saknas tekniskt stöd och kontroll för fullständighet i det granskade flödet.

**Föreslagen åtgärd:** stöd explicit motpart och underlag eller kontrollerad hänvisningsverifikation, med dokumenterad anledning om uppgift saknas. Lägg till en separat append-only kompletteringsrelation med aktör, datum och orsak för att efterkoppla underlag utan att skriva om bokförda poster. Visa kvarstående kompletteringsbehov. Kräv inte att varje boksluts-/rättelsepost har en separat kvittofil; sådana underlag kan vara egenupprättade.

**Regelanknytning:** BFL 5 kap. 6–8 §§ kräver verifikation och normalt uppgifter om datum, innebörd, belopp och motpart samt identifierbart samband och relevanta underlag. [Bokföringslagen](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/), aktuell konsolidering kontrollerad 2026-10-21.

### REG-04 – Momsdeklarationsunderlag och metodstöd saknas

**Status:** verifierat funktionsgap, inte verifierat beloppsfel i det stödda 25-procentsfallet. **Plats:** `src/domain.mjs:371–405` (`issue`), `src/domain.mjs:748–780` (`reports`), kontoplan `src/domain.mjs:46–68`.

**Reproduktion:** fastställ faktura på 10 000 SEK exklusive moms. 2611 krediteras korrekt med 2 500 SEK. `reports()` innehåller kontosaldon men ingen momsperiod, deklarationsruta, momsrapport eller vald momsredovisningsmetod. REG-05 verifierar detta. Inställningarna innehåller ingen registrerad momsperiod eller metod. Moms på vanliga kundfakturor bokas alltid vid fastställande; ett särskilt förskottsflöde saknas.

**Konsekvens:** saldot på 2611 är inte tillräckligt underlag för en komplett momsdeklaration med perioder och beskattningsunderlag. Systemet kan inte avgöra om det motsvarar bolagets registrerade metod eller hantera förskott som ett eget fall. Det är inte visat att bolagets faktiska moms är fel, eftersom verkliga förutsättningar inte har tillhandahållits. För ett momsregistrerat AB är detta ett hinder för att använda systemets rapporter som färdigt deklarationsunderlag.

**Föreslagen åtgärd:** fastställ bolagets metod/period med redovisningskunnig och begränsa uttryckligen till verifierade fall. Bygg periodiserad och spårbar mappning till deklarationsrutor, avstämning av beskattningsunderlag och momskonton samt rättelsehantering. Lägg till särskilda förskottsfall och bokslutsmetod endast efter beslut och sakgranskning.

**Regelanknytning:** metod och momsregistrering styr när moms redovisas; förskott har särskilda betalningstidpunkter. Se Skatteverkets [När ska jag deklarera moms](https://www.skatteverket.se/foretag/moms/deklareramoms/narskajagdeklareramoms.html), kontrollerad 2026-10-21.

## Medelhöga risker

### REG-03 – Räkenskapsår kan konfigureras till fem år

**Status:** verifierat valideringsfel. **Plats:** `src/domain.mjs:200–207`; följdeffekt i `src/sie.mjs:95–98` och exportens `#RAR`.

**Reproduktion:** före första bokföringen, uppdatera företag med `fiscalStart: '2026-01-01'`, `fiscalEnd: '2030-12-31'` och aktuell version. Inställningen godtas. Bokning 2030-12-01 godtas och SIE innehåller `#RAR 0 20260101 20301231`. REG-03 provar samtliga steg.

**Konsekvens:** ett orimligt långt räkenskapsår gör att årsrapporter och export omfattar flera år. Efter första bokningen hindras vanlig korrigering av årsgränserna. Kräver administrativ åtkomst och är mindre sannolikt än vardagsfelen ovan.

**Föreslagen åtgärd:** validera ordinarie tolvmånadersår och särskilt dokumenterad första/omlagd period om högst 18 månader; kontrollera verkliga kalendergränser och lagliga undantag med sakkunnig. Avvisa samma fel i SIE-export. Separera detta från det redan identifierade generella stödet för årsskifte.

**Regelanknytning:** BFL 3 kap. 1 och 3 §§ anger normal tolv månader och högst arton månader vid inträde/omläggning. Källa: [Bokföringslagen](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/).

## Låga risker

Inga separata låga fynd prioriteras i detta delområde. De dokumenterade begränsningarna ska fortsatt framgå i systemets beskrivning.

## Avgränsningar, misstänkta risker och externa sakkunnigfrågor

- 0, 6 och 12 procent avvisas av fakturaflödet; REG-04 verifierar att inga fakturor/verifikationer då skapas. Detta är en tydligt beskriven begränsning till svenska tjänster med 25 procent, inte en felaktig tillämpning av alla andra satser. Internationell försäljning, undantag, omvänd betalningsskyldighet och bolagets KDP-/Adtraction-avtal kräver separat klassificering. Ingen generell automatisk momskod på leverantörsnamn kan rekommenderas.
- SIE exporterar noll som ingående saldo och anger att migration ska göras genom verifikationer (`src/sie.mjs:81–85`, `src/sie.mjs:161–168`). Det kan vara rimligt i ett helt nytt syntetiskt bolag; ett befintligt AB behöver kvalitetssäkrad öppningsbalans och jämförelsedata. Godkända lokala SIE-tester är inte SIE-certifiering eller bevis på korrekt mottagarimport. Detta samordnas med ekonomi-/arkitekturgranskning och räknas inte som ett nytt fristående fel här.
- Elektroniska underlag begränsas till PDF/PNG/JPEG (`src/domain.mjs:697–705`). Verkliga XML-/andra originalformat behöver arkivlösning utanför detta flöde. Bekräfta exakt mottaget format, bevarande och eventuell kontrollerad överföring; ett filhashvärde ersätter inte innehållet. BFN anger bevarandetid och formatfrågor i [frågor och svar om arkivering](https://www.bfn.se/fragor-och-svar/arkivering/), kontrollerad 2026-10-21. CSV-original behandlas separat av andra granskare.
- Utfärdade PDF-filer genereras på nytt från fryst fakturadata och aktuell kod. Ingen fryst PDF eller renderarversion lagras. Kodläsningen visar en framtida reproducerbarhetsrisk; ingen redan inträffad innehållsförlust efter programuppgradering har bevisats. Arkivering måste omfatta mottagna/upprättade handlingar, dokumenterade rutiner, tillgänglig läsning och provad återställning under hela tiden.
- Årsredovisning, skatt, K2/K3, periodisering, utländska royalty-/affiliateavtal, verkliga momsregistreringar, förvaringsplats och bokslutsunderlag har inte sakgranskats. Sidoordnad leverantörsbokföring och specifikationer av balansposter kräver bedömning utifrån bolagets omfattning. Ingen slutsats om fullständig redovisningsmässig efterlevnad kan dras från kodtesterna.

## Bedömning

En avgränsad teknisk pilot med syntetiska testdata är möjlig för att hitta och rätta bristerna, förutsatt att felaktigt tjänstedatum och avsaknad av komplett moms-/underlagsstöd är kända. De återstående hindren för officiell bokföring omfattar verifierade fakturauppgifter, komplett verifikations- och kompletteringskedja, giltiga årsgränser, momsmetod och deklarationsavstämning samt övriga agentspecifika fynd. En verklig redovisningsmässig kontroll av bolagets egna rutiner och representativa exempel krävs. Denna AI-granskning ersätter den inte.
