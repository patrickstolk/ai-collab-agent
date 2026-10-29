# Architectuur

## Overzicht

```
 Browser (gebruiker)                    Host / Docker
 ┌───────────────────┐   HTTP(S)   ┌──────────────────────────────┐   gedeeld volume   ┌──────────────────────────┐
 │ Webinterface (NL) │ ──────────▶ │ app (Node.js, Express)        │ ─ sandbox-jobs ──▶ │ sandbox (Node + Python)  │
 │  + chatgpt.com    │             │  workflow · prompts · parsing │ ◀── resultaten ─── │ network_mode: none       │
 │  + claude.ai      │             │  bestanden · rapport · auth   │                    │ read-only, limieten      │
 └───────────────────┘             │  SQLite (/data/app.db)        │                    │ tests als uid 10001      │
   (handmatig kopiëren/plakken)    └──────────────┬───────────────┘                    └──────────────────────────┘
                                                  │ optioneel
                                   ┌──────────────┴───────────────┐
                                   │ Ollama (host)  ·  OpenAI API  │
                                   │ Anthropic API (standaard uit) │
                                   └──────────────────────────────┘
```

## Componenten

| Bestand | Verantwoordelijkheid |
|---|---|
| `src/server.js` | Opstarten, beveiligingsheaders (CSP e.d.), herstel na herstart, sandbox-poller |
| `src/workflow.js` | Toestandsmachine per opdracht; atomische stapovergangen met stap-token |
| `src/prompts.js` | Sjablonen: analyse, uitvoering (+ vast uitvoerformaat), review, verbetering |
| `src/parse.js` | Herkennen van markeringen, bestanden (`### BESTAND:`) en review-JSON |
| `src/checks.js` | Statische controles en het klaarzetten/ophalen van sandbox-taken |
| `src/status.js` | Bepaling van de eindstatus (AI-oordeel ≠ test) |
| `src/files.js` | Opslag per opdracht, uploadvalidatie, tekstextractie (PDF/DOCX/XLSX/ZIP/STEP) |
| `src/providers.js` | Ollama en officiële API's achter één interface |
| `src/report.js` | Eindrapport (HTML en Markdown) uit de opgeslagen gegevens |
| `src/db.js` | Alle SQL; vervangbaar door een PostgreSQL-implementatie met dezelfde exports |
| `src/auth.js` | Gebruikers (scrypt), sessies in de database, CSRF, inlogbeperking |
| `sandbox/worker.mjs` | Voert alleen vaste commando's uit (`node --check`, `node --test`, `py_compile`, `pytest`, `bash -n`) |

## Toestanden van een opdracht

```
WACHT_ANALYSE ──▶ (WACHT_VERDUIDELIJKING ──▶ WACHT_ANALYSE)
      │
      ▼
WACHT_CLAUDE ──▶ TESTS_BEZIG ──▶ WACHT_REVIEW ──┬──▶ AFGEROND (goedgekeurd, of max. cycli/verzoeken)
      ▲                                         │
      └──────────── verbetercyclus ◀────────────┤ (afgekeurd, cycli over)
                                                └──▶ WACHT_BESLISSING (review onleesbaar / fout)
Altijd: GESTOPT ⇄ hervatten · BEZIG/VERWERKEN tijdens een verwerking
```

- Iedere wachtende stap heeft een willekeurig **stap-token**. Een stap wordt alleen verwerkt via
  `UPDATE … WHERE state = ? AND pending_token = ?`. Dubbelklikken, de terugknop of twee tabbladen leiden
  dus nooit tot dubbele verwerking.
- **Na een herstart** zet `recoverInterrupted()` opdrachten in `BEZIG`/`VERWERKEN` terug naar de laatste
  wachtende stap (met waarschuwing). Lopende sandbox-taken staan in de database en worden na de herstart opgehaald of na de time-out als NIET GETEST gemarkeerd.
- Limieten: maximaal aantal verbetercycli en AI-verzoeken per opdracht, en een optioneel kostenbudget (alleen API).

