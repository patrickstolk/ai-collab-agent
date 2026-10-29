// Workflow (toestandsmachine) van een opdracht. Iedere wachtende stap heeft een uniek
// stap-token; een stap wordt alleen verwerkt als toestand én token overeenkomen.
// Daardoor wordt dezelfde stap nooit twee keer uitgevoerd (dubbelklik, terugknop, twee tabbladen).
import crypto from 'node:crypto';
import { jobs, events, files as filesRepo, checks as checksRepo, issues as issuesRepo, sandboxRuns, tx } from './db.js';
import { getSettings } from './settings.js';
import { analysisPrompt, claudeAppendix, reviewPrompt, improvementPrompt } from './prompts.js';
import { parseAnalysis, parseFiles, parseReview } from './parse.js';
import { storeGenerated, withText } from './files.js';
import { runChecks, capabilitiesText, collectSandboxResults, STATUS } from './checks.js';
import { computeFinalStatus } from './status.js';
import { callOllama, callApi, ROLE } from './providers.js';
import { config } from './config.js';
import { log } from './log.js';

export const STATES = {
  WACHT_ANALYSE: 'Wacht op analyse door ChatGPT',
  WACHT_VERDUIDELIJKING: 'Wacht op verduidelijking door gebruiker',
  WACHT_CLAUDE: 'Wacht op uitvoering door Claude',
  TESTS_BEZIG: 'Tests worden uitgevoerd',
  WACHT_REVIEW: 'Wacht op review door ChatGPT',
  WACHT_BESLISSING: 'Wacht op beslissing gebruiker',
  BEZIG: 'AI-verzoek wordt uitgevoerd',
  VERWERKEN: 'Bezig met verwerken',
  AFGEROND: 'Afgerond',
  GESTOPT: 'Gestopt door gebruiker',
};

export const WAITING_FOR_USER = ['WACHT_ANALYSE', 'WACHT_VERDUIDELIJKING', 'WACHT_CLAUDE', 'WACHT_REVIEW', 'WACHT_BESLISSING'];
export const FINAL_STATES = ['AFGEROND', 'GESTOPT'];

// Welk AI-model per wachtende toestand aan de beurt is.
export const STEP_TARGET = { WACHT_ANALYSE: 'chatgpt', WACHT_CLAUDE: 'claude', WACHT_REVIEW: 'chatgpt' };

export class StepError extends Error {}

const token = () => crypto.randomBytes(16).toString('hex');

function ev(job, kind, actor, extra = {}) {
  return events.add({ job_id: job.id, cycle: job.cycle, kind, actor, ...extra });
}

function warn(job, text) {
  ev(job, 'waarschuwing', 'APP', { title: 'Waarschuwing', content: text });
}

// Claimt een stap atomisch: alleen één verzoek kan de stap van `state` naar VERWERKEN zetten.
function claim(jobId, state, tok) {
  const job = jobs.get(jobId);
  if (!job) throw new StepError('Opdracht niet gevonden.');
  if (job.state !== state || job.pending_token !== tok) {
    throw new StepError('Deze stap is al verwerkt of de opdracht is intussen gewijzigd. De pagina is bijgewerkt; controleer de huidige stap.');
  }
  if (!jobs.transition(jobId, state, tok, { state: 'VERWERKEN', prev_state: state, pending_token: token() })) {
    throw new StepError('Deze stap wordt al verwerkt.');
  }
  return jobs.get(jobId);
}

function setState(job, state, extra = {}) {
  jobs.update(job.id, { state, pending_token: token(), ...extra });
  return jobs.get(job.id);
}

// Voert `fn` uit op een geclaimde opdracht; bij een fout wordt de oude toestand hersteld.
function withClaim(jobId, state, tok, fn) {
  const job = claim(jobId, state, tok);
  try {
    return fn(job);
  } catch (e) {
    ev(job, 'fout', 'APP', { title: 'Fout bij verwerken', content: e.message });
    setState(job, state);
    throw e;
  }
}

async function withClaimAsync(jobId, state, tok, fn) {
  const job = claim(jobId, state, tok);
  try {
    return await fn(job);
  } catch (e) {
    ev(job, 'fout', 'APP', { title: 'Fout bij verwerken', content: e.message });
    setState(jobs.get(jobId), state);
    throw e;
  }
}

