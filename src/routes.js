import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import Busboy from 'busboy';
import { config } from './config.js';
import { jobs, events, files as filesRepo, checks as checksRepo, issues as issuesRepo, users } from './db.js';
import * as auth from './auth.js';
import * as V from './views.js';
import * as wf from './workflow.js';
import { getSettings, parseSettingsForm, saveSettings } from './settings.js';
import { storeUpload, readStored, readExtract, isAllowedUpload, safeUploadName, validateContent, removeJobFiles, extOf } from './files.js';
import { buildReport, reportMarkdown } from './report.js';
import { lineDiff } from './diff.js';
import { buildZip } from './zip.js';
import { sandboxStatus } from './checks.js';
import { ollamaStatus, apiStatus } from './providers.js';
import { configureLog, log } from './log.js';
import { WORKFLOW_TYPES } from './prompts.js';

const r = express.Router();
const html = (res, body, status = 200) => res.status(status).type('html').send(body);

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || 'onbekend';
}

function intParam(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function loadJob(req, res) {
  const id = intParam(req.params.id);
  const job = id && jobs.get(id);
  if (!job) { html(res, V.errorPage(req, 404, 'Opdracht niet gevonden.'), 404); return null; }
  return job;
}

// ------------------------------------------------------------------ openbaar
r.get('/healthz', (_req, res) => res.json({ ok: true }));

r.get('/setup', (req, res) => {
  if (!auth.setupPending()) return res.redirect('/login');
  html(res, V.setupPage(req, {}));
});
r.post('/setup', (req, res) => {
  if (auth.loginBlocked(clientIp(req))) return html(res, V.setupPage(req, { error: 'Te veel pogingen; probeer het over 15 minuten opnieuw.' }), 429);
  const err = auth.completeSetup(req.body.code, req.body.username, req.body.password);
  if (err) { auth.loginFailed(clientIp(req)); return html(res, V.setupPage(req, { error: err }), 400); }
  log.info('installatie voltooid');
  res.redirect('/login');
});

r.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  html(res, V.loginPage(req, { next: req.query.next, setup: auth.setupPending() }));
});
r.post('/login', (req, res) => {
  const ip = clientIp(req);
  const next = typeof req.body.next === 'string' && /^\/(?!\/)/.test(req.body.next) ? req.body.next : '/';
  if (auth.loginBlocked(ip)) return html(res, V.loginPage(req, { error: 'Te veel mislukte pogingen. Probeer het over 15 minuten opnieuw.', next }), 429);
  const u = users.byName(String(req.body.username || ''));
  if (!u || !auth.verifyPassword(String(req.body.password || ''), u.pw_hash)) {
    auth.loginFailed(ip);
    log.warn('mislukte inlogpoging', { ip });
    return html(res, V.loginPage(req, { error: 'Onjuiste gebruikersnaam of wachtwoord.', next }), 401);
  }
  auth.loginSucceeded(ip);
  auth.login(res, u.id);
  log.info('ingelogd', { user: u.username });
  res.redirect(next);
});

// ------------------------------------------------------------------ vanaf hier ingelogd
r.use(auth.requireAuth);
r.use(auth.checkCsrf);

r.post('/logout', (req, res) => {
  auth.logout(req, res);
  res.redirect('/login');
});

r.get('/', (req, res) => {
  const all = jobs.list();
  const waiting = all.filter((j) => wf.WAITING_FOR_USER.includes(j.state));
  const active = all.filter((j) => !wf.FINAL_STATES.includes(j.state));
  const done = all.filter((j) => j.state === 'AFGEROND');
  const failed = all.filter((j) => j.final_status === 'MISLUKT');
  const warnings = [];
  const sb = sandboxStatus();
  if (!sb.available) warnings.push(`Sandbox voor tests niet beschikbaar: ${sb.reason} Code wordt dan niet uitgevoerd en tests worden als NIET GETEST gemeld.`);
  else if (!sb.isolated) warnings.push(`De sandbox is niet volledig geïsoleerd (${sb.hb.isolation?.summary || 'onbekend'}). Gebruik in productie de sandbox-container uit compose.yaml.`);
  html(res, V.dashboardPage(req, { all, waiting, active, done, failed, warnings }));
});

