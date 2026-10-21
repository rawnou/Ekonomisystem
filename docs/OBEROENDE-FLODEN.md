# Oberoende granskning: användarflöden och funktionella tester

Granskad 2026-10-21. Avgränsning: faktisk klientkod i `public/app.js`, formulärens kontrakt mot domänen, fakturagranskning och koppling från verifikation till underlag. Endast syntetiska uppgifter i separata minnesdatabaser. Ingen produktionskod eller befintlig fil har ändrats av denna granskare.

## Metod och faktiskt genomförda kontroller

Ny fil: `tests/audit-flows.test.mjs`. Den läser den riktiga klientkoden och kör dess submit-/renderfunktioner i en Node-VM med en minimal DOM-stub. POST-mottagaren i FL1 anropar den riktiga `Store.post`, medan ett efterföljande läsfel injiceras. Detta verifierar klientlogik, genererad HTML och verklig bokföringseffekt; det är inte ett webbläsartest och verifierar inte layout, native HTML-validering eller tillgänglighet.

Kört:

```text
node --test tests/audit-flows.test.mjs
5 test, 5 godkända, 0 fel

node --test tests/audit-flows.test.mjs tests/http.test.mjs
7 test, 7 godkända, 0 fel
```

De fyra testerna med `verified` i namnet bekräftar att det beskrivna problemet **finns**. Gröna tester betyder därför inte att riskerna är åtgärdade. FL5 kontrollerar att viewer saknar skrivaråtgärder i faktura-/bokföringsvyn samt att injicerad HTML i kundnamn escapes. De befintliga HTTP-testerna omfattar bland annat login, cookie, CSRF, roller, samtidighet, PDF och detektering av skadat underlag. De har inte skrivits om.

## Kritiska risker

Inga verifierade kritiska fynd inom detta delområde. Detta innebär inte att systemet i sin helhet saknar kritiska brister.

## Höga risker

### FL1 – Ett läsfel efter lyckad bokföring presenteras som sparfel och gör dubbelbokföring möjlig

**Status:** verifierat med riktig bokföringsdomän och klientens submit-handler. **Allvar:** hög.

**Plats:** `public/app.js:374`–400: muterande API-anrop och `refresh()` ligger i samma try/catch; formuläret behålls och knappen aktiveras efter läsfel. `src/server.mjs:224`, `src/domain.mjs:282`: den upprepade manuella verifikationen skapar ytterligare en bokföringspost utan idempotensnyckel.

**Reproduktion:**

1. Fyll i en manuell verifikation för ett syntetiskt inköp: 6110 debet 100 kr, 1930 kredit 100 kr.
2. Låt `POST /api/vouchers` lyckas och spara posten.
3. Låt efterföljande `GET /api/state` misslyckas, exempelvis genom ett tillfälligt anslutningsfel. FL1 injicerar felet precis här.
4. Klienten visar ett vanligt felmeddelande, behåller formuläret och återaktiverar Spara.
5. Tryck Spara igen. Två verifikationer finns; kostnad 200 kr och banksaldo −200 kr trots ett enda avsett inköp på 100 kr.

**Konsekvens:** användarens rimliga återförsök kan dubblera resultat-/balanspåverkan. Databastransaktionen är atomisk men skyddar inte två lyckade anrop. Samma klientmönster finns för andra formulär; deras exakta återförsökseffekter är inte verifierade i detta test.

**Föreslagen åtgärd:** skilj sparresultat från omläsningsresultat. Efter bekräftad POST ska UI tydligt ange att posten är sparad även om omläsning misslyckas och erbjuda att enbart läsa om. Inför dessutom serverlagrad idempotensnyckel för bokföringsoperationer så att även ett borttappat POST-svar kan återhämtas säkert. Bevara avsett innehåll utan att erbjuda en ny oskyddad bokföring.

## Medelhöga risker

### FL2 – Kundformuläret medger tomma fält som servern kräver

**Status:** verifierat, FL2. **Allvar:** medelhög.

**Plats:** `public/app.js:118`–119, `src/domain.mjs:227`–236 och `src/domain.mjs:24`–27.

**Reproduktion:** öppna Kunder och ange bara företagsnamn, eller lämna ett av organisationsnummer, e-post och adress tomt. Endast företagsnamn har `required` i genererad HTML. Servern anropar däremot obligatorisk `text()` för samtliga fyra fält och avvisar med ”Obligatorisk text saknas eller är för lång.”

