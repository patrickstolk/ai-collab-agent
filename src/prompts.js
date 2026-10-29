// Prompt-sjablonen. Iedere prompt is zelfstandig leesbaar, zodat hij in een nieuw
// gesprek in ChatGPT of Claude kan worden geplakt zonder voorafgaande context.

export const WORKFLOW_TYPES = {
  software: 'Softwareontwikkeling / configuratie',
  document: 'Document- of contractanalyse',
  technisch: 'Technische analyse (constructie, CAD, berekening)',
  algemeen: 'Algemeen',
};

export const MARK = {
  analysis: ['===ANALYSE===', '===EINDE ANALYSE==='],
  criteria: ['===ACCEPTATIECRITERIA===', '===EINDE ACCEPTATIECRITERIA==='],
  claudePrompt: ['===PROMPT VOOR CLAUDE===', '===EINDE PROMPT VOOR CLAUDE==='],
  clarify: ['===VERDUIDELIJKING NODIG===', '===EINDE VERDUIDELIJKING==='],
  review: ['===REVIEW JSON===', '===EINDE REVIEW JSON==='],
};

function filesSection(uploads, budget) {
  if (!uploads.length) return 'Er zijn geen bestanden bijgevoegd.';
  let remaining = budget;
  const parts = [];
  for (const u of uploads) {
    let head = `--- Bestand: ${u.path} (${u.size} bytes) — leesstatus: ${u.read_status}${u.read_note ? ` (${u.read_note})` : ''}`;
    if (!u.text) {
      parts.push(`${head}\n[De inhoud van dit bestand kon niet worden gelezen en is NIET meegestuurd.]`);
      continue;
    }
    let text = u.text;
    if (text.length > remaining) {
      text = text.slice(0, Math.max(0, remaining));
      head += ` — INHOUD AFGEKAPT na ${text.length} tekens (limiet bereikt)`;
    }
    remaining -= text.length;
    parts.push(`${head}\n${text}\n--- Einde bestand: ${u.path}`);
  }
  return parts.join('\n\n');
}

export function analysisPrompt({ job, uploads, capabilities, clarifications, budget }) {
  return `Je bent de analist in een samenwerking tussen twee AI-modellen. Jij (ChatGPT) analyseert een opdracht en schrijft een complete, zelfstandig uitvoerbare prompt voor een ander model (Claude) dat de opdracht uitvoert. Daarna beoordeel jij later het resultaat.

# Opdracht van de gebruiker
${job.assignment}

# Soort opdracht
${WORKFLOW_TYPES[job.workflow_type] || job.workflow_type}

${job.acceptance_criteria ? `# Acceptatiecriteria opgegeven door de gebruiker\n${job.acceptance_criteria}\n` : ''}${clarifications ? `# Antwoorden van de gebruiker op eerdere verduidelijkingsvragen\n${clarifications}\n` : ''}
# Beschikbare bestanden
${filesSection(uploads, budget)}

# Beschikbare testomgeving (feitelijk, niet uitbreiden)
${capabilities}

# Wat je moet doen
1. Analyseer de opdracht: doel, aannames, risico's en ontbrekende informatie.
2. Bepaal toetsbare acceptatiecriteria.
3. Schrijf een prompt voor Claude die zonder verdere context uitvoerbaar is. Neem waar relevant op: doelstelling, functionele eisen, technische randvoorwaarden, beschikbare bestanden, acceptatiecriteria, gewenste uitvoer, testprocedure, beveiligingseisen, verboden aannames en gewenste rapportage.
4. Verzin geen feiten over bestanden, systemen of omgevingen die hierboven niet staan. Vermeld onzekerheden expliciet.

Als essentiële informatie ontbreekt waardoor geen zinvolle prompt mogelijk is, antwoord dan UITSLUITEND met:
${MARK.clarify[0]}
1. <vraag>
2. <vraag>
${MARK.clarify[1]}

Antwoord anders in exact dit formaat (de markeringen worden automatisch verwerkt, laat ze ongewijzigd):
${MARK.analysis[0]}
<je analyse>
${MARK.analysis[1]}
${MARK.criteria[0]}
- <criterium 1>
- <criterium 2>
${MARK.criteria[1]}
${MARK.claudePrompt[0]}
<de volledige prompt voor Claude>
${MARK.claudePrompt[1]}
`;
}

// Vaste aanvulling die de applicatie zelf aan iedere Claude-prompt toevoegt, zodat de
// uitvoer betrouwbaar kan worden verwerkt, ongeacht wat ChatGPT schreef.
export function claudeAppendix({ uploads, budget, capabilities }) {
  return `

----------------------------------------------------------------
# Invoerbestanden (toegevoegd door de AI Collaboration Agent)
${filesSection(uploads, budget)}

# Testomgeving van de opdrachtgever
${capabilities}

# Verplicht uitvoerformaat
Lever ieder bestand volledig (geen weglatingen als "rest ongewijzigd") in deze vorm:

### BESTAND: relatief/pad/naam.ext
\`\`\`taal
volledige inhoud
\`\`\`

Gebruik voor bestanden die zelf \`\`\` bevatten een buitenste omheining van vier backticks (\`\`\`\`).
Sluit af met deze secties:
### TESTEN
Welke tests je hebt meegeleverd en hoe ze uit te voeren zijn.
### BEPERKINGEN
Wat niet is geïmplementeerd, aannames en bekende risico's.

Belangrijk: beweer niet dat iets getest of werkend is als je het niet daadwerkelijk hebt uitgevoerd. De opdrachtgever voert zelf tests uit en een AI-beoordeling geldt niet als test.
`;
}

