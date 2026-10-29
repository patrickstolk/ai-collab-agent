# AI Collaboration Agent

Eén centrale webapplicatie (Nederlandstalig) waarin **ChatGPT een opdracht analyseert en een prompt schrijft,
Claude de opdracht uitvoert, de applicatie echte tests draait en ChatGPT het resultaat onafhankelijk
beoordeelt**, met verbetercycli, volledige geschiedenis en een eindrapport.

**Werkt zonder API-sleutels.** De hoofdroute is begeleide handmatige overdracht: de applicatie maakt iedere
prompt kant-en-klaar, u plakt hem in ChatGPT of Claude en importeert het antwoord. Lokale AI (Ollama) en de
officiële API's zijn optioneel en staan standaard uit.

> Waarom geen automatische bediening van chatgpt.com/claude.ai? Beide gebruiksvoorwaarden verbieden
> geautomatiseerde toegang tot en extractie uit de consumenten-webinterfaces. Zie [docs/HAALBAARHEID.md](docs/HAALBAARHEID.md).

## Inhoud
1. [Wat werkt wel en niet](#wat-werkt-wel-en-niet)
2. [Installatie (Docker Compose)](#installatie-docker-compose)
3. [Configuratie](#configuratie)
4. [Dagelijks gebruik](#dagelijks-gebruik)
5. [Optioneel: Ollama en API's](#optioneel-ollama-en-apis)
6. [Achter Traefik](#achter-traefik)
7. [Testen](#testen)
8. [Troubleshooting](#troubleshooting)
9. [Beperkingen](#beperkingen)

Zie ook: [docs/ARCHITECTUUR.md](docs/ARCHITECTUUR.md) en [docs/TESTVERSLAG.md](docs/TESTVERSLAG.md).

## Wat werkt wel en niet

| Functie | Zonder API | Opmerking |
|---|---|---|
| Opdrachten, prompts, geschiedenis, versies, rapporten | ✅ | SQLite + bestanden in een volume |
| ChatGPT/Claude via webinterface | ✅ handmatig | Kopiëren → plakken → importeren |
| Herkennen van prompt, bestanden en review | ✅ | Via vaste markeringen; bij twijfel vraagt de app u te beslissen |
| Statische controles (JSON, YAML, Compose, HTML, Dockerfile) | ✅ | In de app; code wordt niet uitgevoerd |
| Echte tests (`pytest`, `node --test`) en syntaxcontrole | ✅ | In de geïsoleerde sandbox-container |
| Bestanden lezen: PDF, DOCX, XLSX, ZIP, tekst/code | ✅ | Leesstatus per bestand zichtbaar |
| STEP-bestanden | ⚠️ gedeeltelijk | Kop, onderdelen, eenheden, entiteiten; **geen** geometrie |
| Conceptprompt via lokale AI (Ollama) | ✅ optioneel | Vervangt de review door ChatGPT niet |
| Volledig automatische workflow | ❌ | Alleen met de API's (aparte betaalde accounts) |
| Browserautomatisering van chatgpt.com / claude.ai | ❌ | Niet toegestaan, niet gebouwd |
| Browser-/UI-tests, `docker compose config`, TypeScript-compilatie | ❌ | Worden als **NIET GETEST** gerapporteerd |

## Installatie (Docker Compose)

Vereist: Docker Engine met de Compose-plugin (v2). Getest ontwerp voor Linux-hosts (ook Unraid).

```bash
git clone <deze map> ai-collab-agent   # of kopieer de map naar uw server
cd ai-collab-agent
cp .env.example .env
```

Bewerk `.env` en zet minimaal:
- `SESSION_SECRET`: een lange willekeurige waarde (`openssl rand -base64 48`)
- `ADMIN_PASSWORD`: minimaal 12 tekens (of laat leeg en gebruik `/setup`, zie hieronder)
- `APP_PORT`: de poort op de host (standaard 3000)

Starten:

```bash
docker compose up -d --build
```

Open `http://<server>:3000` en log in met `ADMIN_USER` / `ADMIN_PASSWORD`. Daarna kunt u
`ADMIN_PASSWORD` weer leegmaken in `.env`; het account staat in de database.

**Zonder `ADMIN_PASSWORD`:** open `/setup` en vul de installatiecode in. Die staat in de logs:

```bash
docker compose exec app cat /data/SETUP_CODE.txt
```

### Poorten, volumes en omgevingsvariabelen

| Onderdeel | Waarde |
|---|---|
| Poort | Container `3000` → host `${APP_PORT}` (alleen de `app`-service; de sandbox heeft geen netwerk) |
| Volume `app-data` → `/data` | Database `app.db`, opdrachtbestanden `jobs/`, sessiesleutel, optionele logs |
| Volume `sandbox-jobs` → `/sandbox-jobs` | Wachtrij tussen app en sandbox (tijdelijk) |

| Variabele | Standaard | Betekenis |
|---|---|---|
| `APP_PORT` | 3000 | Hostpoort |
| `APP_ENV` | production | `test`/`development` tonen een waarschuwingsbalk |
| `SESSION_SECRET` | (gegenereerd) | Sleutel voor sessiecookies |
| `ADMIN_USER` / `ADMIN_PASSWORD` | admin / – | Eerste account |
| `COOKIE_SECURE` | false | `true` bij HTTPS |
| `TRUST_PROXY` | false | `true` achter een reverse proxy |
| `SESSION_HOURS` | 12 | Sessieduur |
| `MAX_UPLOAD_MB` / `MAX_UPLOAD_FILES` | 25 / 20 | Uploadlimieten |
| `SANDBOX_TIMEOUT_SEC` | 180 | Max. wachttijd op sandbox-resultaten |
| `OLLAMA_URL` | http://host.docker.internal:11434 | Optioneel |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | – | Optioneel, alleen gebruikt als API's zijn toegestaan |

**Bind-mounts in plaats van volumes (bijv. Unraid `/mnt/user/appdata`)**: vervang in `compose.yaml`
`app-data:/data` door `/mnt/user/appdata/ai-collab-agent/data:/data` en `sandbox-jobs:` door een tweede map.
Geef beide mappen eigenaar uid/gid 1000 en geef de sandbox-map modus 700:

```bash
mkdir -p /mnt/user/appdata/ai-collab-agent/{data,sandbox-jobs}
chown -R 1000:1000 /mnt/user/appdata/ai-collab-agent
chmod 700 /mnt/user/appdata/ai-collab-agent/sandbox-jobs
```

### Bijwerken en back-up

```bash
docker compose pull; docker compose up -d --build     # bijwerken
docker compose stop app
docker run --rm -v ai-collab-agent_app-data:/data -v "$PWD":/backup alpine tar czf /backup/aca-backup.tgz -C /data .
docker compose start app
```

### Test- en productieomgeving gescheiden houden

Draai een testinstantie als apart Compose-project, met eigen volumes en een andere poort:

```bash
APP_PORT=3001 docker compose -p aca-test --env-file .env.test up -d --build
```

Zet in `.env.test` `APP_ENV=test`. De interface toont dan een oranje balk "Omgeving: TEST".

## Configuratie

Alles wat geen geheim is stelt u in via **Instellingen** in de webinterface:
- maximaal aantal verbetercycli (standaard 3) en AI-verzoeken per opdracht (standaard 20)
- workflowmodus (handmatig; automatisch alleen met API's) en standaard-overdrachtsmethode
- lokale AI (aan/uit, model, time-out)
- API-integraties (aan/uit, modelnamen, optioneel prijzen per miljoen tokens en een kostenbudget)
- sandbox aan/uit, logniveau en loggen naar bestand
- overzicht van bestandsopslag; wachtwoord wijzigen

**Integraties** toont per integratie de werkelijke status: *Beschikbaar en werkend*, *Nog te configureren*,
*Niet beschikbaar*, *Handmatige overdracht vereist* of *Optioneel met API-toegang*.

## Dagelijks gebruik

1. **Nieuwe opdracht**: titel, opdracht, eventueel acceptatiecriteria en bestanden. Kies:
   - *Workflow*: **Volledig** (ChatGPT analyseert → Claude voert uit → ChatGPT reviewt) of **Direct** (opdracht rechtstreeks naar Claude).
   - *Overdracht*: **Handmatig** (zonder API) of **API** (alleen als geconfigureerd).
2. **Stap 1 – Analyse**: klik *Prompt kopiëren*, dan *ChatGPT openen*, plak de prompt in een nieuw gesprek,
   kopieer het antwoord met de kopieerknop van ChatGPT en klik *Antwoord importeren*.
   Vraagt ChatGPT om verduidelijking, dan beantwoordt u de vragen in de app.
3. **Stap 2 – Uitvoering**: de app toont de **exacte** prompt voor Claude (de prompt van ChatGPT plus een vast
   uitvoerformaat en uw bestanden). Eventueel eerst bewerken. Kopiëren → *Claude openen* → antwoord importeren.
4. **Tests**: de app slaat de bestanden op (als nieuwe versie) en voert controles uit. Deze pagina ververst vanzelf.
5. **Stap 3 – Review**: open een **nieuw** ChatGPT-gesprek, plak de reviewprompt (met de feitelijke testresultaten)
   en importeer de review. Bij afkeuring maakt de app automatisch de verbeterprompt voor Claude (terug naar stap 2).
6. **Afgerond**: *Eindrapport bekijken* (ook als Markdown), bestanden downloaden (los of als ZIP), wijzigingen per versie bekijken.

Overig: *Stoppen* / *Hervatten*, *Opnieuw uitvoeren* (kopie met dezelfde invoerbestanden),
*Nieuwe verbetercyclus starten* na afronding, en *Geschiedenis → vergelijken* van twee opdrachten.

**Tips**
- Gebruik de kopieerknop onder het antwoord in ChatGPT/Claude; zelf selecteren kan codeblokken en markeringen kwijtraken.
- Toont Claude een bestand als *artifact* of bijlage, vraag dan: "Geef alle bestanden in de tekst in het gevraagde formaat".
- Klembord-kopiëren werkt via HTTPS of `localhost`. Via `http://<ip>` selecteert de knop de tekst; druk dan Ctrl+C, of gebruik *Downloaden als .txt*.

## Optioneel: Ollama en API's

**Ollama** (gratis, lokaal):
1. Installeer Ollama op de host en download een model: `ollama pull qwen3.5:4b` (of een ander model).
2. Laat Ollama luisteren op het Docker-netwerk: zet `OLLAMA_HOST=0.0.0.0` voor de Ollama-service op de host.
   Bescherm poort 11434 met de firewall; Ollama heeft zelf geen authenticatie.
3. `OLLAMA_URL=http://host.docker.internal:11434` in `.env` (standaard), `docker compose up -d`.
4. Instellingen → *Lokale AI inschakelen* en de modelnaam. Integraties toont of het werkt.
5. Bij stap 1 verschijnt *Conceptprompt door lokale AI (Ollama)*. Dit wordt in de geschiedenis als *Lokale AI* gemarkeerd.

**API's** (betaald, standaard uit):
1. Maak aparte API-accounts aan bij OpenAI en/of Anthropic. Een ChatGPT- of Claude-abonnement geeft **geen** API-toegang.
2. Zet `OPENAI_API_KEY` en `ANTHROPIC_API_KEY` in `.env` en herstart.
3. Instellingen → *API-integraties toestaan*, modelnamen invullen, eventueel prijzen en een kostenbudget.
4. Kies bij een nieuwe opdracht *Automatisch via API*. Met workflowmodus *Automatisch* loopt de hele cyclus zonder klikken.

De API-adapters zijn gebouwd volgens de openbare API's (`/v1/chat/completions`, `/v1/messages`), maar **niet getest**,
want er waren geen sleutels beschikbaar.

## Achter Traefik

Gebruik de labels die als commentaar in `compose.yaml` staan, koppel de `app`-service aan uw Traefik-netwerk,
verwijder eventueel de `ports`-regel en zet in `.env`: `COOKIE_SECURE=true` en `TRUST_PROXY=true`.

## Testen

Zonder Docker, met Node.js ≥ 22.13:

```bash
npm ci
npm test
```

- `test/unit.test.js`: parsing, statische controles, diff, ZIP, extractie (ZIP/STEP/PDF), uploadvalidatie, logmaskering.
- `test/workflow.test.js`: de volledige workflow via HTTP met de **echte** sandbox-worker: inloggen, CSRF,
  opdracht + upload, analyse, Claude-resultaat, tests in de sandbox, afgekeurde review, verbetercyclus, goedkeuring,
  eindrapport, diff, ZIP, dubbele verwerking, verduidelijking, limieten, stoppen/hervatten, herstel na herstart, opnieuw uitvoeren.

De "AI-antwoorden" in deze tests zijn **vaste testgegevens** om de verwerking door de app te controleren.
Ze bewijzen niet dat ChatGPT of Claude zelf antwoorden; die stappen voert u handmatig uit.

Na installatie met Docker (rooktest):

```bash
docker compose ps                                   # beide services "healthy"
curl -fsS http://localhost:3000/healthz             # {"ok":true}
docker compose exec sandbox cat /sandbox-jobs/heartbeat.json   # isolation: "geen netwerktoegang (gecontroleerd)"
```

Doorloop daarna de voorbeeldopdracht "Maak een kleine HTML-webpagina met een invoerveld, een knop en een resultatenveld".

## Troubleshooting

| Probleem | Oplossing |
|---|---|
| `env file .env not found` | `cp .env.example .env` |
| Kan niet inloggen / geen account | Zet `ADMIN_PASSWORD` (≥ 12 tekens) en herstart, of gebruik `/setup` met de code uit `docker compose exec app cat /data/SETUP_CODE.txt` |
| "Te veel mislukte pogingen" | 15 minuten wachten (per IP). Achter een proxy: `TRUST_PROXY=true` |
| "Ongeldig of verlopen formulier (CSRF)" | Pagina opnieuw laden; sessie verlopen → opnieuw inloggen |
| Ingelogd blijven lukt niet via HTTP | `COOKIE_SECURE=true` vereist HTTPS; zet op `false` bij gewone HTTP |
| Dashboard: "Sandbox niet beschikbaar" | `docker compose ps sandbox`, `docker compose logs sandbox`. Tests worden dan als NIET GETEST gemeld |
| `EACCES` op `/data` of `/sandbox-jobs` | Bij bind-mounts: `chown -R 1000:1000 <map>`; sandbox-map `chmod 700` |
| Sandbox start niet op Docker Desktop/rootless | `cap_add`/`pids_limit` worden niet overal ondersteund; controleer `docker compose logs sandbox` |
| Ollama "niet bereikbaar" | Ollama moet op `0.0.0.0` luisteren; test vanuit de container: `docker compose exec app node -e "fetch('http://host.docker.internal:11434/api/tags').then(r=>r.text()).then(console.log)"` |
| "Geen gemarkeerde prompt gevonden" | Antwoord met de kopieerknop van ChatGPT kopiëren; anders wordt het hele antwoord voorgesteld en kunt u het bewerken |
| "Geen bestanden herkend" | Vraag Claude de bestanden te leveren met `### BESTAND: pad` gevolgd door een codeblok |
| "Deze stap is al verwerkt" | Normaal na dubbelklik of verouderd tabblad; de pagina toont de actuele stap |
| Opdracht bleef hangen na herstart | Wordt bij het opstarten automatisch teruggezet naar de laatste wachtende stap (zie geschiedenis) |
| Prompt te lang voor ChatGPT/Claude | Waarschuwing verschijnt boven een instelbare grens; verklein bestanden of splits de opdracht |

## Beperkingen

- Handmatige overdracht blijft handwerk: per cyclus drie keer kopiëren en plakken.
- Abonnementslimieten van ChatGPT/Claude worden niet gemeten. Kosten van webabonnementen zijn niet per opdracht toe te rekenen.
- Een AI-review is geen test. Zonder uitvoerbare test wordt een opdracht nooit **GESLAAGD**, hoogstens
  **HANDMATIGE CONTROLE VEREIST**.
- De sandbox heeft geen internet en geen extra pakketten: tests met externe afhankelijkheden mislukken of worden niet uitgevoerd.
- Geen browser-/UI-tests, geen Docker-in-Docker, geen TypeScript-compiler, geen OCR, geen CAD-geometrie.
- Eén gebruikersrol (beheerder); meerdere accounts kunnen alleen via de database worden aangemaakt.
