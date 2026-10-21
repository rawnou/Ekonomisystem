# Säkerhetsplan och granskningsunderlag

Datum: 2026-10-21. Omfattning: lokal första version med syntetiska uppgifter, ett företag, två individuella konton, Node.js 24 och SQLite. Detta dokument beskriver avsedda kontroller; det är inte ett påstående att de är implementerade eller testade. Faktisk status ska dokumenteras genom granskning och körda tester.

## Tillitsgränser och driftgräns

Servern ska endast lyssna på 127.0.0.1. Tillåt endast den konfigurerade lokala Host-headern; kontrollera även Origin på ändrande anrop. Webbläsaren, CSV-innehåll och dokument är opålitliga indata. Filer i databasmappen är betrodda enbart i den utsträckning som operativsystemets behörigheter skyddar dem. En lokal administratör kan ändra databas och revisionshistorik; applikationens historik skyddar inte mot detta.

Lokal HTTP är ett uttryckligt undantag för syntetisk utvecklingsdata på loopback. Kravet på krypterad trafik är inte uppfyllt av lokal HTTP. Extern publicering, riktiga bokföringsuppgifter, verklig bankdata och produktionsdrift kräver användarens uttryckliga godkännande och separat driftgranskning med HTTPS, Secure-cookie, hantering av hemligheter, övervakning och återställningsövning. En miljövariabel ska inte kunna aktivera en oskyddad publik lyssningsadress av misstag.

## Identitet och session

- Individuella användare med stabilt internt ID. Användar-ID och roll ska hämtas från serversessionen, aldrig från inskickade formulär.
- Spara endast lösenordshash med individuellt kryptografiskt slumpat salt, algoritmversion och parametrar. Använd Node crypto.scrypt, minst N=131072, r=8, p=1 och tillräcklig maxmem (exempelvis 256 MiB). Mät resursåtgång och begränsa samtidiga lösenordsberäkningar. Jämför lika långa hashvärden med timingSafeEqual.
- Tillåt långa lösenfraser och inklistring. Demoidentiteter och demolösenord får finnas endast vid uttrycklig demo-initiering och måste märkas som syntetiska, offentliga testuppgifter. Ingen automatisk seedning av kända konton i en befintlig databas.
- Felaktigt användarnamn och lösenord ger samma generiska svar. Begränsa inloggningsförsök per konto och IP, med begränsad minnesanvändning och tidsbaserad återställning. Känn till att minnesbaserad begränsning nollställs vid omstart.
- Skapa minst 32 slumpade byte som sessionstoken. Spara tokenhash i databasen; lämna endast token i cookie. Rotera session vid inloggning, använd kort definierad livstid (exempelvis 8 timmar) och neka utgångna sessioner. Utloggning ska ogiltigförklara serverposten.
- Cookie: HttpOnly, SameSite=Strict, Path=/, ingen Domain; Secure krävs för HTTPS. Undvik localStorage för autentisering. Inga sessionstoken i URL:er eller loggar. Sessioner ska inte återaktiveras av backupåterställning.

## Behörigheter och ändrande anrop

Föreslagna roller: admin, accountant och viewer. Admin administrerar företagsinställningar och användare. Accountant får upprätta fakturor, bokföra, importera och låsa perioder. Viewer läser rapporter och dokument. Export innehåller hela ekonomin och kräver autentisering även vid direkt URL. Backup/restore ska vara lokal driftfunktion eller adminfunktion med separat kontroll, aldrig tillgänglig för viewer.

Behörighetskontroll krävs på varje serverrutt, för varje metod och varje objekt. Döljda knappar är inte säkerhetskontroll. Alla resurser hör till det enda konfigurerade företaget; inkommande company_id får inte byta företag. Standard är nekad åtkomst.

Använd POST för mutationer och utloggning. Kräv rätt Origin och sessionbundet CSRF-token på autentiserade mutationer; login behöver också skydd mot login-CSRF, exempelvis strikt Origin-kontroll. Saknad eller felaktig Origin ska nekas i webbläsarflödet. Token ska genereras kryptografiskt och jämföras säkert. GET får inte ändra ekonomisk data. Sätt ingen tillåtande CORS-policy.

## Databas, pengar och samtidighet

Använd parametriserade SQL-uttryck. Tillåt dynamiska kolumnnamn eller sorteringsuttryck endast via fast tillåtelselista. Sätt foreign_keys=ON och lämplig busy_timeout på varje anslutning. Begränsa textlängder, antal rader och total anropsstorlek innan tung bearbetning.

Bokföring, fakturanummer, betalningsregistrering och import ska genomföras atomärt i databastransaktioner. Unika databasvillkor krävs för nummerserier och importdubbletter. Slutgiltiga verifikationer får inte uppdateras eller raderas via affärslogik; rättelse är ny verifikation med referens. Låsta perioder kontrolleras inne i samma skrivtransaktion som bokningen. Ingen klient får skicka ett okontrollerat saldo eller sin egen betald-status.

Belopp lagras i minsta valutaenhet som säkra heltal; validera överflöde före varje multiplikation och summering. Växelkurser lagras med separat exakt representation. Använd versionsnummer eller villkorad uppdatering för redigerbara poster, och returnera konflikt vid gammal version. Testa två samtidiga slutställningar och betalningar, inte bara sekventiella anrop.