r.get('/opdrachten', (req, res) => {
  const filter = String(req.query.filter || '');
  let list = jobs.list();
  if (filter === 'actief') list = list.filter((j) => !wf.FINAL_STATES.includes(j.state));
  if (filter === 'afgerond') list = list.filter((j) => j.state === 'AFGEROND');
  if (filter === 'gestopt') list = list.filter((j) => j.state === 'GESTOPT');
  if (filter === 'mislukt') list = list.filter((j) => j.final_status === 'MISLUKT');
  html(res, V.historyPage(req, { list, filter }));
});

function apiReady() {
  const s = getSettings();
  return s.api_enabled && apiStatus('chatgpt').state === 'GECONFIGUREERD' && apiStatus('claude').state === 'GECONFIGUREERD';
}

r.get('/opdrachten/nieuw', (req, res) => {
  let prefill = null;
  const src = intParam(req.query.kopie);
  if (src && jobs.get(src)) prefill = wf.cloneInput(src);
  html(res, V.newJobPage(req, { settings: getSettings(), apiReady: apiReady(), prefill }));
});

// Multipart-upload met busboy; bestanden worden in het geheugen gebufferd (met limieten)
// en pas na CSRF- en invoercontrole opgeslagen.
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: config.maxUploadFiles, fields: 30, fieldSize: 2 * 1024 * 1024 } });
    } catch (e) { return reject(e); }
    const fields = {};
    const uploads = [];
    const errors = [];
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (_name, stream, info) => {
      if (!info.filename) { stream.resume(); return; }
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => errors.push(`${info.filename}: groter dan ${config.maxUploadMb} MB`));
      stream.on('end', () => { if (!stream.truncated) uploads.push({ name: info.filename, buf: Buffer.concat(chunks) }); });
    });
    bb.on('filesLimit', () => errors.push(`Maximaal ${config.maxUploadFiles} bestanden.`));
    bb.on('error', reject);
    bb.on('close', () => resolve({ fields, uploads, errors }));
    req.pipe(bb);
  });
}

r.post('/opdrachten', async (req, res, next) => {
  try {
    if (!req.is('multipart/form-data')) return res.status(400).send('Verwacht multipart/form-data.');
    const { fields, uploads, errors } = await parseMultipart(req);
    // CSRF hier, want de body komt pas na het parsen binnen
    if (!auth.csrfValid(req, fields._csrf)) return res.status(403).send('Ongeldig of verlopen formulier (CSRF). Laad de pagina opnieuw.');

    const s = getSettings();
    const input = {
      title: String(fields.title || '').trim().slice(0, 200),
      assignment: String(fields.assignment || '').trim(),
      acceptance_criteria: String(fields.acceptance_criteria || '').trim(),
      workflow_type: fields.workflow_type in WORKFLOW_TYPES ? fields.workflow_type : 'algemeen',
      variant: fields.variant === 'direct' ? 'direct' : 'volledig',
      handoff_mode: fields.handoff_mode === 'api' ? 'api' : 'handmatig',
      max_cycles: Math.min(10, Math.max(0, parseInt(fields.max_cycles, 10) || s.max_cycles)),
      max_requests: Math.min(200, Math.max(1, parseInt(fields.max_requests, 10) || s.max_requests)),
      clone_of: intParam(fields.clone_of),
    };
    if (input.handoff_mode === 'api' && !apiReady()) errors.push('API-overdracht is niet geconfigureerd; kies handmatige overdracht.');
    if (!input.title || !input.assignment) errors.push('Titel en opdracht zijn verplicht.');
    const accepted = [];
    for (const u of uploads) {
      const name = safeUploadName(u.name);
      if (!name) { errors.push(`${u.name}: ongeldige bestandsnaam`); continue; }
      if (!isAllowedUpload(name)) { errors.push(`${name}: bestandstype niet toegestaan`); continue; }
      const bad = validateContent(name, u.buf);
      if (bad) { errors.push(`${name}: ${bad}`); continue; }
      if (accepted.some((a) => a.name === name)) { errors.push(`${name}: dubbele bestandsnaam`); continue; }
      accepted.push({ name, buf: u.buf });
    }
    if (errors.length) {
      return html(res, V.newJobPage(req, { settings: s, apiReady: apiReady(), prefill: input, error: errors.join(' · ') }), 400);
    }
    const id = wf.createJob(input);
    if (input.clone_of && jobs.get(input.clone_of)) {
      for (const f of filesRepo.uploads(input.clone_of)) {
        if (!accepted.some((a) => a.name === f.path)) accepted.push({ name: f.path, buf: readStored(f) });
      }
    }
    for (const a of accepted) await storeUpload(id, a.name, a.buf);
    wf.startJob(id);
    log.info('opdracht aangemaakt', { id, files: accepted.length, variant: input.variant });
    res.redirect(`/opdrachten/${id}`);
  } catch (e) { next(e); }
});

