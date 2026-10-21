# Arkitektur och API-kontrakt

Beslut 2026-10-21. Tomt projekt. Första versionen kör lokalt på Node 24 med SQLite, server och statisk svensk webbklient. Avvikelse från föreslagna Next/React/PostgreSQL: inga ramverksberoenden behövs för att verifiera bokföringsmotorn och köra i aktuell miljö. SQLite är en riktig transaktionell databas. PostgreSQL, migreringsverktyg och TypeScript är framtida arbete före fleranvändardrift/SaaS. Detta är inte ett påstående om att samtliga faser är klara.

## Moduler

`src/money.mjs`: exakta belopp. `src/domain.mjs`: schema, transaktioner, affärsregler och rapporter. `src/imports.mjs`: CSV-tolkning och normalisering. `src/security.mjs`: hashning och sessioner. `src/pdf.mjs`: faktura-PDF. `src/server.mjs`: HTTP, RBAC, CSRF, nedladdningar. `public/*`: UI. `scripts/*`: initiering och backup/återställning.

## API (JSON)

Alla utom `/api/login` och `/api/session` kräver session. Mutationer kräver `X-CSRF-Token` från session samt samma Origin. Svar vid fel `{error: string}`. `GET /api/state` returnerar `{company,accounts,customers,invoices,vouchers,bank,imports,documents,periods,reports,audit}`. Pengar i API är heltal ören. Formulär skickar decimalbelopp som strängar, datum YYYY-MM-DD.

- `POST /api/login {email,password}`, `POST /api/logout {}`, `GET /api/session` -> `{user:{id,name,role},csrf}` eller `{user:null}`.
- `PUT /api/company {name,orgNumber,vatNumber,fTax,address,bank,fiscalStart,fiscalEnd,version}` (admin).
- `POST /api/customers {name,orgNumber,email,address}`.
- `POST /api/invoices {customerId,date,dueDate,description,quantity,unitPrice,vatRate}`: en rad i första UI, skapar utkast. `POST /api/invoices/:id/issue {version}` fastställer och bokför 1510/3041/2611. `POST /api/invoices/:id/payment {amount,date}` bokför 1930/1510. `POST /api/invoices/:id/credit {date}` full kredit om obetald. `GET /api/invoices/:id/pdf`.
- `POST /api/vouchers {date,text,lines:[{account,debit,credit}],documentId?}` där debit/credit är decimalsträngar. `POST /api/vouchers/:id/reverse {date,reason}`.
- `POST /api/bank {date,description,amount,currency,reference}`. `POST /api/imports {source:'bank'|'kdp'|'adtraction',csv,mapping?:{date,description,amount,currency,reference}}`. Importer kräver manuell klassificering; ingen automatisk moms.
- `POST /api/periods/lock {through}` (admin).
- `POST /api/documents {name,type,data}` base64 PDF/PNG/JPEG. `GET /api/documents/:id`.
- `GET /api/export/sie`, `GET /api/export/json` (admin). Backup/återställning via CLI.

Roller: admin och accountant får bokföra; viewer läser. Två individuella administratörskonton skapas med slumpade lösenord av lokal setup, inga hårdkodade lösenord. Alla tabeller i ett företag; ingen SaaS-isolering påstås.

## Datamodell och invariants

Company(version), User, Session, Account, Customer, Invoice(version,number,status,original_id,amounts), Voucher(number,date,reversal_of), Entry(voucher,account,debit,credit), BankTransaction(fingerprint), Import, Document(hash,blob), PeriodLock, Counter och Audit. Valutatransaktioner bevarar valuta och originalbelopp. Voucher och Entry skyddas även med DB-triggers mot UPDATE/DELETE. SEK-omräkning av utlandsimport kräver explicit bedömning i kommande flöde.

## Kvalitetsgrind

Pengar/behörigheter: domän- och HTTP-integrationstester med observerbart resultat, dubbla importer, låsning, kreditering, nummerserier, backup/restore. Oberoende säkerhets- och regelverksgranskning, senare kodgranskning. Inga skarpa data, produktionsdrift eller betalningsöverföringar.