function uploadsWithText(jobId) {
  return withText(filesRepo.uploads(jobId));
}

function promptWarnings(job, text) {
  const s = getSettings();
  if (text.length > s.prompt_warn_chars) {
    warn(job, `De prompt is ${text.length.toLocaleString('nl-NL')} tekens lang. Webinterfaces hebben een maximale invoerlengte en gebruikslimieten; mogelijk wordt de prompt geweigerd of afgekapt. Overweeg bestanden te verkleinen.`);
  }
}

function requestBudgetLeft(job) {
  if (job.request_count >= job.max_requests) {
    warn(job, `Het maximum van ${job.max_requests} AI-verzoeken voor deze opdracht is bereikt. Er worden geen nieuwe prompts meer gemaakt.`);
    return false;
  }
  return true;
}

function addPrompt(job, target, purpose, content, meta = {}) {
  promptWarnings(job, content);
  return ev(job, 'prompt', 'APP', { title: `Prompt voor ${ROLE[target]} (${purpose})`, content, meta: { target, purpose, ...meta } });
}

export function currentPrompt(job) {
  const p = events.latest(job.id, 'prompt');
  return p;
}

// ---------------------------------------------------------------- aanmaken
export function createJob(input) {
  const s = getSettings();
  const job = {
    title: input.title,
    assignment: input.assignment,
    acceptance_criteria: input.acceptance_criteria || '',
    workflow_type: input.workflow_type,
    variant: input.variant,
    handoff_mode: input.handoff_mode,
    state: 'VERWERKEN',
    max_cycles: input.max_cycles ?? s.max_cycles,
    max_requests: input.max_requests ?? s.max_requests,
    cost_budget: s.cost_budget_eur,
    pending_token: token(),
    clone_of: input.clone_of ?? null,
  };
  const id = jobs.create(job);
  const j = jobs.get(id);
  ev(j, 'opdracht', 'GEBRUIKER', {
    title: 'Oorspronkelijke opdracht', content: input.assignment,
    meta: { workflow_type: input.workflow_type, variant: input.variant, handoff_mode: input.handoff_mode, criteria: input.acceptance_criteria || '' },
  });
  return id;
}

// Wordt aangeroepen nadat uploads zijn opgeslagen.
export function startJob(jobId) {
  const job = jobs.get(jobId);
  if (job.variant === 'direct') {
    const base = `${job.assignment}${job.acceptance_criteria ? `\n\n# Acceptatiecriteria\n${job.acceptance_criteria}` : ''}`;
    ev(job, 'notitie', 'APP', { title: 'Analyse door ChatGPT overgeslagen', content: 'Gekozen workflow "Direct naar Claude": de opdracht zelf wordt als uitvoeringsprompt gebruikt.' });
    return prepareClaudePrompt(job, base, job.acceptance_criteria);
  }
  return prepareAnalysis(job, null);
}

function prepareAnalysis(job, clarifications) {
  if (!requestBudgetLeft(job)) return finalize(job, 'Maximum aantal AI-verzoeken bereikt.');
  const text = analysisPrompt({ job, uploads: uploadsWithText(job.id), capabilities: capabilitiesText(), clarifications, budget: config.maxExtractPerPrompt });
  addPrompt(job, 'chatgpt', 'analyse', text);
  const j = setState(job, 'WACHT_ANALYSE');
  scheduleAuto(j);
  return j;
}

function prepareClaudePrompt(job, basePrompt, criteria) {
  if (!requestBudgetLeft(job)) return finalize(job, 'Maximum aantal AI-verzoeken bereikt.');
  const full = basePrompt + claudeAppendix({ uploads: uploadsWithText(job.id), budget: config.maxExtractPerPrompt, capabilities: capabilitiesText() });
  addPrompt(job, 'claude', 'uitvoering', full, { base: basePrompt });
  if (criteria != null) jobs.update(job.id, { acceptance_criteria: criteria });
  const j = setState(jobs.get(job.id), 'WACHT_CLAUDE');
  scheduleAuto(j);
  return j;
}