function jobContext(job, flash) {
  const evs = events.forJob(job.id);
  const lastReviewAnswer = evs.filter((e) => e.kind === 'antwoord_chatgpt' && e.meta?.purpose === 'review').pop();
  const lastError = evs.filter((e) => e.kind === 'fout').pop();
  // Toon waarschuwingen sinds de laatste prompt (de rest staat in de geschiedenis)
  const lastPromptId = evs.filter((e) => e.kind === 'prompt').pop()?.id || 0;
  const lastAnswerId = evs.filter((e) => e.kind.startsWith('antwoord_')).pop()?.id || 0;
  const since = Math.min(lastPromptId, lastAnswerId || lastPromptId);
  return {
    flash,
    events: evs,
    currentPrompt: wf.currentPrompt(job),
    questions: evs.filter((e) => e.kind === 'verduidelijking_vragen').pop()?.content,
    lastReview: lastReviewAnswer?.content || lastError?.content,
    checks: checksRepo.forJob(job.id),
    issues: issuesRepo.forJob(job.id),
    files: filesRepo.forJob(job.id),
    hasGenerated: filesRepo.latestGenerated(job.id).length > 0,
    recentWarnings: evs.filter((e) => (e.kind === 'waarschuwing' || e.kind === 'fout') && e.id > since),
    ollamaReady: false,
  };
}

async function renderJob(req, res, job, flash = [], status = 200) {
  const ctx = jobContext(job, flash);
  if (job.state === 'WACHT_ANALYSE' && getSettings().ollama_enabled) ctx.ollamaReady = (await ollamaStatus()).state === 'WERKEND';
  html(res, V.jobPage(req, job, ctx), status);
}

r.get('/opdrachten/:id', async (req, res, next) => {
  try {
    const job = loadJob(req, res);
    if (job) await renderJob(req, res, job);
  } catch (e) { next(e); }
});

r.get('/api/opdrachten/:id/toestand', (req, res) => {
  const job = jobs.get(intParam(req.params.id));
  if (!job) return res.status(404).json({ error: 'niet gevonden' });
  res.json({ state: job.state, updated_at: job.updated_at });
});

// Generieke afhandeling van workflowstappen.
function step(action, fn) {
  r.post(`/opdrachten/:id/${action}`, async (req, res, next) => {
    const job = loadJob(req, res);
    if (!job) return;
    try {
      await fn(job, req);
      res.redirect(`/opdrachten/${job.id}`);
    } catch (e) {
      if (e instanceof wf.StepError) return renderJob(req, res, jobs.get(job.id), [{ type: 'error', text: e.message }], 409).catch(next);
      next(e);
    }
  });
}

const source = (req) => ({ method: 'handmatig', model: String(req.body.model || '').trim().slice(0, 100) || null });
const answer = (req) => String(req.body.answer || '');