**Konsekvens:** användaren kan inte slutföra det erbjudna formulärflödet; ett generiskt fel identifierar inte vilket fält som saknas. Det kan dessutom uppmuntra till påhittad e-post för en kund utan sådan adress. Ingen felaktig post sparas i det testade fallet.

**Föreslagen åtgärd:** besluta vilka uppgifter som faktiskt behövs i respektive flöde, gör formulär och serverkontrakt konsekventa samt returnera fältspecifika valideringsfel. Gör exempelvis inte e-post obligatorisk enbart för att databasschemat för närvarande kräver en icke-tom sträng. Behåll servervalidering.

### FL3 – Sparade utkast går inte att sakgranska eller rätta innan fastställning

**Status:** verifierat i faktisk renderfunktion samt genom läsning av serverns tillgängliga fakturarutter, FL3. **Allvar:** medelhög.

**Plats:** `public/app.js:88`–94 (`invoiceRows`), `public/app.js:115`–116 (`invoices`), `src/server.mjs:233`–247. Ingen detalj-/redigerings-/raderingsrutt finns för utkast. PDF-rutten avser fastställda fakturor.

**Reproduktion:** spara en enradig faktura med en unik tjänstebeskrivning, antal 3 och styckepris 100 kr. Listan visar kund, förfallodatum och total men inte beskrivning, fakturadatum, antal eller styckepris. För utkast finns endast Fastställ. Varken PDF-förhandsvisning, öppna utkast, korrigering eller borttagning erbjuds.

**Konsekvens:** ett felskrivet utkast kan inte rättas i det ordinarie flödet, och innehållet kan inte kontrolleras vid ett senare besök innan fastställning. Det ökar risken att fel tjänst eller fel datum fastställs trots korrekt total. Kvarlämnade felutkast belastar också listan ”Utkast att fastställa”. Testet bevisar avsaknad i UI, inte att en verklig användare redan fastställt fel faktura.

**Föreslagen åtgärd:** inför servervaliderad detaljvy och förhandsvisning med alla fakturauppgifter. Låt utkast ändras eller makuleras med versionskontroll och historik. Visa granskningsbild före fastställning; behåll fastställda fakturors oföränderlighet.

### FL4 – Underlagskoppling sparas men kan inte följas från bokföringsvyn

**Status:** verifierat, FL4. **Allvar:** medelhög.

**Plats:** `public/app.js:142`–162 (`ledger`). `document_id` finns i statens verifikationer men används inte vid visning av bokförda poster.

**Reproduktion:** ladda upp ett syntetiskt underlag och skapa en manuell verifikation med det valda underlaget. Efter bokföring visar verifikationsraden nummer, datum, text, kontering och Motboka. Underlagets namn, id eller öppningslänk visas inte. Gå till Dokument: dokumentlistan visar inte heller vilka verifikationer som hänvisar till underlaget.

**Konsekvens:** underlaget är inte förlorat i databasen, men en användare kan inte följa sambandet från verifikationen i gränssnittet. Flera liknande dokument gör manuell avstämning och efterkontroll osäker. Export/databas kan innehålla sambandet men ersätter inte en fungerande granskningsvy.

**Föreslagen åtgärd:** visa underlagsnamn/version och en autentiserad öppningslänk på varje kopplad verifikation. Lägg till motsvarande hänvisningar från dokument till verifikationer och bevara länken vid motbokning.

## Låga risker

Inga separata låga fynd prioriteras här.

## Ej verifierat och avgränsningar

- Ingen manuell webbläsarinteraktion, visuell granskning, skärmläsartest eller mobiltest har utförts av denna granskare.
- Rapportperiod, årsskifte, valutafel, reskontrarättelser och bank-/betalningsdubbletter utanför den manuella verifikationens FL1-fall granskas av andra områden och dubbelräknas inte här.
- Krav på fakturainnehåll, arkivering och spårbarhet måste kontrolleras av en verklig redovisningskunnig person. FL4 är ett verifierat funktionshinder; dokumentet fastslår inte en rättslig överträdelse.

## Bedömning inom delområdet

Systemet kan användas för en **övervakad pilot med enbart syntetiska testdata**, där läsfel efter sparning behandlas som ett särskilt testfall och den faktiska bokföringen kontrolleras innan återförsök. FL1 är ett hinder för att betrakta vanliga användarflöden som tillförlitliga för skarp bokföring. FL2–FL4 behöver hanteras för begriplig kundregistrering, kontrollerad fastställning och användbar spårning till underlag. Bedömningen gäller detta delområde och är inget juridiskt eller redovisningsmässigt godkännande. AI-granskningen ersätter inte verklig redovisningsmässig kontroll före bolagets officiella bokföring.
