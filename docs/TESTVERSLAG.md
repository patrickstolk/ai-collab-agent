# Testverslag (fase 4)

Datum: 29 oktober 2026. Omgeving: Windows 11, Node.js 24.15.0, Ollama 0.40.11 met `qwen3.5:4b`.
**Docker, Python en pytest waren op deze ontwikkelmachine niet beschikbaar.**

## Daadwerkelijk uitgevoerd

### Automatische tests: `npm test` → 34 van 34 geslaagd

| Controle uit de opdracht | Test | Resultaat |
|---|---|---|
| 1. Opdracht wordt opgeslagen | `1-2. opdracht met upload…` (incl. weigeren van `.exe`) | GESLAAGD |
| 2. Uitvoeringsprompt wordt gegenereerd | `3. ChatGPT-analyse importeren…` | GESLAAGD |
| 3. Prompt kan naar Claude worden overgedragen | exacte prompt met uitvoerformaat + bestanden | GESLAAGD |
| 4. Resultaat wordt opgeslagen | `4-5. Claude-resultaat…` (3 bestanden, versie 1) | GESLAAGD |
| 5. ChatGPT kan het resultaat controleren | reviewprompt bevat feitelijke testresultaten | GESLAAGD |
| 6. Feedback wordt verwerkt | `6. afgekeurde review leidt tot verbeterprompt` | GESLAAGD |
| 7. Nieuwe versie wordt beoordeeld | `7. verbeterde versie…` → eindstatus GESLAAGD | GESLAAGD |
| 8. Eindrapport correct | `8. eindrapport scheidt AI-beoordeling van uitgevoerde tests…` | GESLAAGD |
| Foutafhandeling | dubbel versturen (409), onleesbare review → beslissing, max. cycli, max. AI-verzoeken, CSRF, verkeerd wachtwoord | GESLAAGD |
| Hervatten van onderbroken opdrachten | `onderbroken verwerking wordt na herstart hersteld` (database gesloten/heropend) | GESLAAGD |
| Eerlijke status | AI-goedkeuring zonder test → HANDMATIGE CONTROLE VEREIST | GESLAAGD |

De workflowtest gebruikt de **echte sandbox-worker** (als apart proces): `node --test` werd daadwerkelijk
uitgevoerd op de gegenereerde `logic.test.mjs`, en `node --check` op het inline script in `index.html`.
De statische HTML-controle vond de ingebouwde fout (script verwijst naar `#resultaat`, element heet `uitvoer`).

> De ChatGPT- en Claude-antwoorden in de tests zijn **vaste testgegevens**. Ze testen de verwerking door
> de applicatie, niet de AI-modellen zelf.

### Handmatig in de browser (lokale ontwikkelserver)
- Inloggen, dashboard, nieuwe opdracht via het formulier, opdrachtdetail, instellingen, integraties: geen consolefouten (CSP actief).
- Sessie bleef geldig na een herstart van de server.
- Knop *Prompt kopiëren*: in het ingebouwde browservenster blokkeerde de browser het klembord. De terugvaloptie werkte ("Geselecteerd: druk Ctrl+C").
- **Ollama, echt uitgevoerd**: voor de voorbeeldopdracht maakte `qwen3.5:4b` in 92 s een analyse, criteria en
  uitvoeringsprompt met de juiste markeringen. De applicatie verwerkte die en zette de opdracht op "Wacht op uitvoering door Claude".
  In de geschiedenis staat het antwoord gemarkeerd als *Lokale AI (Ollama)*.
- De integratiepagina meldde de lokale sandbox terecht als "niet volledig geïsoleerd" (netwerk bereikbaar, geen aparte gebruiker),
  omdat die buiten Docker draaide. Daarvoor is een aanpassing gemaakt: de prompt en de statuspagina claimen alleen isolatie die de worker zelf heeft vastgesteld.

## NIET GETEST (en waarom)

| Onderdeel | Reden |
|---|---|
| `docker compose up` / Dockerfiles / volumes / healthchecks | Docker is niet geïnstalleerd op de ontwikkelmachine. Voer de rooktest uit de README uit op uw server. |
| Isolatie van de sandbox-container (geen netwerk, uid 10001, capabilities) | Alleen in Docker te controleren; de worker meldt het resultaat zelf op de integratiepagina. |
| `pytest` en `py_compile` in de sandbox | Python ontbreekt op de ontwikkelmachine; zit wel in de sandbox-image. |
| Werkelijke ChatGPT- en Claude-webinterfaces | Vereist uw eigen accounts en handmatige stappen; niet door mij uitgevoerd. |
| OpenAI- en Anthropic-API-adapters | Geen API-sleutels beschikbaar. |
| Klembord-API in een gewone browser | Alleen de terugvaloptie is in het ingebouwde venster gezien. |
| Extractie van echte PDF-, DOCX- en XLSX-bestanden | Unit-tests dekken ZIP, STEP en een kapotte PDF; echte Office/PDF-documenten zijn niet getest. |

## Aanbevolen eerste controle op uw server
1. `docker compose up -d --build` → `docker compose ps` toont beide services als *healthy*.
2. Integraties → *Sandbox voor tests* staat op "Beschikbaar en werkend", isolatie "geen netwerktoegang (gecontroleerd); tests draaien als uid 10001".
3. Voer de voorbeeldopdracht uit met uw ChatGPT- en Claude-account.