step('analyse', (job, req) => wf.importAnalysis(job.id, req.body.token, answer(req), { ...source(req), model: source(req).model || 'ChatGPT (webinterface, model niet opgegeven)' }));
step('claude', (job, req) => wf.importClaude(job.id, req.body.token, answer(req), { ...source(req), model: source(req).model || 'Claude (webinterface, model niet opgegeven)' }));
step('review', (job, req) => wf.importReview(job.id, req.body.token, answer(req), { ...source(req), model: source(req).model || 'ChatGPT (webinterface, model niet opgegeven)' }));
step('verduidelijking', (job, req) => wf.answerClarification(job.id, req.body.token, String(req.body.answers || '')));
step('prompt-bewerken', (job, req) => wf.editClaudePrompt(job.id, req.body.token, String(req.body.prompt || '')));
step('beslissing', (job, req) => wf.decide(job.id, req.body.token, String(req.body.choice || ''), String(req.body.note || '')));
step('provider', (job, req) => {
  const p = req.body.provider;
  if (p !== 'ollama' && p !== 'api') throw new wf.StepError('Onbekende methode.');
  if (p === 'api' && !getSettings().api_enabled) throw new wf.StepError('API-integraties zijn uitgeschakeld.');
  return wf.runViaProvider(job.id, req.body.token, p);
});
step('stoppen', (job) => wf.stopJob(job.id));
step('hervatten', (job) => wf.resumeJob(job.id));
step('heropenen', (job) => wf.reopenForImprovement(job.id));

r.post('/opdrachten/:id/verwijderen', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  if (!wf.FINAL_STATES.includes(job.state)) return html(res, V.errorPage(req, 409, 'Stop de opdracht eerst.'), 409);
  jobs.delete(job.id);
  removeJobFiles(job.id);
  log.info('opdracht verwijderd', { id: job.id });
  res.redirect('/opdrachten');
});

// ------------------------------------------------------------------ bestanden
function loadFile(req, res, job) {
  const f = filesRepo.get(intParam(req.params.fid));
  if (!f || f.job_id !== job.id) { html(res, V.errorPage(req, 404, 'Bestand niet gevonden.'), 404); return null; }
  return f;
}

r.get('/opdrachten/:id/bestanden.zip', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const list = filesRepo.latestGenerated(job.id);
  const zip = buildZip(list.map((f) => ({ name: f.path, data: readStored(f) })));
  res.setHeader('Content-Disposition', `attachment; filename="opdracht-${job.id}-resultaat.zip"`);
  res.type('application/zip').send(zip);
});

r.get('/opdrachten/:id/bestanden/:fid', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const f = loadFile(req, res, job);
  if (!f) return;
  const buf = readStored(f);
  const binary = buf.subarray(0, 8000).includes(0);
  const extract = f.origin === 'upload' && (binary || ['pdf', 'docx', 'xlsx', 'zip', 'step', 'stp'].includes(extOf(f.path))) ? readExtract(f) : null;
  html(res, V.filePage(req, job, f, {
    content: binary ? null : buf.toString('utf8').slice(0, 2_000_000),
    extract, versions: filesRepo.versions(job.id, f.path).filter((v) => v.origin === f.origin),
    previewable: ['html', 'htm'].includes(extOf(f.path)),
  }));
});

r.get('/opdrachten/:id/bestanden/:fid/download', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const f = loadFile(req, res, job);
  if (!f) return;
  const name = path.posix.basename(f.path).replace(/[^A-Za-z0-9._-]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.type('application/octet-stream').send(readStored(f));
});

// Voorbeeld van gegenereerde HTML in een afgeschermde context: CSP-sandbox (opaque origin,
// geen toegang tot cookies of de applicatie) en geen netwerkverkeer.
r.get('/opdrachten/:id/bestanden/:fid/voorbeeld', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const f = loadFile(req, res, job);
  if (!f || !['html', 'htm'].includes(extOf(f.path))) return;
  res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-modals; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'");
  res.type('html').send(readStored(f));
});

r.get('/opdrachten/:id/diff', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const p = String(req.query.pad || '');
  const versions = filesRepo.versions(job.id, p).filter((v) => v.origin === 'claude');
  if (!versions.length) return html(res, V.errorPage(req, 404, 'Geen versies gevonden.'), 404);
  const from = parseInt(req.query.van, 10) || versions[0].version;
  const to = parseInt(req.query.naar, 10) || versions[versions.length - 1].version;
  const a = versions.find((v) => v.version === from);
  const b = versions.find((v) => v.version === to);
  if (!a || !b) return html(res, V.errorPage(req, 404, 'Versie niet gevonden.'), 404);
  const diff = lineDiff(readStored(a).toString('utf8'), readStored(b).toString('utf8'));
  html(res, V.diffPage(req, job, { path: p, from, to, diff, versions }));
});