## Statussen en soorten controles

| Soort | Betekenis |
|---|---|
| `UITGEVOERDE_TEST` | Code is daadwerkelijk uitgevoerd in de sandbox (`pytest`, `node --test`) |
| `STATISCH` | Alleen geparsed/syntax gecontroleerd (JSON, YAML, Compose, HTML, Dockerfile, `node --check`, `py_compile`, `bash -n`) |
| `AI_BEOORDELING` | Oordeel van ChatGPT (of handmatig door de gebruiker); geen test |
| `NIET_UITGEVOERD` | Relevante test kon niet draaien → status **NIET GETEST** |

Eindstatus (`src/status.js`):
- **GESLAAGD**: review GOEDGEKEURD én ≥ 1 uitgevoerde test, allemaal geslaagd, en geen mislukte statische controles.
- **HANDMATIGE CONTROLE VEREIST**: review GOEDGEKEURD, maar geen uitvoerbare test gedraaid.
- **GEDEELTELIJK GESLAAGD**: goedgekeurd maar met mislukte controle, of afgekeurd zonder kritieke open punten.
- **MISLUKT**: mislukte tests/controles zonder goedkeuring, of kritieke open punten.
- **NIET GETEST**: geen resultaat of geen beoordeling.

## Opslag

- SQLite in `/data/app.db` (WAL). Tabellen: `jobs`, `events` (alle prompts en exacte antwoorden, analyses,
  waarschuwingen, fouten), `files` (iedere versie), `checks`, `issues`, `sandbox_runs`, `settings`, `users`, `sessions`.
- Bestanden: `/data/jobs/<id>/uploads/`, `/data/jobs/<id>/resultaat/ronde-N/<pad>`, `/data/jobs/<id>/extract/`.
- **PostgreSQL later:** alle SQL staat in `src/db.js`. Een PostgreSQL-versie implementeert dezelfde
  exportfuncties (bijv. met `pg`). De SQL is standaard, op `INSERT … ON CONFLICT` en `PRAGMA`'s na.

## Uitbreiden met een officiële API of een ander model

`src/providers.js` bevat de interface `{ text, model, method, costEur, durationMs }`. Een nieuwe provider
implementeert een `call…(prompt)`-functie en wordt in `runViaProvider` gekozen. De rest van de workflow
(parsing, tests, review, rapport) blijft ongewijzigd, omdat geautomatiseerde antwoorden dezelfde
verwerking volgen als geplakte antwoorden.

## Beveiliging

- Inloggen verplicht (scrypt-hash, sessies `HttpOnly; SameSite=Strict`, optioneel `Secure`); max. 5 mislukte pogingen per 15 min per IP.
- CSRF-token op ieder POST-formulier; strikte CSP zonder inline scripts; `X-Frame-Options: DENY`.
- Geen API-sleutels in de frontend of database; uitsluitend omgevingsvariabelen.
- Logging zonder prompt-/antwoordinhoud; sleutels en wachtwoorden worden gemaskeerd.
- Uploads: extensie-allowlist, controle van magic bytes, grootte- en aantallimieten, veilige bestandsnamen; ZIP: padcontrole per item en limieten op aantal en grootte.
- Gegenereerde bestanden: downloaden als `application/octet-stream`. Een HTML-voorbeeld draait onder een CSP-`sandbox` (opaque origin, geen netwerk).
- Geteste code draait nooit in de app-container, alleen in de sandbox-container: geen netwerk, read-only, `cap_drop: ALL`
  (plus alleen wat nodig is om naar uid 10001 te wisselen), `no-new-privileges`, 512 MB / 1 CPU / 128 processen, time-out per taak.
- De app heeft **geen** toegang tot de Docker-socket en voert nooit iets uit op productieomgevingen.
- Test en productie: `APP_ENV` (zichtbare balk bij `test`/`development`) en een apart Compose-project met eigen volumes (zie README).
