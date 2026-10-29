// Controles op gegenereerde bestanden. Drie soorten, strikt gescheiden:
//  STATISCH          – inhoud geparsed/geanalyseerd, code NIET uitgevoerd
//  UITGEVOERDE_TEST  – een test is daadwerkelijk uitgevoerd in de sandbox
//  NIET_UITGEVOERD   – een relevante test kon niet worden uitgevoerd (status NIET GETEST)
// Onbetrouwbare code wordt nooit in het app-proces uitgevoerd, alleen in de sandbox-container.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';
import { config } from './config.js';
import { checks as checksRepo, sandboxRuns } from './db.js';
import { extOf, readStored } from './files.js';
import { getSettings } from './settings.js';
import { log } from './log.js';

export const STATUS = {
  OK: 'GESLAAGD',
  PARTIAL: 'GEDEELTELIJK GESLAAGD',
  FAIL: 'MISLUKT',
  UNTESTED: 'NIET GETEST',
  MANUAL: 'HANDMATIGE CONTROLE VEREIST',
};

// ---- sandbox-status op basis van de heartbeat die de worker schrijft ----
export function sandboxStatus() {
  const s = getSettings();
  if (!s.sandbox_enabled) return { available: false, reason: 'Uitgeschakeld in instellingen.' };
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(config.sandboxDir, 'heartbeat.json'), 'utf8'));
    const age = (Date.now() - Date.parse(hb.time)) / 1000;
    if (!(age < 30)) return { available: false, reason: `Geen recente heartbeat van de sandbox (${Math.round(age)} s oud). Draait de sandbox-container?`, hb };
    // Alleen "geïsoleerd" als de worker zelf heeft vastgesteld dat er geen netwerk is én tests als aparte gebruiker draaien.
    const isolated = hb.isolation?.network === false && hb.isolation?.runnerUid != null;
    return { available: true, isolated, hb };
  } catch {
    return { available: false, reason: 'Sandbox-container niet gevonden (geen heartbeat).' };
  }
}

export function capabilitiesText() {
  const sb = sandboxStatus();
  const lines = [
    '- Statische controles door de applicatie: JSON- en YAML-syntaxis, structuur van Docker Compose-bestanden, HTML-structuur en verwijzingen naar element-ID\'s, aanwezigheid van FROM in Dockerfiles.',
  ];
  if (sb.available) {
    const t = sb.hb.tools || {};
    const avail = Object.entries(t).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ');
    const iso = sb.isolated ? 'Geïsoleerde sandbox ZONDER netwerktoegang' : 'Sandbox (let op: niet volledig geïsoleerd)';
    lines.push(`- ${iso} (${avail || 'geen hulpmiddelen gemeld'}): syntaxcontrole (node --check, python -m py_compile, bash -n) en het uitvoeren van meegeleverde tests: Python-bestanden test_*.py / *_test.py met pytest, JavaScript-bestanden *.test.js / *.test.mjs met "node --test". Tests mogen geen netwerk, extra pakketten of Docker nodig hebben.`);
  } else {
    lines.push(`- Er is momenteel GEEN sandbox beschikbaar (${sb.reason}); code wordt niet uitgevoerd.`);
  }
  lines.push('- Niet beschikbaar: browser-/UI-tests, Docker (geen "docker compose config", geen containers starten), TypeScript-compilatie, installatie van pakketten, internettoegang, CAD-geometrieberekeningen.');
  return lines.join('\n');
}

// ---- statische controles (veilig: alleen parsen) ----
function checkJson(text) {
  try { JSON.parse(text); return [STATUS.OK, 'Geldige JSON.']; } catch (e) { return [STATUS.FAIL, e.message]; }
}

function checkYaml(text) {
  try {
    const docs = YAML.parseAllDocuments(text, { maxAliasCount: 100 });
    const errs = docs.flatMap((d) => d.errors.map((e) => e.message));
    if (errs.length) return [STATUS.FAIL, errs.join('\n')];
    return [STATUS.OK, `Geldige YAML (${docs.length} document(en)).`];
  } catch (e) {
    return [STATUS.FAIL, e.message];
  }
}