// ------------------------------------------------------------------ rapport en vergelijking
r.get('/opdrachten/:id/rapport', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  const rep = buildReport(job.id);
  html(res, V.reportPage(req, rep, reportMarkdown(rep)));
});

r.get('/opdrachten/:id/rapport.md', (req, res) => {
  const job = loadJob(req, res);
  if (!job) return;
  res.setHeader('Content-Disposition', `attachment; filename="opdracht-${job.id}-rapport.md"`);
  res.type('text/markdown; charset=utf-8').send(reportMarkdown(buildReport(job.id)));
});

r.get('/vergelijk', (req, res) => {
  const a = jobs.get(intParam(req.query.a));
  const b = jobs.get(intParam(req.query.b));
  if (!a || !b) return html(res, V.errorPage(req, 404, 'Kies twee bestaande opdrachten.'), 404);
  const ra = buildReport(a.id);
  const rb = buildReport(b.id);
  const paths = [...new Set([...ra.latestFiles, ...rb.latestFiles].map((f) => f.path))].sort();
  const rows = paths.map((p) => {
    const fa = ra.latestFiles.find((f) => f.path === p);
    const fb = rb.latestFiles.find((f) => f.path === p);
    const diff = fa && fb && fa.sha256 !== fb.sha256 ? lineDiff(readStored(fa).toString('utf8'), readStored(fb).toString('utf8')) : null;
    return { path: p, a: fa, b: fb, diff };
  });
  html(res, V.comparePage(req, ra, rb, rows));
});