function recordAnswer(job, from, purpose, text, source) {
  const prompt = currentPrompt(job);
  const waitMs = prompt ? Date.now() - Date.parse(prompt.created_at) : null;
  ev(job, `antwoord_${from}`, from === 'chatgpt' ? 'CHATGPT' : from === 'claude' ? 'CLAUDE' : 'OLLAMA', {
    title: `Antwoord van ${source.actorLabel || ROLE[from]} (${purpose})`, content: text,
    method: source.method, model: source.model,
    meta: { purpose, wait_ms: waitMs, duration_ms: source.durationMs ?? null, cost_eur: source.costEur ?? null, prompt_event: prompt?.id },
  });
  const fields = { request_count: job.request_count + 1 };
  if (source.costEur != null) fields.cost_eur = (job.cost_eur || 0) + source.costEur;
  jobs.update(job.id, fields);
  if (source.truncated) warn(job, 'Het antwoord is afgekapt door de maximale uitvoerlengte van het model.');
  return jobs.get(job.id);
}

// ---------------------------------------------------------------- analyse
export function importAnalysis(jobId, tok, text, source) {
  return withClaim(jobId, 'WACHT_ANALYSE', tok, (job) => processAnalysis(job, text, source));
}

function processAnalysis(job, text, source) {
  if (!text.trim()) throw new StepError('Het antwoord is leeg.');
  job = recordAnswer(job, source.actor || 'chatgpt', 'analyse', text, source);
  const r = parseAnalysis(text);
  r.warnings.forEach((w) => warn(job, w));
  if (r.type === 'verduidelijking') {
    ev(job, 'verduidelijking_vragen', source.actor === 'ollama' ? 'OLLAMA' : 'CHATGPT', { title: 'Verduidelijkingsvragen', content: r.questions.join('\n') });
    return setState(job, 'WACHT_VERDUIDELIJKING');
  }
  if (r.analysis) ev(job, 'analyse', source.actor === 'ollama' ? 'OLLAMA' : 'CHATGPT', { title: 'Analyse', content: r.analysis });
  const criteria = [job.acceptance_criteria, r.criteria].filter(Boolean).join('\n');
  if (r.criteria) ev(job, 'criteria', source.actor === 'ollama' ? 'OLLAMA' : 'CHATGPT', { title: 'Acceptatiecriteria', content: r.criteria });
  ev(job, 'gegenereerde_prompt', source.actor === 'ollama' ? 'OLLAMA' : 'CHATGPT', { title: 'Gegenereerde uitvoeringsprompt', content: r.prompt, method: source.method, model: source.model });
  return prepareClaudePrompt(job, r.prompt, criteria);
}

export function answerClarification(jobId, tok, answers) {
  return withClaim(jobId, 'WACHT_VERDUIDELIJKING', tok, (job) => {
    if (!answers.trim()) throw new StepError('Vul de antwoorden in.');
    const q = events.latest(job.id, 'verduidelijking_vragen');
    const combined = `Vragen:\n${q?.content || ''}\n\nAntwoorden van de gebruiker:\n${answers}`;
    ev(job, 'verduidelijking_antwoord', 'GEBRUIKER', { title: 'Antwoorden op verduidelijkingsvragen', content: answers });
    const all = events.forJob(job.id).filter((e) => e.kind === 'verduidelijking_antwoord').length > 1
      ? events.forJob(job.id).filter((e) => e.kind === 'verduidelijking_antwoord').map((e) => e.content).join('\n\n')
      : combined;
    return prepareAnalysis(job, all);
  });
}

// Gebruiker past de prompt voor Claude aan vóór het versturen.
export function editClaudePrompt(jobId, tok, newBase) {
  return withClaim(jobId, 'WACHT_CLAUDE', tok, (job) => {
    if (!newBase.trim()) throw new StepError('De prompt mag niet leeg zijn.');
    ev(job, 'notitie', 'GEBRUIKER', { title: 'Uitvoeringsprompt handmatig aangepast', content: newBase });
    const full = newBase + claudeAppendix({ uploads: uploadsWithText(job.id), budget: config.maxExtractPerPrompt, capabilities: capabilitiesText() });
    const prev = currentPrompt(job);
    addPrompt(job, 'claude', prev?.meta?.purpose || 'uitvoering', full, { base: newBase, edited: true });
    return setState(job, 'WACHT_CLAUDE');
  });
}