function filesForReview(files) {
  if (!files.length) return '[Claude heeft geen herkenbare bestanden opgeleverd.]';
  return files.map((f) => `### BESTAND: ${f.path} (versie ${f.version})\n\`\`\`\`\n${f.text ?? '[inhoud niet leesbaar]'}\n\`\`\`\``).join('\n\n');
}

export function formatChecks(checkRows) {
  if (!checkRows.length) return 'Er zijn geen controles uitgevoerd.';
  const label = {
    STATISCH: 'Statische controle (code niet uitgevoerd)',
    UITGEVOERDE_TEST: 'DAADWERKELIJK UITGEVOERDE TEST',
    NIET_UITGEVOERD: 'Niet uitgevoerd',
    AI_BEOORDELING: 'AI-beoordeling (geen test)',
  };
  return checkRows.map((c) => {
    const out = c.output ? `\n    Uitvoer:\n${c.output.split('\n').slice(0, 40).map((l) => '      ' + l).join('\n')}` : '';
    return `- [${c.status}] ${c.name}${c.target ? ` — ${c.target}` : ''}\n    Soort: ${label[c.category] || c.category}${out}`;
  }).join('\n');
}

export function reviewPrompt({ job, criteria, claudePrompt, claudeAnswer, files, checkRows, cycle, previousIssues }) {
  return `Je bent een onafhankelijke, kritische beoordelaar. Een ander AI-model (Claude) heeft een opdracht uitgevoerd. Beoordeel of het resultaat daadwerkelijk aan de oorspronkelijke opdracht voldoet.

Regels:
- Claims van Claude dat iets "werkt" of "getest is" zijn NIET geverifieerd, tenzij hieronder een DAADWERKELIJK UITGEVOERDE TEST met uitvoer staat.
- Een statische controle bewijst alleen syntaxis/structuur, geen werking.
- Wat niet getest kon worden, markeer je als ONBEKEND, niet als VOLDAAN.

# Oorspronkelijke opdracht
${job.assignment}

# Acceptatiecriteria
${criteria || '(geen expliciete criteria vastgelegd; leid ze af uit de opdracht en vermeld dat)'}

# Verbetercyclus
Dit is ronde ${cycle + 1} (ronde 1 = eerste uitvoering).
${previousIssues ? `\n# Problemen uit de vorige review\n${previousIssues}\n` : ''}
# Uitvoeringsprompt die Claude ontving
<<<PROMPT
${claudePrompt}
PROMPT>>>

# Volledig antwoord van Claude
<<<ANTWOORD
${claudeAnswer}
ANTWOORD>>>

# Herkende bestanden (zoals opgeslagen door de applicatie)
${filesForReview(files)}

# Resultaten van controles door de applicatie (feitelijk)
${formatChecks(checkRows)}

# Beoordeel
Functionele volledigheid, technische correctheid, mogelijke fouten, beveiligingsrisico's, ontbrekende onderdelen, onjuiste aannames, kwaliteit van documentatie en de resultaten van daadwerkelijk uitgevoerde tests.

Schrijf eerst je beoordeling in gewone tekst. Sluit af met exact dit blok (geldige JSON, markeringen ongewijzigd laten):
${MARK.review[0]}
{
  "oordeel": "GOEDGEKEURD of AFGEKEURD",
  "samenvatting": "één of twee zinnen",
  "criteria": [{"criterium": "...", "status": "VOLDAAN | NIET VOLDAAN | ONBEKEND", "toelichting": "..."}],
  "problemen": [{"ernst": "kritiek | hoog | middel | laag", "beschrijving": "...", "suggestie": "..."}]
}
${MARK.review[1]}
Gebruik "GOEDGEKEURD" alleen als er geen problemen met ernst kritiek of hoog meer zijn.`;
}

export function improvementPrompt({ job, originalClaudePrompt, files, issueRows, checkRows, cycle, maxCycles, reviewText }) {
  const issueList = issueRows.length
    ? issueRows.map((i, n) => `${n + 1}. [${i.severity}] ${i.description}${i.suggestion ? `\n   Suggestie: ${i.suggestion}` : ''}`).join('\n')
    : '(geen gestructureerde lijst beschikbaar; zie de review hieronder)';
  const failed = checkRows.filter((c) => c.status !== 'GESLAAGD');
  return `Je hebt eerder een opdracht uitgevoerd. Een onafhankelijke review en de tests van de opdrachtgever hebben tekortkomingen gevonden. Lever een verbeterde, volledige versie.

Dit is verbeterronde ${cycle} van maximaal ${maxCycles}.

# Oorspronkelijke opdracht
${job.assignment}

# Oorspronkelijke uitvoeringsprompt (ter referentie)
<<<PROMPT
${originalClaudePrompt}
PROMPT>>>

# Op te lossen problemen
${issueList}

# Controles die niet geslaagd zijn of niet uitgevoerd konden worden
${failed.length ? formatChecks(failed) : 'Geen.'}

${reviewText ? `# Volledige review\n<<<REVIEW\n${reviewText}\nREVIEW>>>\n` : ''}
# Huidige versie van de bestanden
${filesForReview(files)}

# Opdracht
Los alle bovenstaande problemen op. Lever ALLE bestanden opnieuw volledig aan (ook ongewijzigde), in het verplichte formaat:

### BESTAND: relatief/pad/naam.ext
\`\`\`taal
volledige inhoud
\`\`\`

Sluit af met:
### WIJZIGINGEN
Per probleem (nummer) wat je hebt aangepast, of waarom het niet is opgelost.
### TESTEN
### BEPERKINGEN

Beweer niet dat iets getest of werkend is als je het niet daadwerkelijk hebt uitgevoerd.`;
}