export function isComposeFile(p) {
  return /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(p);
}

function checkCompose(text) {
  let doc;
  try { doc = YAML.parse(text, { maxAliasCount: 100 }); } catch (e) { return [STATUS.FAIL, e.message]; }
  const problems = [];
  if (!doc || typeof doc !== 'object' || !doc.services || typeof doc.services !== 'object') {
    return [STATUS.FAIL, 'Geen "services"-sectie gevonden.'];
  }
  for (const [name, svc] of Object.entries(doc.services)) {
    if (!svc || typeof svc !== 'object') { problems.push(`${name}: geen geldige service-definitie`); continue; }
    if (!svc.image && !svc.build) problems.push(`${name}: "image" of "build" ontbreekt`);
    for (const p of svc.ports || []) {
      const s = typeof p === 'object' ? String(p.target ?? '') : String(p);
      if (!/^[\d.:\-\/a-z$\{\}_A-Z]+$/.test(s)) problems.push(`${name}: poortnotatie "${s}" niet herkend`);
    }
    for (const v of svc.volumes || []) {
      const s = typeof v === 'object' ? v.source : String(v).split(':')[0];
      if (s && !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('$') && !s.startsWith('~') && !(doc.volumes && s in doc.volumes)) {
        problems.push(`${name}: benoemd volume "${s}" niet gedeclareerd onder top-level "volumes"`);
      }
    }
    for (const dep of Array.isArray(svc.depends_on) ? svc.depends_on : Object.keys(svc.depends_on || {})) {
      if (!(dep in doc.services)) problems.push(`${name}: depends_on verwijst naar onbekende service "${dep}"`);
    }
  }
  return problems.length ? [STATUS.FAIL, problems.join('\n')] : [STATUS.OK, `Structuur in orde (${Object.keys(doc.services).length} service(s)).`];
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

export function checkHtml(text) {
  const problems = [];
  const notes = [];
  if (!/^\s*<!doctype html>/i.test(text)) problems.push('<!DOCTYPE html> ontbreekt aan het begin.');
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, (m, t) => `<${t}></${t}>`);
  const stack = [];
  for (const m of stripped.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g)) {
    const tag = m[1].toLowerCase();
    const closing = m[0].startsWith('</');
    if (VOID.has(tag) || m[2] === '/') continue;
    if (!closing) { stack.push(tag); continue; }
    const idx = stack.lastIndexOf(tag);
    if (idx < 0) { problems.push(`Sluittag </${tag}> zonder openingstag.`); continue; }
    const unclosed = stack.splice(idx);
    unclosed.shift();
    // <p> en <li> mogen impliciet sluiten
    for (const u of unclosed) if (!['p', 'li', 'td', 'tr', 'th', 'option'].includes(u)) problems.push(`<${u}> niet afgesloten vóór </${tag}>.`);
  }
  for (const u of stack) if (!['p', 'li', 'td', 'tr', 'th', 'option', 'html', 'body', 'head'].includes(u)) problems.push(`<${u}> niet afgesloten.`);
  const ids = new Set([...text.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
  const dup = [...text.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) !== i);
  if (dup.length) problems.push(`Dubbele id's: ${[...new Set(dup)].join(', ')}`);
  const scripts = [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const refs = new Set();
  for (const [, , body] of scripts) {
    for (const m of body.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) refs.add(m[1]);
    for (const m of body.matchAll(/querySelector(?:All)?\(\s*["']#([A-Za-z][\w-]*)["']\s*\)/g)) refs.add(m[1]);
  }
  const missing = [...refs].filter((r) => !ids.has(r));
  if (missing.length) problems.push(`Script verwijst naar niet-bestaande id's: ${missing.join(', ')}`);
  notes.push(`${ids.size} element-id('s), ${scripts.length} script-blok(ken), ${refs.size} id-verwijzing(en) vanuit scripts gecontroleerd.`);
  return { status: problems.length ? STATUS.FAIL : STATUS.OK, output: [...problems, ...notes].join('\n'), inlineScripts: scripts.filter(([, attrs, body]) => !/\bsrc\s*=/.test(attrs) && !/type\s*=\s*["'](?!text\/javascript|module)/i.test(attrs) && body.trim()).map(([, attrs, body]) => ({ body, module: /type\s*=\s*["']module/i.test(attrs) })) };
}

function checkDockerfile(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!lines.length || !/^(FROM|ARG)\b/i.test(lines[0])) return [STATUS.FAIL, 'Eerste instructie is geen FROM (of ARG).'];
  if (!lines.some((l) => /^FROM\b/i.test(l))) return [STATUS.FAIL, 'Geen FROM-instructie gevonden.'];
  const notes = [];
  if (!lines.some((l) => /^USER\b/i.test(l))) notes.push('Let op: geen USER-instructie; container draait als root.');
  return [STATUS.OK, ['FROM aanwezig.', ...notes].join('\n')];
}

// ---- hoofdroutine: voer statische controles uit en zet sandbox-taken klaar ----
export function runChecks(jobId, cycle, fileRows) {
  const add = (c) => checksRepo.add({ job_id: jobId, cycle, ...c });
  const sandboxFiles = [];
  const tasks = [];
  const t0 = Date.now();

  if (!fileRows.length) {
    add({ name: 'Bestanden aanwezig', category: 'NIET_UITGEVOERD', status: STATUS.UNTESTED, output: 'Claude heeft geen herkenbare bestanden opgeleverd; er is niets te testen.' });
  }

  for (const f of fileRows) {
    const text = readStored(f).toString('utf8');
    const e = extOf(f.path);
    const base = path.posix.basename(f.path).toLowerCase();
    const stat = (name, [status, output]) => add({ name, category: 'STATISCH', status, target: f.path, output, duration_ms: Date.now() - t0 });
    if (e === 'json') stat('JSON-validatie', checkJson(text));
    else if (e === 'yaml' || e === 'yml') {
      stat('YAML-validatie', checkYaml(text));
      if (isComposeFile(f.path)) {
        stat('Docker Compose-structuurcontrole', checkCompose(text));
        add({ name: 'docker compose config / opstarten', category: 'NIET_UITGEVOERD', status: STATUS.UNTESTED, target: f.path, output: 'Docker is bewust niet beschikbaar in de testomgeving. Voer zelf uit: docker compose -f <bestand> config' });
      }
    } else if (e === 'html' || e === 'htm') {
      const r = checkHtml(text);
      add({ name: 'HTML-structuur en id-verwijzingen', category: 'STATISCH', status: r.status, target: f.path, output: r.output });
      r.inlineScripts.forEach((s, i) => {
        const name = `__inline__/${f.path.replace(/\//g, '_')}.${i + 1}.${s.module ? 'mjs' : 'js'}`;
        sandboxFiles.push({ path: name, content: s.body });
        tasks.push({ type: 'node_check', target: name, label: `JavaScript-syntaxis (inline script ${i + 1} in ${f.path})`, display: f.path });
      });
      add({ name: 'Functionele browsertest', category: 'NIET_UITGEVOERD', status: STATUS.UNTESTED, target: f.path, output: 'Er is geen headless browser in de testomgeving. Open het bestand via "Voorbeeld" en test handmatig.' });
    } else if (base === 'dockerfile' || base.endsWith('.dockerfile')) stat('Dockerfile-controle', checkDockerfile(text));
    else if (['js', 'mjs', 'cjs'].includes(e)) {
      tasks.push({ type: 'node_check', target: f.path, label: 'JavaScript-syntaxis (node --check)' });
      if (/\.test\.(m?js|cjs)$/.test(base)) tasks.push({ type: 'node_test', target: f.path, label: 'Unit tests (node --test)' });
    } else if (e === 'py') {
      tasks.push({ type: 'py_compile', target: f.path, label: 'Python-syntaxis (py_compile)' });
    } else if (e === 'sh') {
      tasks.push({ type: 'bash_n', target: f.path, label: 'Shell-syntaxis (bash -n)' });
    } else if (['ts', 'tsx'].includes(e)) {
      add({ name: 'TypeScript-compilatie', category: 'NIET_UITGEVOERD', status: STATUS.UNTESTED, target: f.path, output: 'TypeScript-compiler is niet beschikbaar in de testomgeving.' });
    }
    if (!/^__inline__\//.test(f.path)) sandboxFiles.push({ path: f.path, content: text });
  }
  const pyTests = fileRows.filter((f) => /(^|\/)(test_[^/]*|[^/]*_test)\.py$/.test(f.path));
  if (pyTests.length) tasks.push({ type: 'pytest', target: '.', label: `Unit tests (pytest, ${pyTests.length} testbestand(en))` });

  if (!tasks.length) return { queued: false };

  const sb = sandboxStatus();
  if (!sb.available) {
    for (const t of tasks) {
      add({ name: t.label, category: 'NIET_UITGEVOERD', status: STATUS.UNTESTED, target: t.display || t.target, output: `Sandbox niet beschikbaar: ${sb.reason}` });
    }
    return { queued: false };
  }
  const id = crypto.randomUUID();
  writeSandboxJob(id, sandboxFiles, tasks);
  sandboxRuns.add({ id, job_id: jobId, cycle, tasks });
  log.info('sandbox-taak in wachtrij', { jobId, cycle, id, tasks: tasks.length });
  return { queued: true, id };
}

function writeSandboxJob(id, files, tasks) {
  const dir = path.join(config.sandboxDir, 'queue', id);
  for (const f of files) {
    const abs = path.resolve(dir, 'files', f.path);
    if (!abs.startsWith(path.resolve(dir, 'files') + path.sep)) throw new Error('Ongeldig pad voor sandbox');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'request.json'), JSON.stringify({ id, tasks: tasks.map(({ type, target }) => ({ type, target })) }));
  // "ready" als laatste: de worker pakt de taak pas op als alles geschreven is.
  fs.writeFileSync(path.join(dir, 'ready'), '');
}

// Verwerkt resultaten van de sandbox. Retourneert job-id's waarvan alle sandbox-taken klaar zijn.
export function collectSandboxResults() {
  const finished = [];
  for (const run of sandboxRuns.pending()) {
    const dir = path.join(config.sandboxDir, 'queue', run.id);
    const resultFile = path.join(dir, 'result.json');
    let result = null;
    if (fs.existsSync(resultFile)) {
      try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { result = null; }
    }
    const age = (Date.now() - Date.parse(run.created_at)) / 1000;
    if (!result && age < config.sandboxTimeoutSec) continue;
    const add = (c) => checksRepo.add({ job_id: run.job_id, cycle: run.cycle, ...c });
    run.tasks.forEach((t, i) => {
      const r = result?.results?.[i];
      const target = t.display || t.target;
      if (!r) {
        add({ name: t.label, category: 'NIET_UITGEVOERD', status: STATUS.UNTESTED, target, output: result ? 'Geen resultaat voor deze taak.' : `Sandbox gaf binnen ${config.sandboxTimeoutSec} s geen resultaat.` });
      } else if (r.notRun) {
        add({ name: t.label, category: 'NIET_UITGEVOERD', status: STATUS.UNTESTED, target, output: r.output });
      } else {
        const executed = t.type === 'pytest' || t.type === 'node_test';
        let status = r.exitCode === 0 ? STATUS.OK : STATUS.FAIL;
        if (r.timedOut) status = STATUS.FAIL;
        // pytest exitcode 5 = geen tests gevonden
        if (t.type === 'pytest' && r.exitCode === 5) status = STATUS.UNTESTED;
        add({ name: t.label, category: executed && status !== STATUS.UNTESTED ? 'UITGEVOERDE_TEST' : executed ? 'NIET_UITGEVOERD' : 'STATISCH', status, target, output: `${r.command}\nexitcode: ${r.exitCode}${r.timedOut ? ' (time-out)' : ''}\n${r.output}`, duration_ms: r.durationMs });
      }
    });
    sandboxRuns.setState(run.id, result ? 'KLAAR' : 'TIMEOUT');
    fs.rmSync(dir, { recursive: true, force: true });
    if (!sandboxRuns.pendingForJob(run.job_id)) finished.push(run.job_id);
  }
  return finished;
}
