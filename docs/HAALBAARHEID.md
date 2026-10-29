# Fase 1 – Technische haalbaarheid (zonder API-toegang)

Peildatum: 29 oktober 2026. Uitgangspunt: alleen een normaal ChatGPT- en Claude-webabonnement, geen API-sleutels.

## Samenvatting

| Methode | Werkt zonder API? | Toegestaan? | Betrouwbaar? | Gekozen |
|---|---|---|---|---|
| A. Browserautomatisering van chatgpt.com / claude.ai | Technisch soms | **Nee** – beide gebruiksvoorwaarden verbieden het | Nee | **Niet gebouwd** |
| B. Begeleide handmatige overdracht | **Ja** | Ja | Ja (mens kopieert/plakt) | **Hoofdroute** |
| C. Lokale AI via Ollama | Ja (lokaal) | Ja | Afhankelijk van hardware/model | **Optioneel, standaard uit** |
| D. Officiële API's (OpenAI, Anthropic) | Nee – vereist aparte betaalde API-toegang | Ja | Ja | **Optioneel, standaard uit** |

## Methode A – Browserautomatisering (Playwright e.d.)

**Gebruiksvoorwaarden (gecontroleerd op 29-10-2026):**

- *OpenAI Gebruiksvoorwaarden* (ingangsdatum 1 januari 2026) verbieden onder meer: "Automatisch of programmatisch gegevens of Output … extraheren."
- *Anthropic Consumer Terms* (ingangsdatum 8 oktober 2025), sectie 3, verbieden: toegang tot de diensten "through automated or non-human means, whether through a bot, script, or otherwise", behalve via een Anthropic API-sleutel of met expliciete toestemming. Ook scrapen/harvesten van gegevens is verboden.

Een Playwright-script dat prompts in de webinterface typt en antwoorden uitleest valt hier precies onder. Daarnaast:

- **Betrouwbaarheid:** beide sites wijzigen hun DOM regelmatig, gebruiken bot-detectie (Cloudflare e.d.), en kunnen CAPTCHA's of extra verificatie tonen. Die mogen we niet omzeilen. Een script zou dus regelmatig breken.
- **Sessies:** de enige toegestane manier zou een door de gebruiker zelf geopende browser zijn. Cookies of tokens uit browserprofielen halen is uitgesloten.
- **Dubbel uitvoeren / time-outs:** is wel op te lossen, maar dat weegt niet op tegen het verbod.

**Conclusie:** browserautomatisering van de consumenten-webinterfaces wordt **niet** gebouwd. In de applicatie staat de integratie als "Niet beschikbaar" met deze reden. Fase 3 (automatisering) verloopt daarom via de officiële API's, en alleen als de gebruiker die zelf activeert.

Ook niet gebruikt: niet-gedocumenteerde URL-parameters zoals `?q=` om een prompt vooraf in te vullen. Die zijn officieel niet ondersteund, kunnen zonder aankondiging verdwijnen en breken bij lange prompts. De knoppen "ChatGPT openen" / "Claude openen" openen alleen de normale startpagina.

## Methode B – Begeleide handmatige overdracht (hoofdroute)

Wat daadwerkelijk werkt zonder API en zonder extra kosten:

1. De applicatie stelt iedere prompt volledig en zelfstandig leesbaar op (analyse, uitvoering, review, verbetering).
2. Knop **Prompt kopiëren** (klembord) of **Downloaden als .txt**, en een knop om ChatGPT of Claude in een nieuw tabblad te openen.
3. De gebruiker plakt het antwoord terug (bij voorkeur via de kopieerknop van ChatGPT/Claude zelf, zodat de Markdown-opmaak behouden blijft).
4. De applicatie herkent vaste markeringen in het antwoord (prompt voor Claude, bestanden, review-JSON). Lukt dat niet, dan vraagt de applicatie om een handmatige beslissing en verzint zij niets.
5. Iedere stap is persistent opgeslagen; de opdracht kan op elk moment worden hervat.

Beperkingen:
- Iedere overdracht is een handeling van de gebruiker.
- Webabonnementen hebben gebruikslimieten (berichten per tijdvak, maximale invoerlengte). De applicatie waarschuwt bij zeer lange prompts, maar kent de actuele limieten van uw abonnement niet.
- Welk model in de webinterface antwoordde, is niet automatisch vast te stellen; de gebruiker kan het optioneel invullen.
- Klembordtoegang via de browser werkt alleen in een *secure context* (HTTPS of `localhost`). Over gewone HTTP via een LAN-IP valt de knop terug op selecteren + `execCommand('copy')` of downloaden.

Kosten: geen extra kosten bovenop het bestaande abonnement.

## Methode C – Lokale AI via Ollama

- Werkt via de HTTP-API van Ollama (`/api/tags`, `/api/chat`). Op de ontwikkelmachine is Ollama 0.40.11 aanwezig met model `qwen3.5:4b`.
- Inzet in de applicatie: **conceptversie van de uitvoeringsprompt** maken. Dit is duidelijk gemarkeerd als "Lokale AI". De onafhankelijke review blijft bij ChatGPT; die wordt **niet** door een lokaal model vervangen.
- Beperkingen: een 4B-model is aanzienlijk zwakker dan ChatGPT of Claude. Op CPU kan een antwoord minuten duren. Een Docker-container bereikt Ollama op de host alleen via `host.docker.internal` (zie README).
- Kosten: geen (lokale stroom/hardware).

## Methode D – Officiële API's (optionele uitbreiding)

- Een ChatGPT Plus/Pro-abonnement levert **geen** API-sleutel op; de OpenAI API wordt apart per token afgerekend. Hetzelfde geldt voor Anthropic: een Claude Pro/Max-abonnement geeft geen API-toegang, de API (console.anthropic.com) wordt apart afgerekend.
- De applicatie bevat adapters voor beide API's achter dezelfde provider-interface als de handmatige route. Ze staan **standaard uit**, sleutels komen uitsluitend uit omgevingsvariabelen (nooit uit de database of frontend), en alleen met API's is een volledig automatische workflow mogelijk.
- Status: **NIET GETEST**, want er waren geen API-sleutels beschikbaar.

## Testen van resultaten (lokaal, zonder AI)

- Statische controles in de applicatie zelf: JSON, YAML, Docker Compose-structuur, HTML-structuur en element-ID's, Dockerfile.
- Daadwerkelijke uitvoering in een **aparte sandbox-container** zonder netwerk (`network_mode: none`), read-only, met CPU/geheugen/proceslimieten en een onbevoegde gebruiker: `node --check`, `node --test`, `python -m py_compile`, `pytest`, `bash -n`.
- Niet beschikbaar (en dus altijd **NIET GETEST**): functionele browsertests, `docker compose config`/containers starten (bewust geen Docker-socket in de app: dat zou root-toegang tot de host geven), TypeScript-compilatie, STEP-geometrieberekening.

## Gekozen architectuur

Handmatige overdracht als volwaardige hoofdroute, met een provider-laag waarin `handmatig`, `ollama`, `openai-api` en `anthropic-api` uitwisselbaar zijn. Zie [ARCHITECTUUR.md](ARCHITECTUUR.md).