// ---------------------------------------------------------------- Claude
export function importClaude(jobId, tok, text, source) {
  return withClaim(jobId, 'WACHT_CLAUDE', tok, (job) => processClaude(job, text, source));
}

function processClaude(job, text, source) {
  if (!text.trim()) throw new StepError('Het antwoord is leeg.');
  // Opslaan gebeurt asynchroon (extractie); hier synchroon via een promise-keten.
  job = recordAnswer(job, 'claude', job.cycle === 0 ? 'uitvoering' : 'verbetering', text, source);
  const { files, warnings } = parseFiles(text);
  warnings.forEach((w) => warn(job, w));
  ev(job, 'bestanden_herkend', 'APP', { title: `${files.length} bestand(en) herkend`, content: files.map((f) => f.path).join('\n') || '(geen)' });
  // Opslaan is async; we zetten de toestand op TESTS_BEZIG en vervolgen in de achtergrond.
  setState(job, 'TESTS_BEZIG');
  storeAndTest(job.id, job.cycle, files).catch((e) => {
    const j = jobs.get(job.id);
    ev(j, 'fout', 'APP', { title: 'Fout bij opslaan of testen', content: e.message });
    setState(j, 'WACHT_BESLISSING');
  });
  return jobs.get(job.id);
}

async function storeAndTest(jobId, cycle, files) {
  for (const f of files) await storeGenerated(jobId, cycle, f.path, f.content);
  const rows = filesRepo.inCycle(jobId, cycle);
  const r = runChecks(jobId, cycle, rows);
  if (!r.queued) afterTests(jobId);
}

// Wordt aangeroepen wanneer alle tests (ook sandbox) klaar zijn.
export function afterTests(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'TESTS_BEZIG') return;
  const rows = checksRepo.forCycle(jobId, job.cycle);
  ev(job, 'testresultaten', 'APP', {
    title: `Controles ronde ${job.cycle + 1}`,
    content: rows.map((c) => `[${c.status}] ${c.name}${c.target ? ' — ' + c.target : ''} (${c.category})`).join('\n') || '(geen controles van toepassing)',
  });
  prepareReview(job);
}

function prepareReview(job) {
  if (!requestBudgetLeft(job)) return finalize(job, 'Maximum aantal AI-verzoeken bereikt; het resultaat is niet meer door ChatGPT beoordeeld.');
  const prompt = events.latestInCycle(job.id, 'prompt', job.cycle);
  const claudePromptEv = events.forJob(job.id).filter((e) => e.kind === 'prompt' && e.meta?.target === 'claude' && e.cycle === job.cycle).pop() || prompt;
  const answer = events.latestInCycle(job.id, 'antwoord_claude', job.cycle);
  const prevIssues = job.cycle > 0 ? issuesRepo.forCycle(job.id, job.cycle - 1) : [];
  const text = reviewPrompt({
    job,
    criteria: job.acceptance_criteria,
    claudePrompt: claudePromptEv?.content || '',
    claudeAnswer: answer?.content || '',
    files: withText(filesRepo.inCycle(job.id, job.cycle)),
    checkRows: checksRepo.forCycle(job.id, job.cycle),
    cycle: job.cycle,
    previousIssues: prevIssues.map((i, n) => `${n + 1}. [${i.severity}] ${i.description}`).join('\n'),
  });
  addPrompt(job, 'chatgpt', 'review', text);
  const j = setState(job, 'WACHT_REVIEW');
  scheduleAuto(j);
  return j;
}

// ---------------------------------------------------------------- review
export function importReview(jobId, tok, text, source) {
  return withClaim(jobId, 'WACHT_REVIEW', tok, (job) => processReview(job, text, source));
}

function processReview(job, text, source) {
  if (!text.trim()) throw new StepError('Het antwoord is leeg.');
  job = recordAnswer(job, 'chatgpt', 'review', text, source);
  const r = parseReview(text);
  r.warnings.forEach((w) => warn(job, w));
  if (!r.ok) {
    ev(job, 'notitie', 'APP', { title: 'Review niet automatisch verwerkbaar', content: 'Lees de review en kies of er een verbetercyclus nodig is.' });
    return setState(job, 'WACHT_BESLISSING');
  }
  return applyVerdict(job, r.verdict, r.issues, { summary: r.summary, criteria: r.criteria, reviewer: source.model || 'ChatGPT', manual: false });
}

