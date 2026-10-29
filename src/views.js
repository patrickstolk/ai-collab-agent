// Server-side gerenderde HTML. Alle dynamische waarden gaan door h() (escaping).
import { config } from './config.js';
import { STATES, STEP_TARGET, FINAL_STATES } from './workflow.js';
import { WORKFLOW_TYPES } from './prompts.js';

export function h(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmtDate = (s) => (s ? new Date(s).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' }) : '');

export const STATUS_CLASS = {
  GESLAAGD: 'ok', 'GEDEELTELIJK GESLAAGD': 'partial', MISLUKT: 'fail', 'NIET GETEST': 'untested', 'HANDMATIGE CONTROLE VEREIST': 'manual',
};

export function badge(status) {
  if (!status) return '';
  return `<span class="badge ${STATUS_CLASS[status] || 'neutral'}">${h(status)}</span>`;
}

function stateBadge(job) {
  const cls = FINAL_STATES.includes(job.state) ? 'neutral' : ['BEZIG', 'VERWERKEN', 'TESTS_BEZIG'].includes(job.state) ? 'busy' : 'wait';
  return `<span class="badge ${cls}">${h(STATES[job.state] || job.state)}</span>`;
}

const CATEGORY_LABEL = {
  UITGEVOERDE_TEST: 'Uitgevoerde test', STATISCH: 'Statische controle', NIET_UITGEVOERD: 'Niet uitgevoerd', AI_BEOORDELING: 'AI-beoordeling',
};

export function layout(req, title, body, { flash } = {}) {
  const user = req.user;
  const nav = user ? `
    <nav class="nav">
      <a href="/" class="brand">AI Collaboration Agent</a>
      <a href="/">Dashboard</a>
      <a href="/opdrachten/nieuw">Nieuwe opdracht</a>
      <a href="/opdrachten">Geschiedenis</a>
      <a href="/integraties">Integraties</a>
      <a href="/instellingen">Instellingen</a>
      <form method="post" action="/logout" class="inline right"><input type="hidden" name="_csrf" value="${h(req.session.csrf)}"><button class="link">Uitloggen (${h(user.username)})</button></form>
    </nav>` : '<nav class="nav"><span class="brand">AI Collaboration Agent</span></nav>';
  const envBanner = config.appEnv !== 'production' ? `<div class="env-banner">Omgeving: ${h(config.appEnv.toUpperCase())} — niet de productie-omgeving</div>` : '';
  const flashes = (flash || []).map((f) => `<div class="flash ${h(f.type)}">${h(f.text)}</div>`).join('');
  return `<!doctype html>
<html lang="nl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)} · AI Collaboration Agent</title>
<link rel="stylesheet" href="/static/style.css">
<script src="/static/app.js" defer></script>
</head><body>
${envBanner}${nav}
<main>${flashes}${body}</main>
</body></html>`;
}

const csrf = (req) => `<input type="hidden" name="_csrf" value="${h(req.session.csrf)}">`;

// ------------------------------------------------------------------ inloggen
export function loginPage(req, { error, next, setup }) {
  return layout(req, 'Inloggen', `
  <section class="card narrow">
    <h1>Inloggen</h1>
    ${error ? `<div class="flash error">${h(error)}</div>` : ''}
    ${setup ? '<p class="muted">Er is nog geen gebruiker. <a href="/setup">Voltooi eerst de installatie.</a></p>' : ''}
    <form method="post" action="/login">
      <input type="hidden" name="next" value="${h(next || '/')}">
      <label>Gebruikersnaam<input name="username" autocomplete="username" required></label>
      <label>Wachtwoord<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">Inloggen</button>
    </form>
  </section>`);
}

export function setupPage(req, { error }) {
  return layout(req, 'Installatie', `
  <section class="card narrow">
    <h1>Eerste installatie</h1>
    <p>Maak het beheerdersaccount aan. De installatiecode staat in de datamap (<code>SETUP_CODE.txt</code>) en in de containerlogs.</p>
    ${error ? `<div class="flash error">${h(error)}</div>` : ''}
    <form method="post" action="/setup">
      <label>Installatiecode<input name="code" required autocomplete="off"></label>
      <label>Gebruikersnaam<input name="username" required value="admin"></label>
      <label>Wachtwoord (min. 12 tekens)<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
      <button class="primary">Account aanmaken</button>
    </form>
  </section>`);
}

// ------------------------------------------------------------------ dashboard
function jobTable(list, empty) {
  if (!list.length) return `<p class="muted">${h(empty)}</p>`;
  return `<table class="table"><thead><tr><th>#</th><th>Titel</th><th>Toestand</th><th>Eindstatus</th><th>Ronde</th><th>Bijgewerkt</th></tr></thead><tbody>
  ${list.map((j) => `<tr><td>${j.id}</td><td><a href="/opdrachten/${j.id}">${h(j.title)}</a></td><td>${stateBadge(j)}</td><td>${badge(j.final_status)}</td><td>${j.cycle + 1}</td><td>${fmtDate(j.updated_at)}</td></tr>`).join('')}
  </tbody></table>`;
}

export function dashboardPage(req, { all, waiting, active, done, failed, warnings }) {
  return layout(req, 'Dashboard', `
  <div class="page-head"><h1>Dashboard</h1><a class="button primary" href="/opdrachten/nieuw">+ Nieuwe opdracht</a></div>
  ${warnings.map((w) => `<div class="flash warn">${h(w)}</div>`).join('')}
  <div class="stats">
    <div class="stat"><span>${waiting.length}</span>Wacht op uw invoer</div>
    <div class="stat"><span>${active.length}</span>Actief</div>
    <div class="stat"><span>${done.length}</span>Afgerond</div>
    <div class="stat"><span>${failed.length}</span>Mislukt</div>
    <div class="stat"><span>${all.length}</span>Totaal</div>
  </div>
  <section class="card"><h2>Wacht op uw invoer</h2>${jobTable(waiting, 'Geen opdrachten die op u wachten.')}</section>
  <section class="card"><h2>Actief (verwerking loopt)</h2>${jobTable(active.filter((j) => !waiting.includes(j)), 'Geen lopende verwerkingen.')}</section>
  <section class="card"><h2>Recente resultaten</h2>${jobTable(done.slice(0, 10), 'Nog geen afgeronde opdrachten.')}</section>
  <section class="card"><h2>Mislukt</h2>${jobTable(failed.slice(0, 10), 'Geen mislukte opdrachten.')}</section>`);
}

export function historyPage(req, { list, filter }) {
  const opts = [['', 'Alle'], ['actief', 'Actief'], ['afgerond', 'Afgerond'], ['gestopt', 'Gestopt'], ['mislukt', 'Mislukt']];
  return layout(req, 'Geschiedenis', `
  <div class="page-head"><h1>Opdrachtgeschiedenis</h1></div>
  <form method="get" class="filters">
    <select name="filter">${opts.map(([v, l]) => `<option value="${v}" ${filter === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button>Filteren</button>
  </form>
  <form method="get" action="/vergelijk" class="card">
    <h2>Twee opdrachten vergelijken</h2>
    <div class="row">
      <label>Opdracht A<select name="a">${list.map((j) => `<option value="${j.id}">#${j.id} ${h(j.title)}</option>`).join('')}</select></label>
      <label>Opdracht B<select name="b">${list.map((j, i) => `<option value="${j.id}" ${i === 1 ? 'selected' : ''}>#${j.id} ${h(j.title)}</option>`).join('')}</select></label>
      <button>Vergelijken</button>
    </div>
  </form>
  <section class="card">${jobTable(list, 'Geen opdrachten gevonden.')}</section>`);
}

// ------------------------------------------------------------------ nieuwe opdracht
export function newJobPage(req, { settings, apiReady, prefill, error }) {
  const p = prefill || {};
  return layout(req, 'Nieuwe opdracht', `
  <h1>Nieuwe opdracht</h1>
  ${error ? `<div class="flash error">${h(error)}</div>` : ''}
  <form method="post" action="/opdrachten" enctype="multipart/form-data" class="card" data-once>
    ${csrf(req)}
    <label>Titel<input name="title" maxlength="200" required value="${h(p.title || '')}" placeholder="Bijv. HTML-pagina met invoerveld"></label>
    <label>Opdracht<textarea name="assignment" rows="8" required placeholder="Beschrijf zo concreet mogelijk wat er moet gebeuren.">${h(p.assignment || '')}</textarea></label>
    <label>Acceptatiecriteria (optioneel, één per regel)<textarea name="acceptance_criteria" rows="4" placeholder="- De pagina bevat een invoerveld, een knop en een resultatenveld">${h(p.acceptance_criteria || '')}</textarea></label>
    <label>Bestanden (optioneel, max. ${config.maxUploadFiles} bestanden van ${config.maxUploadMb} MB)
      <input type="file" name="files" multiple>
      <small class="muted">Ondersteund: PDF, DOCX, XLSX, TXT, Markdown, JSON, YAML, Python, JS/TS, HTML/CSS, Dockerfile/Compose, ZIP, STEP. De applicatie toont per bestand wat daadwerkelijk is gelezen.</small>
    </label>
    <div class="row">
      <label>Soort opdracht<select name="workflow_type">${Object.entries(WORKFLOW_TYPES).map(([k, v]) => `<option value="${k}" ${p.workflow_type === k ? 'selected' : ''}>${h(v)}</option>`).join('')}</select></label>
      <label>Workflow<select name="variant">
        <option value="volledig" ${p.variant !== 'direct' ? 'selected' : ''}>Volledig: ChatGPT analyseert → Claude voert uit → ChatGPT reviewt</option>
        <option value="direct" ${p.variant === 'direct' ? 'selected' : ''}>Direct: opdracht rechtstreeks naar Claude → ChatGPT reviewt</option>
      </select></label>
      <label>Overdrachtsmethode<select name="handoff_mode">
        <option value="handmatig" ${settings.default_handoff !== 'api' || !apiReady ? 'selected' : ''}>Handmatig (kopiëren/plakken, zonder API)</option>
        <option value="api" ${!apiReady ? 'disabled' : ''} ${settings.default_handoff === 'api' && apiReady ? 'selected' : ''}>Automatisch via API ${apiReady ? '(kost geld per verzoek)' : '(niet geconfigureerd)'}</option>
      </select></label>
    </div>
    <div class="row">
      <label>Max. verbetercycli<input type="number" name="max_cycles" min="0" max="10" value="${h(p.max_cycles ?? settings.max_cycles)}"></label>
      <label>Max. AI-verzoeken<input type="number" name="max_requests" min="1" max="200" value="${h(p.max_requests ?? settings.max_requests)}"></label>
    </div>
    ${p.clone_of ? `<input type="hidden" name="clone_of" value="${h(p.clone_of)}"><p class="muted">Kopie van opdracht #${h(p.clone_of)}; de oorspronkelijke invoerbestanden worden meegekopieerd.</p>` : ''}
    <button class="primary">Opdracht starten</button>
  </form>`);
}

// ------------------------------------------------------------------ opdrachtdetail
function promptBox(id, text, filename) {
  return `<div class="prompt-box">
    <div class="toolbar">
      <button type="button" data-copy="${id}">Prompt kopiëren</button>
      <button type="button" data-download="${id}" data-filename="${h(filename)}">Downloaden als .txt</button>
      <span class="muted">${text.length.toLocaleString('nl-NL')} tekens</span>
    </div>
    <textarea id="${id}" readonly rows="12">${h(text)}</textarea>
  </div>`;
}

const OPEN = {
  chatgpt: '<a class="button" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT openen ↗</a>',
  claude: '<a class="button" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Claude openen ↗</a>',
};

function importForm(req, job, { action, label, target, placeholder }) {
  return `<form method="post" action="/opdrachten/${job.id}/${action}" class="import" data-once>
    ${csrf(req)}<input type="hidden" name="token" value="${h(job.pending_token)}">
    <label>Plak hier het volledige antwoord van ${target === 'claude' ? 'Claude' : 'ChatGPT'}
      <small class="muted">Gebruik bij voorkeur de kopieerknop onder het antwoord in ${target === 'claude' ? 'Claude' : 'ChatGPT'}, zodat codeblokken en markeringen behouden blijven.</small>
      <textarea name="answer" rows="10" required placeholder="${h(placeholder)}"></textarea></label>
    <label>Gebruikt model (optioneel)<input name="model" maxlength="100" placeholder="${target === 'claude' ? 'Bijv. Claude (web), model zoals getoond in de interface' : 'Bijv. ChatGPT (web), model zoals getoond in de interface'}"></label>
    <button class="primary">${h(label)}</button>
  </form>`;
}

function providerButtons(req, job, ctx) {
  const out = [];
  if (job.state === 'WACHT_ANALYSE' && ctx.ollamaReady) {
    out.push(`<form method="post" action="/opdrachten/${job.id}/provider" class="inline" data-once data-confirm="Een lokaal model maakt een conceptprompt. Dit vervangt de analyse door ChatGPT. Doorgaan?">${csrf(req)}<input type="hidden" name="token" value="${h(job.pending_token)}"><input type="hidden" name="provider" value="ollama"><button>Conceptprompt door lokale AI (Ollama)</button></form>`);
  }
  if (job.handoff_mode === 'api' && STEP_TARGET[job.state]) {
    out.push(`<form method="post" action="/opdrachten/${job.id}/provider" class="inline" data-once data-confirm="Dit verstuurt de prompt via de betaalde API. Doorgaan?">${csrf(req)}<input type="hidden" name="token" value="${h(job.pending_token)}"><input type="hidden" name="provider" value="api"><button>Via API versturen (kosten)</button></form>`);
  }
  return out.length ? `<div class="toolbar">${out.join('')}</div>` : '';
}

function actionPanel(req, job, ctx) {
  const prompt = ctx.currentPrompt;
  const step = (n, title, body) => `<section class="card action"><h2><span class="stepno">${n}</span>${h(title)}</h2>${body}</section>`;
  switch (job.state) {
    case 'WACHT_ANALYSE':
      return step('1', 'Analyse en uitvoeringsprompt door ChatGPT', `
        <ol class="howto"><li>Kopieer de prompt en open ChatGPT (een nieuw gesprek).</li><li>Plak en verstuur de prompt.</li><li>Kopieer het volledige antwoord en importeer het hieronder.</li></ol>
        <div class="toolbar">${OPEN.chatgpt}</div>
        ${promptBox('prompt-current', prompt.content, `opdracht-${job.id}-analyse-prompt.txt`)}
        ${providerButtons(req, job, ctx)}
        ${importForm(req, job, { action: 'analyse', label: 'Antwoord importeren', target: 'chatgpt', placeholder: '===ANALYSE=== …' })}`);
    case 'WACHT_VERDUIDELIJKING':
      return step('1', 'ChatGPT vraagt om verduidelijking', `
        <pre class="questions">${h(ctx.questions || '')}</pre>
        <form method="post" action="/opdrachten/${job.id}/verduidelijking" data-once>${csrf(req)}<input type="hidden" name="token" value="${h(job.pending_token)}">
          <label>Uw antwoorden<textarea name="answers" rows="6" required></textarea></label>
          <button class="primary">Antwoorden opslaan en nieuwe analyseprompt maken</button></form>`);
    case 'WACHT_CLAUDE':
      return step('2', job.cycle === 0 ? 'Uitvoering door Claude' : `Verbetercyclus ${job.cycle}: verbeterprompt voor Claude`, `
        <ol class="howto"><li>Kopieer de prompt en open Claude (een nieuw gesprek).</li><li>Plak en verstuur de prompt.</li><li>Kopieer het volledige antwoord (met de kopieerknop) en importeer het hieronder. De applicatie herkent de bestanden en voert de controles uit.</li></ol>
        <div class="toolbar">${OPEN.claude}</div>
        ${promptBox('prompt-current', prompt.content, `opdracht-${job.id}-claude-ronde-${job.cycle + 1}.txt`)}
        ${job.cycle === 0 && prompt.meta?.base ? `<details><summary>Prompt bewerken vóór versturen</summary>
          <form method="post" action="/opdrachten/${job.id}/prompt-bewerken" data-once>${csrf(req)}<input type="hidden" name="token" value="${h(job.pending_token)}">
          <p class="muted">Bewerk het deel van ChatGPT; het vaste uitvoerformaat en de invoerbestanden voegt de applicatie automatisch toe.</p>
          <textarea name="prompt" rows="12">${h(prompt.meta.base)}</textarea><button>Opslaan als nieuwe prompt</button></form></details>` : ''}
        ${providerButtons(req, job, ctx)}
        ${importForm(req, job, { action: 'claude', label: 'Antwoord importeren', target: 'claude', placeholder: '### BESTAND: index.html …' })}`);
    case 'WACHT_REVIEW':
      return step('3', `Onafhankelijke review door ChatGPT (ronde ${job.cycle + 1})`, `
        <p>De reviewprompt is voorbereid met de opdracht, de prompt, het volledige resultaat van Claude en de <strong>feitelijke</strong> testresultaten.</p>
        <ol class="howto"><li>Open bij voorkeur een <strong>nieuw</strong> ChatGPT-gesprek, zodat de review onafhankelijk is van de analyse.</li><li>Plak de prompt, en importeer de review hieronder.</li></ol>
        <div class="toolbar">${OPEN.chatgpt}</div>
        ${promptBox('prompt-current', prompt.content, `opdracht-${job.id}-review-ronde-${job.cycle + 1}.txt`)}
        ${providerButtons(req, job, ctx)}
        ${importForm(req, job, { action: 'review', label: 'Review importeren', target: 'chatgpt', placeholder: '… ===REVIEW JSON=== {…} ===EINDE REVIEW JSON===' })}`);
    case 'WACHT_BESLISSING':
      return step('?', 'Uw beslissing is nodig', `
        <p>De review kon niet automatisch worden verwerkt, of er trad een fout op. Lees de laatste review of foutmelding in de geschiedenis hieronder en kies hoe verder te gaan.</p>
        ${ctx.lastReview ? `<details open><summary>Laatste review</summary><pre class="scroll">${h(ctx.lastReview)}</pre></details>` : ''}
        <form method="post" action="/opdrachten/${job.id}/beslissing" data-once>${csrf(req)}<input type="hidden" name="token" value="${h(job.pending_token)}">
          <label>Verbeterpunten of toelichting (optioneel)<textarea name="note" rows="4"></textarea></label>
          <div class="toolbar">
            <button name="choice" value="verbeteren" class="primary" ${job.cycle >= job.max_cycles ? 'disabled' : ''}>Verbeterprompt genereren</button>
            <button name="choice" value="goedkeuren">Resultaat goedkeuren</button>
            <button name="choice" value="afronden">Afronden zonder goedkeuring</button>
          </div>
          ${job.cycle >= job.max_cycles ? '<p class="muted">Maximum aantal verbetercycli bereikt.</p>' : ''}
        </form>`);
    case 'TESTS_BEZIG':
    case 'BEZIG':
    case 'VERWERKEN':
      return `<section class="card action busy" data-poll="/api/opdrachten/${job.id}/toestand" data-state="${h(job.state)}">
        <h2><span class="spinner"></span>${h(STATES[job.state])}…</h2><p class="muted">Deze pagina ververst automatisch.</p></section>`;
    case 'AFGEROND':
      return `<section class="card action done"><h2>Afgerond ${badge(job.final_status)}</h2>
        <div class="toolbar"><a class="button primary" href="/opdrachten/${job.id}/rapport">Eindrapport bekijken</a>
        <form method="post" action="/opdrachten/${job.id}/heropenen" class="inline" data-once>${csrf(req)}<button>Nieuwe verbetercyclus starten</button></form></div></section>`;
    case 'GESTOPT':
      return `<section class="card action"><h2>Gestopt</h2><p>Gestopt tijdens: ${h(STATES[job.prev_state] || '')}.</p>
        <form method="post" action="/opdrachten/${job.id}/hervatten" class="inline" data-once>${csrf(req)}<button class="primary">Hervatten</button></form></section>`;
    default:
      return '';
  }
}

function pipeline(job, ctx) {
  const steps = [
    ['analyse', 'Analyse', job.variant === 'direct' ? 'skip' : null],
    ['claude', 'Uitvoering'],
    ['tests', 'Tests'],
    ['review', 'Review'],
    ['rapport', 'Rapport'],
  ];
  const cur = { WACHT_ANALYSE: 'analyse', WACHT_VERDUIDELIJKING: 'analyse', WACHT_CLAUDE: 'claude', TESTS_BEZIG: 'tests', WACHT_REVIEW: 'review', WACHT_BESLISSING: 'review', AFGEROND: 'rapport', GESTOPT: null }[job.state === 'BEZIG' || job.state === 'VERWERKEN' ? job.prev_state : job.state];
  const idx = steps.findIndex((s) => s[0] === cur);
  return `<ol class="pipeline">${steps.map((s, i) => `<li class="${s[2] === 'skip' ? 'skip' : i < idx || job.state === 'AFGEROND' ? 'done' : i === idx ? 'current' : ''}">${h(s[1])}</li>`).join('')}</ol>
    <p class="muted small">Ronde ${job.cycle + 1} · verbetercycli ${job.cycle}/${job.max_cycles} · AI-verzoeken ${job.request_count}/${job.max_requests}${job.cost_eur != null ? ` · kosten € ${job.cost_eur.toFixed(4)}` : ''}</p>`;
}

const ACTOR_LABEL = { APP: 'Applicatie', GEBRUIKER: 'Gebruiker', CHATGPT: 'ChatGPT', CLAUDE: 'Claude', OLLAMA: 'Lokale AI (Ollama)' };

function timeline(evs) {
  return `<ol class="timeline">${evs.map((e) => {
    const cls = e.kind === 'fout' ? 'error' : e.kind === 'waarschuwing' ? 'warn' : e.actor === 'OLLAMA' ? 'local' : '';
    const meta = [
      `ronde ${e.cycle + 1}`, ACTOR_LABEL[e.actor] || e.actor,
      e.method ? `methode: ${e.method}` : '', e.model ? `model: ${e.model}` : '',
      e.meta?.wait_ms != null ? `wachttijd ${Math.round(e.meta.wait_ms / 1000)} s` : '',
      e.meta?.cost_eur != null ? `€ ${Number(e.meta.cost_eur).toFixed(4)}` : '',
    ].filter(Boolean).join(' · ');
    const long = (e.content || '').length > 300 || (e.content || '').includes('\n');
    return `<li class="${cls}"><div class="tl-head"><strong>${h(e.title || e.kind)}</strong> <span class="muted small">${fmtDate(e.created_at)} · ${h(meta)}</span></div>
      ${e.content ? (long ? `<details><summary>Inhoud tonen (${e.content.length.toLocaleString('nl-NL')} tekens)</summary><pre class="scroll">${h(e.content)}</pre></details>` : `<div class="tl-body">${h(e.content)}</div>`) : ''}</li>`;
  }).join('')}</ol>`;
}

function checksTable(rows) {
  if (!rows.length) return '<p class="muted">Nog geen controles.</p>';
  return `<table class="table"><thead><tr><th>Ronde</th><th>Soort</th><th>Controle</th><th>Bestand</th><th>Status</th><th>Uitvoer</th></tr></thead><tbody>
  ${rows.map((c) => `<tr class="cat-${h(c.category)}"><td>${c.cycle + 1}</td><td><span class="cat">${h(CATEGORY_LABEL[c.category] || c.category)}</span></td><td>${h(c.name)}</td><td><code>${h(c.target || '')}</code></td><td>${badge(c.status)}</td>
    <td>${c.output ? `<details><summary>tonen</summary><pre class="scroll">${h(c.output)}</pre></details>` : ''}</td></tr>`).join('')}
  </tbody></table>`;
}

function filesSection(job, fileRows) {
  if (!fileRows.length) return '<p class="muted">Geen bestanden.</p>';
  const byPath = {};
  for (const f of fileRows) (byPath[`${f.origin}:${f.path}`] ||= []).push(f);
  return `<table class="table"><thead><tr><th>Bestand</th><th>Herkomst</th><th>Versies</th><th>Leesstatus</th><th></th></tr></thead><tbody>
  ${Object.values(byPath).map((vs) => {
    const last = vs[vs.length - 1];
    return `<tr><td><code>${h(last.path)}</code></td><td>${last.origin === 'upload' ? 'Invoer' : 'Claude'}</td>
      <td>${vs.map((v) => `<a href="/opdrachten/${job.id}/bestanden/${v.id}">v${v.version}</a>`).join(' ')}</td>
      <td><span class="read ${h(last.read_status)}">${h(last.read_status.replace('_', ' '))}</span>${last.read_note ? `<div class="muted small">${h(last.read_note)}</div>` : ''}</td>
      <td><a href="/opdrachten/${job.id}/bestanden/${last.id}/download">Download</a>${vs.length > 1 ? ` · <a href="/opdrachten/${job.id}/diff?pad=${encodeURIComponent(last.path)}&van=${vs[vs.length - 2].version}&naar=${last.version}">Wijzigingen</a>` : ''}</td></tr>`;
  }).join('')}</tbody></table>`;
}

export function jobPage(req, job, ctx) {
  const active = !['AFGEROND', 'GESTOPT', 'BEZIG', 'VERWERKEN', 'TESTS_BEZIG'].includes(job.state);
  const flash = ctx.flash || [];
  return layout(req, `Opdracht #${job.id}`, `
  <div class="page-head">
    <div><h1>#${job.id} ${h(job.title)}</h1>
      <div>${stateBadge(job)} ${badge(job.final_status)} <span class="muted small">${h(WORKFLOW_TYPES[job.workflow_type] || '')} · overdracht: ${h(job.handoff_mode)}${job.clone_of ? ` · kopie van <a href="/opdrachten/${job.clone_of}">#${job.clone_of}</a>` : ''}</span></div></div>
    <div class="toolbar">
      <a class="button" href="/opdrachten/${job.id}/rapport">Eindrapport bekijken</a>
      <a class="button" href="/opdrachten/nieuw?kopie=${job.id}">Opnieuw uitvoeren</a>
      ${active ? `<form method="post" action="/opdrachten/${job.id}/stoppen" class="inline" data-confirm="Opdracht stoppen? U kunt later hervatten.">${csrf(req)}<button>Stoppen</button></form>` : ''}
      ${['AFGEROND', 'GESTOPT'].includes(job.state) ? `<form method="post" action="/opdrachten/${job.id}/verwijderen" class="inline" data-confirm="Opdracht en alle bestanden definitief verwijderen?">${csrf(req)}<button class="danger">Verwijderen</button></form>` : ''}
    </div>
  </div>
  ${flash.map((f) => `<div class="flash ${h(f.type)}">${h(f.text)}</div>`).join('')}
  ${pipeline(job, ctx)}
  ${ctx.recentWarnings.map((w) => `<div class="flash warn">${h(w.title)}: ${h(w.content)}</div>`).join('')}
  ${actionPanel(req, job, ctx)}

  <section class="card"><h2>Oorspronkelijke opdracht</h2><pre class="wrap">${h(job.assignment)}</pre>
    ${job.acceptance_criteria ? `<h3>Acceptatiecriteria</h3><pre class="wrap">${h(job.acceptance_criteria)}</pre>` : ''}</section>

  <section class="card"><h2>Tests en controles</h2>
    <p class="muted small"><strong>Uitgevoerde test</strong> = code is daadwerkelijk gedraaid in de sandbox. <strong>Statische controle</strong> = alleen syntaxis/structuur. <strong>AI-beoordeling</strong> = oordeel van een taalmodel, geen test. <strong>Niet uitgevoerd</strong> = NIET GETEST.</p>
    ${checksTable(ctx.checks)}</section>

  ${ctx.issues.length ? `<section class="card"><h2>Verbeterpunten per ronde</h2><table class="table"><thead><tr><th>Ronde</th><th>Ernst</th><th>Beschrijving</th><th>Suggestie</th></tr></thead><tbody>
    ${ctx.issues.map((i) => `<tr><td>${i.cycle + 1}</td><td><span class="sev ${h(i.severity)}">${h(i.severity)}</span></td><td>${h(i.description)}</td><td>${h(i.suggestion || '')}</td></tr>`).join('')}</tbody></table></section>` : ''}

  <section class="card"><div class="page-head"><h2>Bestanden en versiegeschiedenis</h2>${ctx.hasGenerated ? `<a class="button" href="/opdrachten/${job.id}/bestanden.zip">Laatste versies als ZIP</a>` : ''}</div>
    ${filesSection(job, ctx.files)}</section>

  <section class="card"><h2>Volledige geschiedenis</h2>
    <p class="muted small">Alle prompts, exacte antwoorden, analyses, reviews, waarschuwingen en fouten, in volgorde.</p>
    ${timeline(ctx.events)}</section>`);
}

export function filePage(req, job, file, { content, versions, extract, previewable }) {
  return layout(req, file.path, `
  <p><a href="/opdrachten/${job.id}">← Opdracht #${job.id}</a></p>
  <div class="page-head"><h1><code>${h(file.path)}</code> v${file.version}</h1>
    <div class="toolbar"><a class="button" href="/opdrachten/${job.id}/bestanden/${file.id}/download">Downloaden</a>
    ${previewable ? `<a class="button" href="/opdrachten/${job.id}/bestanden/${file.id}/voorbeeld" target="_blank" rel="noopener">Voorbeeld (afgeschermd) ↗</a>` : ''}</div></div>
  <p class="muted">Herkomst: ${file.origin === 'upload' ? 'invoerbestand' : `Claude, ronde ${file.cycle + 1}`} · ${file.size} bytes · sha256 <code>${h(file.sha256)}</code></p>
  <p>Leesstatus: <span class="read ${h(file.read_status)}">${h(file.read_status.replace('_', ' '))}</span> ${h(file.read_note || '')}</p>
  <p>Versies: ${versions.map((v) => v.id === file.id ? `<strong>v${v.version}</strong>` : `<a href="/opdrachten/${job.id}/bestanden/${v.id}">v${v.version}</a>`).join(' · ')}
    ${versions.length > 1 ? ` · <a href="/opdrachten/${job.id}/diff?pad=${encodeURIComponent(file.path)}&van=${versions[0].version}&naar=${versions[versions.length - 1].version}">Wijzigingen eerste → laatste</a>` : ''}</p>
  ${content != null ? `<section class="card"><h2>Inhoud</h2><pre class="code">${h(content)}</pre></section>` : ''}
  ${extract != null ? `<section class="card"><h2>Geëxtraheerde tekst (zoals gebruikt in prompts)</h2><pre class="code">${h(extract)}</pre></section>` : ''}`);
}

export function diffPage(req, job, { path, from, to, diff, versions }) {
  return layout(req, `Wijzigingen ${path}`, `
  <p><a href="/opdrachten/${job.id}">← Opdracht #${job.id}</a></p>
  <h1>Wijzigingen in <code>${h(path)}</code></h1>
  <form method="get" class="filters"><input type="hidden" name="pad" value="${h(path)}">
    Van <select name="van">${versions.map((v) => `<option ${v.version === from ? 'selected' : ''}>${v.version}</option>`).join('')}</select>
    naar <select name="naar">${versions.map((v) => `<option ${v.version === to ? 'selected' : ''}>${v.version}</option>`).join('')}</select>
    <button>Tonen</button></form>
  ${diff.tooLarge ? '<p class="flash warn">Bestand te groot voor een regelvergelijking.</p>'
    : `<p class="muted">+${diff.added} / −${diff.removed} regels</p><pre class="diff">${diff.ops.map((o) => `<span class="d${o.t === '+' ? 'a' : o.t === '-' ? 'r' : 'e'}">${o.t === '=' ? ' ' : o.t} ${h(o.l)}</span>`).join('\n')}</pre>`}`);
}

export function reportPage(req, r, md) {
  const j = r.job;
  const checkList = (rows) => rows.length ? `<ul>${rows.map((c) => `<li>${badge(c.status)} ${h(c.name)} ${c.target ? `<code>${h(c.target)}</code>` : ''}</li>`).join('')}</ul>` : '<p class="muted">Geen.</p>';
  return layout(req, `Rapport #${j.id}`, `
  <p><a href="/opdrachten/${j.id}">← Opdracht #${j.id}</a></p>
  <div class="page-head"><h1>Eindrapport #${j.id}: ${h(j.title)}</h1><a class="button" href="/opdrachten/${j.id}/rapport.md">Download als Markdown</a></div>
  ${j.state !== 'AFGEROND' ? `<div class="flash warn">De opdracht is nog niet afgerond (${h(r.stateLabel)}). Dit is een tussenrapport.</div>` : ''}
  <section class="card summary">
    <div><span class="muted">Eindstatus</span>${badge(r.final.status)}</div>
    <div><span class="muted">Uitvoeringswijze</span>${h(r.automation)}</div>
    <div><span class="muted">Doorlooptijd</span>${h(r.duration)}</div>
    <div><span class="muted">Kosten</span>${h(r.cost)}</div>
    <div><span class="muted">Verbetercycli</span>${j.cycle} / ${j.max_cycles}</div>
    <div><span class="muted">AI-verzoeken</span>${j.request_count} / ${j.max_requests}</div>
  </section>
  <section class="card"><h2>Oorspronkelijke opdracht</h2><pre class="wrap">${h(j.assignment)}</pre></section>
  <section class="card"><h2>Uitvoeringsprompt (exact aan Claude aangeboden)</h2>${r.firstClaudePrompt ? `<details><summary>Tonen</summary><pre class="scroll">${h(r.firstClaudePrompt.content)}</pre></details>` : '<p class="muted">Nog niet gemaakt.</p>'}</section>
  <section class="card"><h2>Resultaat van Claude</h2>${r.lastClaudeAnswer ? `<details><summary>Laatste antwoord tonen</summary><pre class="scroll">${h(r.lastClaudeAnswer.content)}</pre></details>` : '<p class="muted">Geen resultaat.</p>'}</section>
  <section class="card"><h2>Controle door ChatGPT <small class="muted">(AI-beoordeling, géén test)</small></h2>
    ${r.reviews.length ? `<ul>${r.reviews.map((rv) => `<li>Ronde ${rv.cycle + 1}: <strong>${h(rv.meta?.verdict)}</strong> door ${h(rv.meta?.reviewer || 'ChatGPT')} — ${h(rv.content)}</li>`).join('')}</ul>` : '<p class="muted">Geen review.</p>'}</section>
  <section class="card"><h2>Tests (laatste ronde)</h2>
    <h3>Daadwerkelijk uitgevoerd</h3>${checkList(r.executed)}
    <h3>Statische controles (code niet uitgevoerd)</h3>${checkList(r.statics)}
    <h3>Niet uitgevoerd — NIET GETEST</h3>${checkList(r.notRun)}</section>
  <section class="card"><h2>Verbeteringen</h2>${r.improvements.length ? r.improvements.map((i) => `<h3>${h(i.title)}</h3><pre class="wrap">${h(i.content)}</pre>`).join('') : '<p class="muted">Geen verbetercycli.</p>'}</section>
  <section class="card"><h2>Eindstatus ${badge(r.final.status)}</h2><ul>${r.final.reasons.filter(Boolean).map((x) => `<li>${h(x)}</li>`).join('')}</ul></section>
  <section class="card"><h2>Openstaande punten</h2>${r.openIssues.length ? `<ul>${r.openIssues.map((i) => `<li><span class="sev ${h(i.severity)}">${h(i.severity)}</span> ${h(i.description)}</li>`).join('')}</ul>` : '<p class="muted">Geen geregistreerde openstaande punten.</p>'}</section>
  <section class="card"><h2>Bestanden</h2>
    <h3>Invoer</h3>${r.uploads.length ? `<ul>${r.uploads.map((f) => `<li><code>${h(f.path)}</code> — <span class="read ${h(f.read_status)}">${h(f.read_status)}</span> ${h(f.read_note || '')}</li>`).join('')}</ul>` : '<p class="muted">Geen.</p>'}
    <h3>Resultaat</h3>${r.latestFiles.length ? `<ul>${r.latestFiles.map((f) => `<li><a href="/opdrachten/${j.id}/bestanden/${f.id}"><code>${h(f.path)}</code></a> v${f.version}</li>`).join('')}</ul>` : '<p class="muted">Geen.</p>'}</section>
  <section class="card"><h2>Gebruikte modellen en methode</h2><ul>${r.models.map((m) => `<li>${h(m)}</li>`).join('') || '<li class="muted">Nog geen</li>'}</ul></section>
  ${r.warnings.length ? `<section class="card"><h2>Waarschuwingen en fouten</h2><ul>${r.warnings.map((w) => `<li>${h(w.title)}: ${h((w.content || '').split('\n')[0])}</li>`).join('')}</ul></section>` : ''}
  <details class="card"><summary>Rapport als Markdown</summary><pre class="scroll">${h(md)}</pre></details>`);
}

export function comparePage(req, a, b, rows) {
  const col = (r) => `<td>${badge(r.final.status)}<div class="small">${h(r.stateLabel)}</div></td>`;
  return layout(req, 'Vergelijken', `
  <h1>Vergelijking #${a.job.id} ↔ #${b.job.id}</h1>
  <table class="table"><thead><tr><th></th><th><a href="/opdrachten/${a.job.id}">#${a.job.id} ${h(a.job.title)}</a></th><th><a href="/opdrachten/${b.job.id}">#${b.job.id} ${h(b.job.title)}</a></th></tr></thead><tbody>
    <tr><th>Status</th>${col(a)}${col(b)}</tr>
    <tr><th>Uitvoeringswijze</th><td>${h(a.automation)}</td><td>${h(b.automation)}</td></tr>
    <tr><th>Verbetercycli</th><td>${a.job.cycle}</td><td>${b.job.cycle}</td></tr>
    <tr><th>AI-verzoeken</th><td>${a.job.request_count}</td><td>${b.job.request_count}</td></tr>
    <tr><th>Doorlooptijd</th><td>${h(a.duration)}</td><td>${h(b.duration)}</td></tr>
    <tr><th>Uitgevoerde tests</th><td>${a.executed.filter((c) => c.status === 'GESLAAGD').length}/${a.executed.length} geslaagd</td><td>${b.executed.filter((c) => c.status === 'GESLAAGD').length}/${b.executed.length} geslaagd</td></tr>
    <tr><th>Statische controles</th><td>${a.statics.filter((c) => c.status === 'GESLAAGD').length}/${a.statics.length} geslaagd</td><td>${b.statics.filter((c) => c.status === 'GESLAAGD').length}/${b.statics.length} geslaagd</td></tr>
    <tr><th>Openstaande punten</th><td>${a.openIssues.length}</td><td>${b.openIssues.length}</td></tr>
  </tbody></table>
  <section class="card"><h2>Bestanden</h2><table class="table"><thead><tr><th>Pad</th><th>A</th><th>B</th><th>Inhoud</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><code>${h(r.path)}</code></td><td>${r.a ? `v${r.a.version}` : '—'}</td><td>${r.b ? `v${r.b.version}` : '—'}</td><td>${r.a && r.b ? (r.a.sha256 === r.b.sha256 ? 'identiek' : `verschillend (+${r.diff?.added ?? '?'} / −${r.diff?.removed ?? '?'} regels)`) : 'alleen in één opdracht'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Geen gegenereerde bestanden.</td></tr>'}
  </tbody></table></section>`);
}

// ------------------------------------------------------------------ integraties en instellingen
const INTEGRATION_CLASS = {
  WERKEND: 'ok', GECONFIGUREERD: 'manual', CONFIGUREREN: 'partial', NIET_BESCHIKBAAR: 'fail', NIET_BEREIKBAAR: 'fail', HANDMATIG: 'neutral', OPTIONEEL: 'untested', UIT: 'untested',
};
const INTEGRATION_LABEL = {
  WERKEND: 'Beschikbaar en werkend', GECONFIGUREERD: 'Geconfigureerd, nog niet geverifieerd', CONFIGUREREN: 'Nog te configureren', NIET_BESCHIKBAAR: 'Niet beschikbaar',
  NIET_BEREIKBAAR: 'Niet bereikbaar', HANDMATIG: 'Handmatige overdracht vereist', OPTIONEEL: 'Optioneel met API-toegang', UIT: 'Uitgeschakeld (optioneel)',
};

export function integrationsPage(req, items) {
  return layout(req, 'Integraties', `
  <h1>Integraties</h1>
  <p class="muted">Overzicht van wat daadwerkelijk werkt. Er wordt nergens om API-sleutels gevraagd zolang u de API-route niet zelf activeert; sleutels worden uitsluitend via omgevingsvariabelen ingesteld.</p>
  <div class="integrations">${items.map((i) => `
    <section class="card integration">
      <div class="page-head"><h2>${h(i.name)}</h2><span class="badge ${INTEGRATION_CLASS[i.state] || 'neutral'}">${h(INTEGRATION_LABEL[i.state] || i.state)}</span></div>
      <p>${h(i.text)}</p>
      <dl>
        <dt>Wat werkt</dt><dd>${h(i.works)}</dd>
        <dt>Configuratie</dt><dd>${h(i.config)}</dd>
        <dt>Beperkingen</dt><dd>${h(i.limits)}</dd>
        <dt>Extra kosten</dt><dd>${h(i.cost)}</dd>
      </dl>
    </section>`).join('')}</div>`);
}

export function settingsPage(req, { s, errors, storage, saved }) {
  const num = (k, label, extra = '') => `<label>${label}<input name="${k}" value="${h(s[k] ?? '')}" ${extra}></label>`;
  const chk = (k, label) => `<label class="check"><input type="checkbox" name="${k}" ${s[k] ? 'checked' : ''}> ${label}</label>`;
  const sel = (k, label, opts) => `<label>${label}<select name="${k}">${opts.map(([v, l]) => `<option value="${v}" ${s[k] === v ? 'selected' : ''}>${h(l)}</option>`).join('')}</select></label>`;
  return layout(req, 'Instellingen', `
  <h1>Instellingen</h1>
  ${saved ? '<div class="flash ok">Instellingen opgeslagen.</div>' : ''}
  ${errors.map((e) => `<div class="flash error">${h(e)}</div>`).join('')}
  <form method="post" action="/instellingen">${csrf(req)}
  <section class="card"><h2>Workflow en limieten</h2>
    <div class="row">${num('max_cycles', 'Max. verbetercycli (standaard)', 'type="number" min="0" max="10"')}${num('max_requests', 'Max. AI-verzoeken per opdracht', 'type="number" min="1"')}${num('prompt_warn_chars', 'Waarschuwen bij prompts langer dan (tekens)', 'type="number" min="1000"')}</div>
    <div class="row">${sel('workflow_mode', 'Workflowmodus', [['handmatig', 'Handmatig (iedere stap bevestigen)'], ['automatisch', 'Automatisch (alleen met API)']])}
    ${sel('default_handoff', 'Standaard overdrachtsmethode', [['handmatig', 'Handmatig (kopiëren/plakken)'], ['api', 'API']])}</div>
  </section>
  <section class="card"><h2>Lokale AI (Ollama) — optioneel</h2>
    <p class="muted">Ollama-adres (omgevingsvariabele OLLAMA_URL): <code>${h(config.ollamaUrl)}</code>. Lokale AI maakt alleen een conceptprompt; de review blijft bij ChatGPT.</p>
    ${chk('ollama_enabled', 'Lokale AI inschakelen')}
    <div class="row">${num('ollama_model', 'Model (bijv. qwen3.5:4b)')}${num('ollama_timeout_sec', 'Time-out (seconden)', 'type="number" min="10"')}</div>
  </section>
  <section class="card"><h2>API-integraties — optioneel, standaard uit</h2>
    <p class="flash warn">Een ChatGPT- of Claude-abonnement geeft geen API-toegang. API-gebruik vereist aparte betaalde accounts en kost geld per verzoek. Sleutels zet u via de omgevingsvariabelen OPENAI_API_KEY en ANTHROPIC_API_KEY, nooit via deze pagina.</p>
    ${chk('api_enabled', 'API-integraties toestaan')}
    <p class="muted">Sleutels aanwezig: OpenAI ${config.openaiApiKey ? 'ja' : 'nee'}, Anthropic ${config.anthropicApiKey ? 'ja' : 'nee'}.</p>
    <div class="row">${num('openai_model', 'OpenAI-model')}${num('anthropic_model', 'Anthropic-model (bijv. claude-sonnet-5-5)')}${num('anthropic_max_tokens', 'Anthropic max. uitvoertokens', 'type="number" min="256"')}</div>
    <div class="row">${num('cost_budget_eur', 'Kostenbudget per opdracht (EUR, leeg = geen)')}</div>
    <div class="row">${num('openai_price_in', 'OpenAI prijs invoer (EUR / 1M tokens)')}${num('openai_price_out', 'OpenAI prijs uitvoer')}${num('anthropic_price_in', 'Anthropic prijs invoer')}${num('anthropic_price_out', 'Anthropic prijs uitvoer')}</div>
    <p class="muted small">Zonder prijzen worden kosten als "onbekend" getoond; de applicatie verzint geen tarieven.</p>
  </section>
  <section class="card"><h2>Testomgeving</h2>
    ${chk('sandbox_enabled', 'Sandbox-container gebruiken voor het uitvoeren van tests')}
    <p class="muted">Sandbox-map: <code>${h(config.sandboxDir)}</code>, time-out ${config.sandboxTimeoutSec} s (SANDBOX_TIMEOUT_SEC).</p>
  </section>
  <section class="card"><h2>Logboek</h2>
    <div class="row">${sel('log_level', 'Logniveau', [['debug', 'debug'], ['info', 'info'], ['warn', 'warn'], ['error', 'error']])}</div>
    ${chk('log_to_file', 'Ook naar bestand schrijven (data/logs/app.log)')}
    <p class="muted small">Logs bevatten nooit prompt- of antwoordinhoud; sleutels en wachtwoorden worden gemaskeerd.</p>
  </section>
  <section class="card"><h2>Bestandsopslag</h2>
    <p>Datamap: <code>${h(config.dataDir)}</code> — ${h(storage)}</p>
    <p class="muted">Max. uploadgrootte ${config.maxUploadMb} MB per bestand, ${config.maxUploadFiles} bestanden per opdracht (MAX_UPLOAD_MB, MAX_UPLOAD_FILES). Structuur: <code>jobs/&lt;id&gt;/uploads</code>, <code>jobs/&lt;id&gt;/resultaat/ronde-N</code>, <code>jobs/&lt;id&gt;/extract</code>.</p>
  </section>
  <button class="primary">Opslaan</button>
  </form>
  <section class="card"><h2>Wachtwoord wijzigen</h2>
    <form method="post" action="/wachtwoord" class="row">${csrf(req)}
      <label>Huidig wachtwoord<input type="password" name="current" required autocomplete="current-password"></label>
      <label>Nieuw wachtwoord (min. 12)<input type="password" name="new" minlength="12" required autocomplete="new-password"></label>
      <button>Wijzigen</button></form></section>`);
}

export function errorPage(req, status, message) {
  return layout(req, 'Fout', `<section class="card narrow"><h1>${status === 404 ? 'Niet gevonden' : 'Er ging iets mis'}</h1><p>${h(message)}</p><p><a href="/">Terug naar dashboard</a></p></section>`);
}