## XSS, dokument och import

HTML-escapa alla dynamiska värden även i attribut, feltexter, fakturor och rapporter. Använd CSP som begränsar script och objekt, X-Content-Type-Options: nosniff, Referrer-Policy och frame-ancestors. Felmeddelanden får inte lämna stackspår eller SQL till webbläsaren. HTML-fakturor för utskrift är inte PDF-generering och ska märkas korrekt.

För dokumentuppladdning: endast PDF, JPEG och PNG; verifiera filsignatur och tillåten typ, sätt en liten total storleksgräns och avvisa HTML/SVG/arkiv. Använd servergenererat filnamn och lagring utanför webbroten. Filnamn från användaren är metadata, aldrig sökväg. Tillåt ingen traversering, överskrivning eller symbolisk länk utanför arkivet. Nedladdning går genom autentiserad behörighetskontroll med attachment, nosniff och korrekt typ. Spara storlek och SHA-256 för att upptäcka saknade eller förändrade underlag. Filintegritet gör inte en PDF ofarlig; kör ingen aktiv dokumentkod och planera skanning före verklig dokumentdrift. Om uppladdning saknas ska modulen anges som ej implementerad.

CSV: begränsa byte och radantal, validera rubriker, datum, kodning, valuta och samtliga belopp före lagring. Dubblettkontroll behövs för både identiska filer och samma affärstransaktion i ändrad fil. Visa förhandsgranskning och tydliga radfel. Formelinjektion vid CSV-export ska hanteras för textceller som börjar med =, +, - eller @ utan att ändra bokförda tal.

## Revisionshistorik och personuppgifter

Spara aktör, UTC-tid, åtgärd, objekt-ID och relevant före/efter-beskrivning vid bokning, fakturaslutställning, betalning, periodlåsning, import och inställningsändring. Ändring och dess revisionshändelse ska sparas i samma transaktion. Registrera även lyckad/misslyckad inloggning utan lösenord eller token. Undvik fullständiga dokument och personuppgifter i tekniska loggar.

Revisionshändelser ska inte kunna ändras eller raderas genom applikationen. Databasrestriktioner är extra skydd men ersätter inte extern manipulationsskyddad loggning för framtida drift. Lagra endast nödvändiga kunduppgifter. Databas, bilagor och säkerhetskopior ska ignoreras av Git. Lägg inga API-nycklar eller anslutningshemligheter i källkod. Ingen bankbetalning eller extern integration ska aktiveras i denna etapp.

## Backup och återställning

Ta en konsekvent SQLite-backup med databasens backupfunktion eller VACUUM INTO, inte en rå kopia av en aktiv databas med WAL. Spara backup med unikt tidsstämplat namn och SHA-256-manifest. Automatisk backup ska ske vid definierad start/tidsintervall och före återställning eller migrering. Backupfel måste visas/loggas tydligt; de får inte rapporteras som lyckade.

Backup ska inkludera underlag och deras metadata vid en gemensam konsekvent gräns, eller uttryckligen märkas som enbart databasbackup om bilagor ännu saknas. Samma disk är otillräcklig vid diskfel. För riktig drift behövs krypterad separat lagringsplats, åtkomstbegränsning, verifierad retention och regelbunden övning.

Återställ endast när servern är stoppad. Verifiera källa, manifest, databasens integrity_check, foreign_key_check och förväntad schemaversion i en separat fil innan aktiv fil ersätts. Säkerhetskopiera befintlig databas före byte. Invalidera återställda sessioner, kontrollera verifikationsbalans, nummerserier och underlagsintegritet. Dokumentera återställningskommando och ett faktiskt test med data före/efter. Ett lyckat filkopieringskommando är inte en verifierad återställning.

## Granskningsgrind för lokal version

Följande ska kunna verifieras med faktiska körda tester och filhänvisningar:

1. Fel lösenord nekas; två konton hålls åtskilda; inga lösenord lagras i klartext.
2. Viewer nekas direkt POST till samtliga ekonomiska mutationer och inställningar.
3. Saknad/felaktig CSRF-token och främmande Origin/Host nekas; utloggad/utgången session nekas.
4. HTML- och SQL-angrepp i kundnamn/CSV behandlas som data och förstör inte lagring/rendering.
5. Fel filtyp, överstor fil och sökvägstraversering nekas om uppladdning finns.
6. Samtidiga nummeruttag ger unika nummer; överskridande betalning och obalanserad verifikation lämnar inga halvskrivna poster.
7. Låst period och gammal objektversion nekas även via direkt HTTP och samtidiga anrop.
8. Backup återställs i separat testkatalog; ekonomiska poster och underlag verifieras; gamla sessionscookies nekas.
9. Inga verkliga personuppgifter, hemligheter eller lokala datafiler är spårade i Git.

Kritiska behörighets-, bokförings- eller integritetsfel blockerar godkännande. Saknade funktioner eller kontroller ska redovisas som återstående arbete, inte godkännas utifrån att servern startar.

## Primärkällor

Lästa 2026-10-21. Dessa ger teknisk vägledning och innebär ingen certifiering:

- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): scrypt och parametrar.
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): sessionslivscykel och cookies.
- [OWASP Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): sessionbundna token och Origin-kontroll.