function applyVerdict(job, verdict, issueList, meta) {
  tx(() => {
    for (const i of issueList) issuesRepo.add({ job_id: job.id, cycle: job.cycle, ...i });
    checksRepo.add({
      job_id: job.id, cycle: job.cycle, name: `AI-beoordeling door ${meta.reviewer}`, category: 'AI_BEOORDELING',
      status: verdict === 'GOEDGEKEURD' ? STATUS.OK : STATUS.FAIL,
      output: [meta.summary, ...(meta.criteria || []).map((c) => `- [${c.status}] ${c.criterium}${c.toelichting ? ': ' + c.toelichting : ''}`)].filter(Boolean).join('\n'),
    });
  });
  ev(job, 'review_oordeel', 'CHATGPT', {
    title: `Oordeel: ${verdict}`, content: meta.summary || '',
    meta: { verdict, criteria: meta.criteria || [], issues: issueList.length, reviewer: meta.reviewer, manual: meta.manual },
  });
  if (verdict === 'GOEDGEKEURD') return finalize(job, 'Acceptatiecriteria volgens de AI-beoordeling behaald.');
  if (job.cycle >= job.max_cycles) return finalize(job, `Maximum aantal verbetercycli (${job.max_cycles}) bereikt.`);
  return startImprovement(job);
}

function startImprovement(job) {
  if (!requestBudgetLeft(job)) return finalize(job, 'Maximum aantal AI-verzoeken bereikt.');
  const prevCycle = job.cycle;
  const originalPrompt = events.forJob(job.id).find((e) => e.kind === 'prompt' && e.meta?.target === 'claude');
  const review = events.latestInCycle(job.id, 'antwoord_chatgpt', prevCycle);
  const issueRows = issuesRepo.forCycle(job.id, prevCycle);
  const checkRows = checksRepo.forCycle(job.id, prevCycle).filter((c) => c.category !== 'AI_BEOORDELING');
  const currentFiles = withText(filesRepo.latestGenerated(job.id));
  jobs.update(job.id, { cycle: prevCycle + 1 });
  job = jobs.get(job.id);
  ev(job, 'verbeterpunten', 'APP', {
    title: `Verbetercyclus ${job.cycle} gestart`,
    content: issueRows.map((i, n) => `${n + 1}. [${i.severity}] ${i.description}`).join('\n') || '(geen gestructureerde lijst)',
  });
  const text = improvementPrompt({
    job, originalClaudePrompt: originalPrompt?.content || '', files: currentFiles, issueRows, checkRows,
    cycle: job.cycle, maxCycles: job.max_cycles, reviewText: review?.meta?.purpose === 'review' ? review.content : null,
  });
  addPrompt(job, 'claude', 'verbetering', text);
  const j = setState(job, 'WACHT_CLAUDE');
  scheduleAuto(j);
  return j;
}

// Handmatige beslissing wanneer de review niet verwerkbaar was of na een fout.
export function decide(jobId, tok, choice, note) {
  return withClaim(jobId, 'WACHT_BESLISSING', tok, (job) => {
    if (note?.trim()) ev(job, 'notitie', 'GEBRUIKER', { title: 'Toelichting bij beslissing', content: note });
    const hasReview = !!events.latestInCycle(job.id, 'review_oordeel', job.cycle);
    const issues = note?.trim() ? [{ severity: 'middel', description: note.trim(), suggestion: null }] : [];
    if (choice === 'verbeteren') {
      if (job.cycle >= job.max_cycles) throw new StepError(`Maximum aantal verbetercycli (${job.max_cycles}) is bereikt.`);
      if (!hasReview) return applyVerdict(job, 'AFGEKEURD', issues, { summary: 'Handmatig vastgesteld: verbetering nodig.', reviewer: 'gebruiker (handmatig)', manual: true });
      return startImprovement(job);
    }
    if (choice === 'goedkeuren') {
      return applyVerdict(job, 'GOEDGEKEURD', [], { summary: 'Handmatig goedgekeurd door gebruiker op basis van de review.', reviewer: 'gebruiker (handmatig)', manual: true });
    }
    if (choice === 'afronden') return finalize(job, 'Afgerond op verzoek van de gebruiker.');
    throw new StepError('Onbekende keuze.');
  });
}