// ------------------------------------------------------------------ integraties en instellingen
r.get('/integraties', async (req, res, next) => {
  try {
    const sb = sandboxStatus();
    const ol = await ollamaStatus();
    const oa = apiStatus('chatgpt');
    const an = apiStatus('claude');
    const sbText = sb.available
      ? `Actief. Hulpmiddelen: ${Object.entries(sb.hb.tools || {}).map(([k, v]) => `${k} ${v || 'ontbreekt'}`).join(', ')}. Isolatie: ${sb.hb.isolation?.summary || 'onbekend'}.`
      : sb.reason;
    const items = [
      { name: 'ChatGPT via webinterface', state: 'HANDMATIG', text: 'Prompts worden klaargezet; u plakt ze in ChatGPT en importeert het antwoord.',
        works: 'Prompt kopiëren/downloaden, ChatGPT openen in nieuw tabblad, antwoord importeren met automatische herkenning van prompt, criteria en review-JSON.',
        config: 'Geen. U gebruikt uw eigen ingelogde browser.', limits: 'Iedere stap is een handeling; abonnementslimieten (berichten, invoerlengte) gelden; het gebruikte model is niet automatisch vast te stellen.', cost: 'Geen extra kosten bovenop uw abonnement.' },
      { name: 'Claude via webinterface', state: 'HANDMATIG', text: 'Zelfde werkwijze als ChatGPT.',
        works: 'Prompt kopiëren, Claude openen, antwoord importeren; bestanden worden herkend aan "### BESTAND:"-kopjes.',
        config: 'Geen.', limits: 'Als in Claude een bestand als bijlage/artifact wordt getoond in plaats van in de tekst, moet u die inhoud zelf meekopiëren.', cost: 'Geen extra kosten bovenop uw abonnement.' },
      { name: 'Browserautomatisering (Playwright e.d.)', state: 'NIET_BESCHIKBAAR', text: 'Bewust niet gebouwd.',
        works: 'Niets.', config: '—',
        limits: 'De gebruiksvoorwaarden van OpenAI en Anthropic verbieden geautomatiseerde toegang tot en extractie uit de consumenten-webinterfaces; daarnaast bot-detectie en wisselende interfaces. Zie docs/HAALBAARHEID.md.', cost: '—' },
      { name: 'Sandbox voor tests', state: sb.available ? (sb.isolated ? 'WERKEND' : 'CONFIGUREREN') : getSettings().sandbox_enabled ? 'NIET_BEREIKBAAR' : 'UIT',
        text: sb.available && !sb.isolated ? `Werkt, maar is NIET volledig geïsoleerd. Gebruik de sandbox-container uit compose.yaml. ${sbText}` : sbText,
        works: 'Syntaxcontrole (node --check, py_compile, bash -n) en uitvoeren van meegeleverde tests (pytest, node --test) zonder netwerk.',
        config: 'Service "sandbox" in compose.yaml (standaard actief).', limits: 'Geen browser, geen Docker, geen pakketinstallatie, geen internet; time-out per taak.', cost: 'Geen.' },
      { name: 'Lokale AI (Ollama)', state: ol.state, text: ol.text,
        works: 'Conceptversie van de uitvoeringsprompt maken (duidelijk gemarkeerd als lokale AI).', config: 'Ollama installeren, model downloaden, OLLAMA_URL zetten, inschakelen bij Instellingen.',
        limits: 'Kleinere modellen zijn duidelijk minder sterk dan ChatGPT/Claude en kunnen op CPU minuten nodig hebben. Vervangt de onafhankelijke review niet.', cost: 'Geen (lokale hardware).' },
      { name: 'OpenAI API (rol ChatGPT)', state: oa.state, text: oa.text,
        works: 'Analyse- en reviewprompts automatisch versturen (niet getest zonder sleutel).', config: 'Apart OpenAI API-account, OPENAI_API_KEY in .env, modelnaam en optioneel prijzen bij Instellingen, API toestaan.',
        limits: 'Een ChatGPT-abonnement geeft geen API-sleutel.', cost: 'Ja: per token, afhankelijk van model.' },
      { name: 'Anthropic API (rol Claude)', state: an.state, text: an.text,
        works: 'Uitvoerings- en verbeterprompts automatisch versturen (niet getest zonder sleutel).', config: 'Apart Anthropic API-account, ANTHROPIC_API_KEY in .env, modelnaam bij Instellingen, API toestaan.',
        limits: 'Een Claude-abonnement geeft geen API-toegang.', cost: 'Ja: per token, afhankelijk van model.' },
    ];
    html(res, V.integrationsPage(req, items));
  } catch (e) { next(e); }
});

function storageSummary() {
  let size = 0;
  let count = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { count++; try { size += fs.statSync(p).size; } catch { /* weg */ } }
    }
  };
  walk(path.join(config.dataDir, 'jobs'));
  return `${count} bestanden, ${(size / 1024 / 1024).toFixed(1)} MB in opdrachtmappen`;
}

r.get('/instellingen', (req, res) => {
  html(res, V.settingsPage(req, { s: getSettings(), errors: [], storage: storageSummary(), saved: req.query.opgeslagen === '1' }));
});

r.post('/instellingen', (req, res) => {
  const { values, errors } = parseSettingsForm(req.body);
  if (errors.length) return html(res, V.settingsPage(req, { s: { ...getSettings(), ...values }, errors, storage: storageSummary() }), 400);
  saveSettings(values);
  configureLog({ logLevel: values.log_level, logToFile: values.log_to_file, dataDir: config.dataDir });
  log.info('instellingen gewijzigd');
  res.redirect('/instellingen?opgeslagen=1');
});

r.post('/wachtwoord', (req, res) => {
  const u = users.byName(req.user.username);
  const errs = [];
  if (!auth.verifyPassword(String(req.body.current || ''), u.pw_hash)) errs.push('Huidig wachtwoord onjuist.');
  const weak = auth.validatePasswordStrength(req.body.new);
  if (weak) errs.push(weak);
  if (errs.length) return html(res, V.settingsPage(req, { s: getSettings(), errors: errs, storage: storageSummary() }), 400);
  users.setPassword(u.id, auth.hashPassword(req.body.new));
  log.info('wachtwoord gewijzigd', { user: u.username });
  res.redirect('/instellingen?opgeslagen=1');
});

export default r;
