// End-to-end test van de volledige workflow via HTTP, inclusief de echte sandbox-worker.
// LET OP: de "AI-antwoorden" hieronder zijn TESTGEGEVENS die de verwerking door de applicatie
// testen. Ze bewijzen niet dat ChatGPT of Claude zelf werken; die stappen zijn handmatig.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-e2e-'));
process.env.DATA_DIR = dataDir;
process.env.APP_ENV = 'test';
process.env.ADMIN_USER = 'tester';
process.env.ADMIN_PASSWORD = 'test-wachtwoord-123';
process.env.SANDBOX_TIMEOUT_SEC = '60';

const { init, createApp } = await import('../src/server.js');
const wf = await import('../src/workflow.js');
const db = await import('../src/db.js');

let server;
let poller;
let base;
let worker;
let cookie = '';

async function req(method, url, { body, form, redirect = 'manual' } = {}) {
  const headers = { cookie };
  let payload;
  if (form) payload = form;
  else if (body) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
  const res = await fetch(base + url, { method, headers, body: payload, redirect });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, location: res.headers.get('location'), text: await res.text(), headers: res.headers };
}

const csrfOf = (html) => html.match(/name="_csrf" value="([^"]+)"/)[1];
const tokenOf = (html) => html.match(/name="token" value="([^"]+)"/)[1];
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

async function waitForState(id, wanted, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const j = db.jobs.get(id);
    if (wanted.includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`time-out: toestand ${db.jobs.get(id).state}, verwacht ${wanted}`);
}

before(async () => {
  init();
  poller = wf.startPoller();
  worker = spawn(process.execPath, [path.join(root, 'sandbox', 'worker.mjs')], {
    env: { ...process.env, SANDBOX_DIR: path.join(dataDir, 'sandbox-jobs') }, stdio: 'ignore',
  });
  // wacht op de heartbeat van de worker
  const hb = path.join(dataDir, 'sandbox-jobs', 'heartbeat.json');
  for (let i = 0; i < 60 && !fs.existsSync(hb); i++) await new Promise((r) => setTimeout(r, 250));
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  worker?.kill();
  clearInterval(poller);
});

// ---------------------------------------------------------------- testgegevens
const CHATGPT_ANALYSE = `Hier is mijn analyse.
===ANALYSE===
Eenvoudige statische pagina; geen backend nodig.
===EINDE ANALYSE===
===ACCEPTATIECRITERIA===
- Invoerveld, knop en resultatenveld aanwezig
- Klik op de knop toont de invoer in het resultatenveld
===EINDE ACCEPTATIECRITERIA===
===PROMPT VOOR CLAUDE===
Maak index.html met een invoerveld (id invoer), een knop (id knop) en een resultatenveld (id resultaat). Lever ook een test.
===EINDE PROMPT VOOR CLAUDE===`;

const CLAUDE_V1 = `Hier is de pagina.

### BESTAND: index.html
\`\`\`html
<!DOCTYPE html>
<html lang="nl"><head><meta charset="utf-8"><title>Demo</title></head>
<body>
  <input id="invoer"><button id="knop">Toon</button><div id="uitvoer"></div>
  <script>
    document.getElementById('knop').addEventListener('click', function () {
      document.getElementById('resultaat').textContent = document.getElementById('invoer').value;
    });
  </script>
</body></html>
\`\`\`

### BESTAND: logic.mjs
\`\`\`js
export function toon(v) { return String(v).trim(); }
\`\`\`

### BESTAND: logic.test.mjs
\`\`\`js
import { test } from 'node:test';
import assert from 'node:assert';
import { toon } from './logic.mjs';
test('trim', () => assert.equal(toon('  a '), 'a'));
\`\`\`

### TESTEN
Alles werkt en is getest.
### BEPERKINGEN
Geen.`;

const REVIEW_AFGEKEURD = `De pagina verwijst naar id "resultaat" maar het element heet "uitvoer".
===REVIEW JSON===
{"oordeel":"AFGEKEURD","samenvatting":"Id-fout.","criteria":[{"criterium":"Resultatenveld","status":"NIET VOLDAAN","toelichting":"id klopt niet"}],"problemen":[{"ernst":"hoog","beschrijving":"Script verwijst naar #resultaat dat niet bestaat","suggestie":"Hernoem div naar resultaat"}]}
===EINDE REVIEW JSON===`;