// ---------------------------------------------------------------- afronden
export function finalize(job, reason) {
  job = jobs.get(job.id);
  const fs = computeFinalStatus(job);
  ev(job, 'eindbeoordeling', 'APP', { title: `Eindstatus: ${fs.status}`, content: [`Reden van afronden: ${reason}`, ...fs.reasons].join('\n'), meta: { status: fs.status } });
  return setState(job, 'AFGEROND', { final_status: fs.status, finished_at: new Date().toISOString() });
}

export function stopJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || FINAL_STATES.includes(job.state)) throw new StepError('Opdracht is al afgerond of gestopt.');
  if (['BEZIG', 'VERWERKEN', 'TESTS_BEZIG'].includes(job.state)) throw new StepError('Er loopt nog een verwerking; wacht tot deze klaar is en stop daarna.');
  ev(job, 'notitie', 'GEBRUIKER', { title: 'Opdracht gestopt', content: `Gestopt in toestand: ${STATES[job.state]}` });
  const fs = computeFinalStatus(job);
  return setState(job, 'GESTOPT', { prev_state: job.state, final_status: fs.status, finished_at: new Date().toISOString() });
}

export function resumeJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'GESTOPT' || !job.prev_state) throw new StepError('Alleen een gestopte opdracht kan worden hervat.');
  ev(job, 'notitie', 'GEBRUIKER', { title: 'Opdracht hervat', content: `Hervat in toestand: ${STATES[job.prev_state]}` });
  return setState(job, job.prev_state, { final_status: null, finished_at: null });
}

// Afgeronde opdracht heropenen voor één extra verbetercyclus.
export function reopenForImprovement(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.state !== 'AFGEROND') throw new StepError('Alleen een afgeronde opdracht kan worden heropend.');
  if (!events.latestInCycle(job.id, 'antwoord_claude', job.cycle)) throw new StepError('Er is nog geen resultaat om te verbeteren.');
  jobs.update(job.id, { max_cycles: Math.max(job.max_cycles, job.cycle + 1), final_status: null, finished_at: null });
  ev(job, 'notitie', 'GEBRUIKER', { title: 'Opdracht heropend', content: 'Extra verbetercyclus toegestaan.' });
  return startImprovement(jobs.get(job.id));
}

// ---------------------------------------------------------------- lokale AI / API
// Voert de huidige stap uit via Ollama (alleen analyse) of de officiële API. Async in de achtergrond.
export function runViaProvider(jobId, tok, provider) {
  const job = jobs.get(jobId);
  if (!job) throw new StepError('Opdracht niet gevonden.');
  const target = STEP_TARGET[job.state];
  if (!target) throw new StepError('In deze stap is geen AI-verzoek nodig.');
  if (provider === 'ollama' && job.state !== 'WACHT_ANALYSE') {
    throw new StepError('Lokale AI wordt alleen ingezet voor de conceptprompt. Uitvoering (Claude) en onafhankelijke review (ChatGPT) worden niet door een lokaal model vervangen.');
  }
  if (provider === 'api') {
    if (job.handoff_mode !== 'api') throw new StepError('Deze opdracht gebruikt handmatige overdracht.');
    if (job.cost_budget != null && (job.cost_eur || 0) >= job.cost_budget) throw new StepError(`Kostenbudget van € ${job.cost_budget} is bereikt.`);
  }
  const state = job.state;
  const prompt = currentPrompt(job);
  const claimed = claim(jobId, state, tok);
  jobs.update(jobId, { state: 'BEZIG' });
  ev(claimed, 'notitie', 'APP', { title: provider === 'ollama' ? 'Lokale AI (Ollama) gestart' : `${ROLE[target]} via API gestart`, content: provider === 'ollama' ? 'Een lokaal model maakt een concept-uitvoeringsprompt. Dit is GEEN analyse door ChatGPT.' : '' });
  const call = provider === 'ollama' ? callOllama(prompt.content) : callApi(target, prompt.content);
  call.then((res) => {
    const j = jobs.get(jobId);
    if (j.state !== 'BEZIG') return;
    jobs.update(jobId, { state: 'VERWERKEN' });
    const src = provider === 'ollama'
      ? { ...res, actor: 'ollama', actorLabel: 'lokale AI (Ollama)' }
      : { ...res };
    const jj = jobs.get(jobId);
    try {
      if (state === 'WACHT_ANALYSE') processAnalysis(jj, res.text, src);
      else if (state === 'WACHT_CLAUDE') processClaude(jj, res.text, src);
      else if (state === 'WACHT_REVIEW') processReview(jj, res.text, src);
    } catch (e) {
      ev(jj, 'fout', 'APP', { title: 'Fout bij verwerken antwoord', content: e.message });
      setState(jobs.get(jobId), state);
    }
  }).catch((e) => {
    const j = jobs.get(jobId);
    ev(j, 'fout', 'APP', { title: provider === 'ollama' ? 'Lokale AI mislukt' : 'API-verzoek mislukt', content: e.message });
    setState(j, state);
    log.warn('AI-verzoek mislukt', { jobId, provider, error: e.message });
  });
  return jobs.get(jobId);
}

