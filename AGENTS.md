# Ekonomisystem

Lokal modulär monolit för ett svenskt AB. Endast syntetiska data tills ägaren uttryckligen godkänt annat. Ingen publicering eller bankanslutning.

- Körbar bas: Node.js 24+, ECMAScript-moduler, `node:sqlite`, inga externa runtime-beroenden. Start `node scripts/setup.mjs`, `node src/server.mjs`; test `node --test`.
- Alla pengar är heltal i ören; decimal in/ut via strängar och BigInt. Aldrig flyttalsberäkningar för pengar. SEK är bokföringsvaluta. Valuta och växelkurs bevaras separat.
- Servern kontrollerar autentisering, roll, CSRF och alla bokföringsinvarianter. Lita aldrig på klientvalidering.
- Fastställda fakturor/verifikationer är oföränderliga; rättelser genom motbokning. Låsta perioder får inte kringgås. Transaktioner omfattar nummerserie, poster och behandlingshistorik.
- `src/domain.mjs` ägs initialt av huvudagenten; `public/*` av frontendagenten; granskare skriver endast egna dokument. Samordna innan ägarskap ändras.
- Granskare ska ange konkret fil/plats, risk och rättning. Inget juridiskt godkännande hävdas.
- Hemligheter, SQLite-filer, underlag och backuper får aldrig checkas in. API:er och antaganden finns i docs/ARKITEKTUR.md.
- Följ användarens definition of done; rapportera verkligt körda kontroller och begränsningar. Agenter får delegeras enligt användarens uttryckliga uppdrag, med högst tillgängliga samtidighetsplatser.