const CLAUDE_V2 = CLAUDE_V1.replace('<div id="uitvoer">', '<div id="resultaat">') + '\n### WIJZIGINGEN\n1. id hernoemd.';

const REVIEW_GOED = `Nu correct.
===REVIEW JSON===
{"oordeel":"GOEDGEKEURD","samenvatting":"Voldoet.","criteria":[{"criterium":"Resultatenveld","status":"VOLDAAN","toelichting":""}],"problemen":[]}
===EINDE REVIEW JSON===`;

// ---------------------------------------------------------------- tests
let jobId;

test('niet ingelogd wordt doorgestuurd naar login', async () => {
  const r = await req('GET', '/');
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/login/);
});

test('verkeerd wachtwoord wordt geweigerd, juist wachtwoord logt in', async () => {
  assert.equal((await req('POST', '/login', { body: { username: 'tester', password: 'fout' } })).status, 401);
  const r = await req('POST', '/login', { body: { username: 'tester', password: 'test-wachtwoord-123' } });
  assert.equal(r.status, 302);
  assert.match(cookie, /aca_sid=/);
  const dash = await req('GET', '/');
  assert.equal(dash.status, 200);
  assert.match(dash.text, /Dashboard/);
  assert.match(dash.headers.get('content-security-policy'), /default-src 'self'/);
});

test('POST zonder CSRF-token wordt geweigerd', async () => {
  const r = await req('POST', '/instellingen', { body: { max_cycles: '3' } });
  assert.equal(r.status, 403);
});

test('1-2. opdracht met upload wordt opgeslagen en analyseprompt gemaakt', async () => {
  const page = await req('GET', '/opdrachten/nieuw');
  const form = new FormData();
  form.append('_csrf', csrfOf(page.text));
  form.append('title', 'HTML-pagina met invoerveld');
  form.append('assignment', 'Maak een kleine HTML-webpagina met een invoerveld, een knop en een resultatenveld.');
  form.append('acceptance_criteria', '- Werkt zonder internet');
  form.append('workflow_type', 'software');
  form.append('variant', 'volledig');
  form.append('handoff_mode', 'handmatig');
  form.append('max_cycles', '3');
  form.append('max_requests', '20');
  form.append('files', new Blob(['Huisstijl: blauw (#2457c5).']), 'huisstijl.txt');
  form.append('files', new Blob(['MZ binary']), 'virus.exe');
  const bad = await req('POST', '/opdrachten', { form });
  assert.equal(bad.status, 400, 'niet-toegestaan bestandstype moet worden geweigerd');
  assert.match(bad.text, /virus\.exe: bestandstype niet toegestaan/);

  const form2 = new FormData();
  for (const [k, v] of form.entries()) if (!(k === 'files' && v.name === 'virus.exe')) form2.append(k, v);
  const r = await req('POST', '/opdrachten', { form: form2 });
  assert.equal(r.status, 302);
  jobId = Number(r.location.split('/').pop());
  const job = db.jobs.get(jobId);
  assert.equal(job.state, 'WACHT_ANALYSE');
  const up = db.files.uploads(jobId);
  assert.equal(up.length, 1);
  assert.equal(up[0].read_status, 'GELEZEN');
  const detail = await req('GET', `/opdrachten/${jobId}`);
  assert.match(detail.text, /Prompt kopiëren/);
  assert.match(detail.text, /ChatGPT openen/);
  assert.match(unescape(detail.text), /Huisstijl: blauw/, 'bestandsinhoud moet in de prompt staan');
  assert.match(unescape(detail.text), /===PROMPT VOOR CLAUDE===/);
});