function scheduleAuto(job) {
  const s = getSettings();
  if (s.workflow_mode !== 'automatisch' || job.handoff_mode !== 'api' || !s.api_enabled) return;
  if (!STEP_TARGET[job.state]) return;
  setImmediate(() => {
    const j = jobs.get(job.id);
    if (j.state !== job.state) return;
    try { runViaProvider(j.id, j.pending_token, 'api'); } catch (e) {
      ev(j, 'waarschuwing', 'APP', { title: 'Automatische stap niet gestart', content: `${e.message} Ga handmatig verder.` });
    }
  });
}

// ---------------------------------------------------------------- opnieuw uitvoeren
export function cloneInput(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new StepError('Opdracht niet gevonden.');
  const original = events.forJob(jobId).find((e) => e.kind === 'opdracht');
  return {
    title: `${job.title} (opnieuw)`.slice(0, 200), assignment: job.assignment,
    acceptance_criteria: original?.meta?.criteria ?? '',
    workflow_type: job.workflow_type, variant: job.variant, handoff_mode: job.handoff_mode,
    max_cycles: job.max_cycles, max_requests: job.max_requests, clone_of: job.id,
  };
}

// ---------------------------------------------------------------- herstel en achtergrond
// Na een herstart: onderbroken verwerkingen terugzetten naar de laatste wachtende stap.
export function recoverInterrupted() {
  for (const job of jobs.list()) {
    if (job.state === 'BEZIG' || job.state === 'VERWERKEN') {
      const back = job.prev_state && WAITING_FOR_USER.includes(job.prev_state) ? job.prev_state : 'WACHT_BESLISSING';
      ev(job, 'waarschuwing', 'APP', { title: 'Onderbroken verwerking hersteld', content: `De applicatie werd herstart tijdens "${STATES[job.state]}". De opdracht staat weer op: ${STATES[back]}. Voer de stap opnieuw uit.` });
      setState(job, back);
      log.warn('onderbroken opdracht hersteld', { jobId: job.id, to: back });
    } else if (job.state === 'TESTS_BEZIG' && !sandboxRuns.pendingForJob(job.id)) {
      const hasFiles = filesRepo.inCycle(job.id, job.cycle).length > 0;
      const answer = events.latestInCycle(job.id, 'antwoord_claude', job.cycle);
      const parsed = answer ? parseFiles(answer.content).files.length : 0;
      if (parsed > 0 && !hasFiles) {
        ev(job, 'waarschuwing', 'APP', { title: 'Opslaan onderbroken', content: 'Bestanden worden opnieuw opgeslagen en getest.' });
        storeAndTest(job.id, job.cycle, parseFiles(answer.content).files).catch((e) => log.error('herstel mislukt', { e: e.message }));
      } else if (!checksRepo.forCycle(job.id, job.cycle).length && hasFiles) {
        const r = runChecks(job.id, job.cycle, filesRepo.inCycle(job.id, job.cycle));
        if (!r.queued) afterTests(job.id);
      } else {
        afterTests(job.id);
      }
    }
  }
}

export function startPoller() {
  return setInterval(() => {
    try {
      for (const jobId of collectSandboxResults()) afterTests(jobId);
    } catch (e) {
      log.error('fout in sandbox-poller', { error: e.message });
    }
  }, 2000);
}
