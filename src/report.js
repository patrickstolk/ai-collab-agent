// Eindrapport per opdracht, altijd opgebouwd uit de opgeslagen gegevens (nooit uit aannames).
import { jobs, events, checks as checksRepo, issues as issuesRepo, files as filesRepo } from './db.js';
import { computeFinalStatus } from './status.js';
import { STATES } from './workflow.js';
import { WORKFLOW_TYPES } from './prompts.js';

function dur(ms) {
  if (ms == null) return 'onbekend';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} u ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

export function buildReport(jobId) {
  const job = jobs.get(jobId);
  const evs = events.forJob(jobId);
  const allChecks = checksRepo.forJob(jobId);
  const lastChecks = allChecks.filter((c) => c.cycle === job.cycle);
  const answers = evs.filter((e) => e.kind.startsWith('antwoord_'));
  const methods = [...new Set(answers.map((a) => a.method || 'handmatig'))];
  const models = [...new Set(answers.map((a) => `${a.actor}: ${a.model || 'model onbekend (handmatig via webinterface)'}`))];
  const final = job.final_status ? { status: job.final_status, reasons: (evs.filter((e) => e.kind === 'eindbeoordeling').pop()?.content || '').split('\n') } : computeFinalStatus(job);
  const claudePrompts = evs.filter((e) => e.kind === 'prompt' && e.meta?.target === 'claude');
  const reviews = evs.filter((e) => e.kind === 'review_oordeel');
  const improvements = evs.filter((e) => e.kind === 'verbeterpunten');
  const latestFiles = filesRepo.latestGenerated(jobId);
  const uploads = filesRepo.uploads(jobId);
  const end = job.finished_at ? Date.parse(job.finished_at) : Date.now();
  return {
    job,
    stateLabel: STATES[job.state] || job.state,
    workflowLabel: WORKFLOW_TYPES[job.workflow_type] || job.workflow_type,
    automation: methods.every((m) => m === 'api') && answers.length ? 'Volledig via API (automatisch)'
      : methods.includes('api') || methods.includes('lokaal model') ? 'Gemengd: deels handmatige overdracht, deels API/lokaal model'
        : 'Handmatige overdracht via de webinterfaces van ChatGPT en Claude',
    methods, models,
    duration: dur(end - Date.parse(job.created_at)),
    cost: job.cost_eur != null ? `€ ${job.cost_eur.toFixed(4)} (API, berekend uit tokengebruik en ingestelde prijzen)` : (methods.includes('api') ? 'Onbekend (geen prijzen ingesteld)' : 'Geen meetbare extra kosten (webabonnement/lokaal); gebruikslimieten van het abonnement zijn niet gemeten.'),
    final,
    claudePrompts,
    firstClaudePrompt: claudePrompts[0] || null,
    lastClaudeAnswer: answers.filter((a) => a.kind === 'antwoord_claude').pop() || null,
    reviews,
    improvements,
    executed: lastChecks.filter((c) => c.category === 'UITGEVOERDE_TEST'),
    statics: lastChecks.filter((c) => c.category === 'STATISCH'),
    notRun: lastChecks.filter((c) => c.category === 'NIET_UITGEVOERD'),
    aiReviews: allChecks.filter((c) => c.category === 'AI_BEOORDELING'),
    openIssues: job.final_status === 'GESLAAGD' ? [] : issuesRepo.forCycle(jobId, job.cycle),
    warnings: evs.filter((e) => e.kind === 'waarschuwing' || e.kind === 'fout'),
    latestFiles, uploads,
  };
}

export function reportMarkdown(r) {
  const j = r.job;
  const L = [];
  const checkLine = (c) => `- [${c.status}] ${c.name}${c.target ? ` — \`${c.target}\`` : ''}`;
  L.push(`# Eindrapport opdracht #${j.id}: ${j.title}`, '');
  L.push(`- Toestand: ${r.stateLabel}`, `- **Eindstatus: ${r.final.status}**`, `- Uitvoeringswijze: ${r.automation}`,
    `- Soort: ${r.workflowLabel}; workflow: ${j.variant === 'direct' ? 'direct naar Claude' : 'volledig (analyse, uitvoering, review)'}`,
    `- Verbetercycli: ${j.cycle} van max. ${j.max_cycles}; AI-verzoeken: ${j.request_count} van max. ${j.max_requests}`,
    `- Doorlooptijd: ${r.duration}`, `- Kosten: ${r.cost}`, `- Gebruikte modellen: ${r.models.join('; ') || 'nog geen'}`, '');
  L.push('## Oorspronkelijke opdracht', '', j.assignment, '');
  L.push('## Uitvoeringsprompt (eerste versie, exact zoals aan Claude aangeboden)', '', '````', r.firstClaudePrompt?.content || '(nog niet gemaakt)', '````', '');
  L.push('## Resultaat van Claude (laatste versie)', '', r.lastClaudeAnswer ? `Ontvangen ${r.lastClaudeAnswer.created_at} via ${r.lastClaudeAnswer.method || 'handmatige overdracht'}. Volledige tekst staat in de opdrachtgeschiedenis.` : '(geen resultaat ontvangen)', '');
  L.push('## Controle door ChatGPT (AI-beoordeling, geen test)', '');
  if (!r.reviews.length) L.push('Geen review uitgevoerd.');
  for (const rv of r.reviews) L.push(`- Ronde ${rv.cycle + 1}: **${rv.meta?.verdict}** door ${rv.meta?.reviewer || 'ChatGPT'}${rv.meta?.manual ? ' (handmatig)' : ''} — ${rv.content || ''}`);
  L.push('');
  L.push('## Tests (laatste ronde)', '');
  L.push('### Daadwerkelijk uitgevoerde tests', ...(r.executed.length ? r.executed.map(checkLine) : ['Geen.']), '');
  L.push('### Statische controles (code niet uitgevoerd)', ...(r.statics.length ? r.statics.map(checkLine) : ['Geen.']), '');
  L.push('### Niet uitgevoerd (NIET GETEST)', ...(r.notRun.length ? r.notRun.map((c) => `${checkLine(c)}: ${(c.output || '').split('\n')[0]}`) : ['Geen.']), '');
  L.push('## Verbeteringen', '');
  if (!r.improvements.length) L.push('Geen verbetercycli uitgevoerd.');
  for (const im of r.improvements) L.push(`### ${im.title}`, im.content || '', '');
  L.push('', '## Eindstatus', '', `**${r.final.status}**`, '', ...r.final.reasons.filter(Boolean).map((x) => `- ${x}`), '');
  L.push('## Openstaande punten', '', ...(r.openIssues.length ? r.openIssues.map((i) => `- [${i.severity}] ${i.description}`) : ['Geen geregistreerde openstaande punten.']), '');
  if (r.warnings.length) L.push('## Waarschuwingen en fouten', '', ...r.warnings.map((w) => `- ${w.created_at}: ${w.title}: ${(w.content || '').split('\n')[0]}`), '');
  L.push('## Bestanden', '', '### Invoer', ...(r.uploads.length ? r.uploads.map((f) => `- \`${f.path}\` — ${f.read_status}${f.read_note ? `: ${f.read_note}` : ''}`) : ['Geen.']), '');
  L.push('### Resultaat (laatste versies)', ...(r.latestFiles.length ? r.latestFiles.map((f) => `- \`${f.path}\` (versie ${f.version}, ${f.size} bytes, sha256 ${f.sha256.slice(0, 12)}…)`) : ['Geen.']), '');
  L.push('## Kosten', '', r.cost, '');
  return L.join('\n');
}