test('3. ChatGPT-analyse importeren levert de Claude-prompt op; dubbel versturen wordt geweigerd', async () => {
  const page = await req('GET', `/opdrachten/${jobId}`);
  const body = { _csrf: csrfOf(page.text), token: tokenOf(page.text), answer: CHATGPT_ANALYSE, model: 'ChatGPT test' };
  const r = await req('POST', `/opdrachten/${jobId}/analyse`, { body });
  assert.equal(r.status, 302);
  const again = await req('POST', `/opdrachten/${jobId}/analyse`, { body });
  assert.equal(again.status, 409);
  assert.match(again.text, /al verwerkt/);
  const job = db.jobs.get(jobId);
  assert.equal(job.state, 'WACHT_CLAUDE');
  assert.equal(job.request_count, 1);
  const prompt = wf.currentPrompt(job);
  assert.match(prompt.content, /^Maak index\.html/);
  assert.match(prompt.content, /### BESTAND: relatief\/pad/, 'vast uitvoerformaat toegevoegd');
  assert.match(prompt.content, /Huisstijl: blauw/, 'invoerbestanden toegevoegd');
  assert.match(job.acceptance_criteria, /Klik op de knop/);
});

test('4-5. Claude-resultaat: bestanden opgeslagen, echte tests in sandbox, reviewprompt met feitelijke resultaten', async () => {
  const page = await req('GET', `/opdrachten/${jobId}`);
  const r = await req('POST', `/opdrachten/${jobId}/claude`, { body: { _csrf: csrfOf(page.text), token: tokenOf(page.text), answer: CLAUDE_V1 } });
  assert.equal(r.status, 302);
  const job = await waitForState(jobId, ['WACHT_REVIEW']);
  assert.deepEqual(db.files.inCycle(jobId, 0).map((f) => f.path), ['index.html', 'logic.mjs', 'logic.test.mjs']);
  const checks = db.checks.forCycle(jobId, 0);
  const by = (n) => checks.filter((c) => c.name.startsWith(n));
  assert.equal(by('HTML-structuur')[0].status, 'MISLUKT', 'id-fout moet statisch gevonden worden');
  assert.equal(by('Unit tests (node --test)')[0].category, 'UITGEVOERDE_TEST');
  assert.equal(by('Unit tests (node --test)')[0].status, 'GESLAAGD');
  assert.equal(by('JavaScript-syntaxis (inline')[0].status, 'GESLAAGD');
  assert.equal(by('Functionele browsertest')[0].status, 'NIET GETEST');
  const review = wf.currentPrompt(job);
  assert.match(review.content, /DAADWERKELIJK UITGEVOERDE TEST/);
  assert.match(review.content, /niet-bestaande id's: resultaat/);
  assert.match(review.content, /Claims van Claude dat iets "werkt"/);
});

test('6. afgekeurde review leidt tot verbeterprompt (cyclus 1)', async () => {
  const page = await req('GET', `/opdrachten/${jobId}`);
  await req('POST', `/opdrachten/${jobId}/review`, { body: { _csrf: csrfOf(page.text), token: tokenOf(page.text), answer: REVIEW_AFGEKEURD } });
  const job = db.jobs.get(jobId);
  assert.equal(job.state, 'WACHT_CLAUDE');
  assert.equal(job.cycle, 1);
  const p = wf.currentPrompt(job);
  assert.equal(p.meta.purpose, 'verbetering');
  assert.match(p.content, /Script verwijst naar #resultaat/);
  assert.match(p.content, /### BESTAND: index\.html \(versie 1\)/);
  assert.equal(db.issues.forJob(jobId).length, 1);
});

test('7. verbeterde versie wordt opnieuw getest en beoordeeld; eindstatus GESLAAGD', async () => {
  let page = await req('GET', `/opdrachten/${jobId}`);
  await req('POST', `/opdrachten/${jobId}/claude`, { body: { _csrf: csrfOf(page.text), token: tokenOf(page.text), answer: CLAUDE_V2 } });
  await waitForState(jobId, ['WACHT_REVIEW']);
  const html = db.checks.forCycle(jobId, 1).find((c) => c.name.startsWith('HTML-structuur'));
  assert.equal(html.status, 'GESLAAGD');
  page = await req('GET', `/opdrachten/${jobId}`);
  await req('POST', `/opdrachten/${jobId}/review`, { body: { _csrf: csrfOf(page.text), token: tokenOf(page.text), answer: REVIEW_GOED } });
  const job = db.jobs.get(jobId);
  assert.equal(job.state, 'AFGEROND');
  assert.equal(job.final_status, 'GESLAAGD');
  assert.equal(job.request_count, 5);
});

test('8. eindrapport scheidt AI-beoordeling van uitgevoerde tests; versies en diff beschikbaar', async () => {
  const md = await req('GET', `/opdrachten/${jobId}/rapport.md`);
  assert.equal(md.status, 200);
  for (const s of ['## Oorspronkelijke opdracht', '## Uitvoeringsprompt', '## Controle door ChatGPT (AI-beoordeling, geen test)', '### Daadwerkelijk uitgevoerde tests', '### Niet uitgevoerd (NIET GETEST)', '## Verbeteringen', '## Openstaande punten', '## Bestanden', '## Kosten', 'Handmatige overdracht']) {
    assert.ok(md.text.includes(s), `rapport mist: ${s}`);
  }
  assert.match(md.text, /\[GESLAAGD\] Unit tests \(node --test\)/);
  assert.match(md.text, /\[NIET GETEST\] Functionele browsertest/);
  const versions = db.files.versions(jobId, 'index.html');
  assert.equal(versions.length, 2);
  const diff = await req('GET', `/opdrachten/${jobId}/diff?pad=index.html&van=1&naar=2`);
  assert.match(diff.text, /\+1 \/ −1 regels/);
  const zip = await req('GET', `/opdrachten/${jobId}/bestanden.zip`);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  const pv = await req('GET', `/opdrachten/${jobId}/bestanden/${versions[1].id}/voorbeeld`);
  assert.match(pv.headers.get('content-security-policy'), /^sandbox allow-scripts/);
});

test('zonder test: AI-goedkeuring geeft HANDMATIGE CONTROLE VEREIST, niet GESLAAGD', async () => {
  const id = wf.createJob({ title: 'Analyse', assignment: 'Vat het contract samen', workflow_type: 'document', variant: 'direct', handoff_mode: 'handmatig', max_cycles: 1, max_requests: 10 });
  wf.startJob(id);
  let j = db.jobs.get(id);
  wf.importClaude(id, j.pending_token, 'Samenvatting: het contract loopt 2 jaar.', { method: 'handmatig' });
  j = await waitForState(id, ['WACHT_REVIEW']);
  assert.equal(db.checks.forCycle(id, 0)[0].status, 'NIET GETEST');
  wf.importReview(id, j.pending_token, REVIEW_GOED, { method: 'handmatig' });
  j = db.jobs.get(id);
  assert.equal(j.final_status, 'HANDMATIGE CONTROLE VEREIST');
});

test('onleesbare review vraagt om beslissing; maximum cycli wordt gerespecteerd', async () => {
  const id = wf.createJob({ title: 'X', assignment: 'Y', workflow_type: 'algemeen', variant: 'direct', handoff_mode: 'handmatig', max_cycles: 0, max_requests: 10 });
  wf.startJob(id);
  let j = db.jobs.get(id);
  wf.importClaude(id, j.pending_token, 'Antwoord zonder bestanden', { method: 'handmatig' });
  j = await waitForState(id, ['WACHT_REVIEW']);
  wf.importReview(id, j.pending_token, 'Ik vind het wel goed zo.', { method: 'handmatig' });
  j = db.jobs.get(id);
  assert.equal(j.state, 'WACHT_BESLISSING');
  assert.throws(() => wf.decide(id, j.pending_token, 'verbeteren', ''), /Maximum aantal verbetercycli/);
  j = db.jobs.get(id);
  wf.decide(id, j.pending_token, 'afronden', '');
  assert.equal(db.jobs.get(id).state, 'AFGEROND');
  assert.equal(db.jobs.get(id).final_status, 'NIET GETEST');
});

test('verduidelijkingsvragen worden beantwoord en leveren een nieuwe analyseprompt', () => {
  const id = wf.createJob({ title: 'Docker', assignment: 'Maak een container', workflow_type: 'software', variant: 'volledig', handoff_mode: 'handmatig', max_cycles: 1, max_requests: 10 });
  wf.startJob(id);
  let j = db.jobs.get(id);
  wf.importAnalysis(id, j.pending_token, '===VERDUIDELIJKING NODIG===\n1. Welke applicatie?\n===EINDE VERDUIDELIJKING===', { method: 'handmatig' });
  j = db.jobs.get(id);
  assert.equal(j.state, 'WACHT_VERDUIDELIJKING');
  wf.answerClarification(id, j.pending_token, 'Een Nginx-webserver');
  j = db.jobs.get(id);
  assert.equal(j.state, 'WACHT_ANALYSE');
  assert.match(wf.currentPrompt(j).content, /Een Nginx-webserver/);
});

test('maximum aantal AI-verzoeken stopt de workflow met waarschuwing', () => {
  const id = wf.createJob({ title: 'Limiet', assignment: 'Iets', workflow_type: 'algemeen', variant: 'direct', handoff_mode: 'handmatig', max_cycles: 3, max_requests: 1 });
  wf.startJob(id);
  const j = db.jobs.get(id);
  wf.importClaude(id, j.pending_token, 'antwoord', { method: 'handmatig' });
  return waitForState(id, ['AFGEROND']).then((done) => {
    assert.ok(db.events.forJob(id).some((e) => e.kind === 'waarschuwing' && /maximum van 1 AI-verzoeken/.test(e.content)));
    assert.equal(done.final_status, 'NIET GETEST');
  });
});

test('stoppen en hervatten', () => {
  const id = wf.createJob({ title: 'Stop', assignment: 'Iets', workflow_type: 'algemeen', variant: 'volledig', handoff_mode: 'handmatig', max_cycles: 1, max_requests: 5 });
  wf.startJob(id);
  wf.stopJob(id);
  assert.equal(db.jobs.get(id).state, 'GESTOPT');
  wf.resumeJob(id);
  assert.equal(db.jobs.get(id).state, 'WACHT_ANALYSE');
});

test('onderbroken verwerking wordt na herstart hersteld; gegevens blijven bewaard', () => {
  const id = wf.createJob({ title: 'Crash', assignment: 'Iets', workflow_type: 'algemeen', variant: 'volledig', handoff_mode: 'handmatig', max_cycles: 1, max_requests: 5 });
  wf.startJob(id);
  db.jobs.update(id, { state: 'VERWERKEN', prev_state: 'WACHT_ANALYSE' }); // simuleer crash midden in een stap
  db.closeDb();
  db.openDb(); // "herstart"
  assert.equal(db.jobs.get(jobId).final_status, 'GESLAAGD', 'eerdere opdracht nog aanwezig');
  wf.recoverInterrupted();
  const j = db.jobs.get(id);
  assert.equal(j.state, 'WACHT_ANALYSE');
  assert.ok(db.events.forJob(id).some((e) => e.title === 'Onderbroken verwerking hersteld'));
});

test('opnieuw uitvoeren kopieert opdracht en invoerbestanden', async () => {
  const page = await req('GET', `/opdrachten/nieuw?kopie=${jobId}`);
  assert.match(page.text, /Kopie van opdracht #/);
  const form = new FormData();
  form.append('_csrf', csrfOf(page.text));
  for (const k of ['title', 'assignment']) form.append(k, unescape(page.text.match(new RegExp(k === 'title' ? 'name="title"[^>]*value="([^"]*)"' : '<textarea name="assignment"[^>]*>([^<]*)<'))[1]));
  form.append('workflow_type', 'software');
  form.append('variant', 'volledig');
  form.append('handoff_mode', 'handmatig');
  form.append('clone_of', String(jobId));
  const r = await req('POST', '/opdrachten', { form });
  assert.equal(r.status, 302);
  const newId = Number(r.location.split('/').pop());
  assert.equal(db.jobs.get(newId).clone_of, jobId);
  assert.deepEqual(db.files.uploads(newId).map((f) => f.path), ['huisstijl.txt']);
  const cmp = await req('GET', `/vergelijk?a=${jobId}&b=${newId}`);
  assert.equal(cmp.status, 200);
});

test('pagina\'s renderen zonder fouten', async () => {
  for (const p of ['/', '/opdrachten', '/integraties', '/instellingen', `/opdrachten/${jobId}/rapport`, `/opdrachten/${jobId}/bestanden/${db.files.uploads(jobId)[0].id}`]) {
    const r = await req('GET', p);
    assert.equal(r.status, 200, p);
  }
  const integ = await req('GET', '/integraties');
  assert.match(integ.text, /Browserautomatisering/);
  assert.match(integ.text, /Niet beschikbaar/);
  assert.match(integ.text, /Optioneel met API-toegang/);
});
