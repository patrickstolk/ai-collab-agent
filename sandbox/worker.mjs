// Sandbox-worker: voert uitsluitend vaste, vooraf gedefinieerde controles uit op
// gegenereerde code. Draait in een eigen container zonder netwerk (network_mode: none),
// met read-only root-bestandssysteem en resource-limieten. De code zelf draait als een
// aparte onbevoegde gebruiker (SANDBOX_RUNNER_UID) die de wachtrijmap niet kan lezen.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';

const DIR = path.resolve(process.env.SANDBOX_DIR || './data/sandbox-jobs');
const QUEUE = path.join(DIR, 'queue');
const RUNNER_UID = process.env.SANDBOX_RUNNER_UID ? Number(process.env.SANDBOX_RUNNER_UID) : null;
const RUNNER_GID = process.env.SANDBOX_RUNNER_GID ? Number(process.env.SANDBOX_RUNNER_GID) : RUNNER_UID;
const TASK_TIMEOUT_MS = Number(process.env.SANDBOX_TASK_TIMEOUT_SEC || 60) * 1000;
const MAX_OUTPUT = 20000;
const WORK_ROOT = process.env.SANDBOX_WORK_DIR || os.tmpdir();

fs.mkdirSync(QUEUE, { recursive: true });
// Als de worker (root) de wachtrijmap aanmaakt, moet de app-gebruiker (eigenaar van DIR) er kunnen schrijven.
if (process.getuid && process.getuid() === 0) {
  const { uid, gid } = fs.statSync(DIR);
  fs.chownSync(QUEUE, uid, gid);
}

function version(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] : null;
  } catch { return null; }
}

const PY = process.platform === 'win32' ? 'python' : 'python3';
const tools = {
  node: process.version,
  python: version(PY, ['--version']),
  pytest: version(PY, ['-m', 'pytest', '--version']),
  bash: version('bash', ['--version']),
};

// Feitelijke isolatiecontrole: kan de sandbox een externe host bereiken?
function probeNetwork() {
  return new Promise((resolve) => {
    const s = net.connect({ host: '1.1.1.1', port: 53, timeout: 2000 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('timeout', () => { s.destroy(); resolve(false); });
    s.on('error', () => resolve(false));
  });
}

let isolation = { summary: 'nog niet bepaald' };
async function updateIsolation() {
  const netReachable = await probeNetwork();
  const parts = [
    netReachable ? 'LET OP: netwerk bereikbaar' : 'geen netwerktoegang (gecontroleerd)',
    RUNNER_UID != null ? `tests draaien als uid ${RUNNER_UID}` : 'LET OP: tests draaien als dezelfde gebruiker als de worker (alleen voor ontwikkeling)',
  ];
  isolation = { network: netReachable, runnerUid: RUNNER_UID, summary: parts.join('; ') };
}

function heartbeat() {
  const tmp = path.join(DIR, `.heartbeat.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify({ time: new Date().toISOString(), tools, isolation }));
  fs.renameSync(tmp, path.join(DIR, 'heartbeat.json'));
}

function commandFor(task) {
  const t = task.target;
  switch (task.type) {
    case 'node_check': return ['node', ['--check', t]];
    case 'node_test': return ['node', ['--test', t]];
    case 'py_compile': return tools.python ? [PY, ['-m', 'py_compile', t]] : null;
    case 'pytest': return tools.pytest ? [PY, ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '--no-header', '-o', 'addopts=']] : null;
    case 'bash_n': return tools.bash ? ['bash', ['-n', t]] : null;
    default: return null;
  }
}

function safeTarget(t) {
  return typeof t === 'string' && t.length < 300 && !t.startsWith('/') && !t.split('/').includes('..');
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const opts = {
      cwd,
      env: { PATH: process.env.PATH, HOME: cwd, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    if (RUNNER_UID != null) { opts.uid = RUNNER_UID; opts.gid = RUNNER_GID; }
    let out = '';
    let child;
    try { child = spawn(cmd, args, opts); } catch (e) {
      return resolve({ exitCode: -1, output: `Kon niet starten: ${e.message}`, durationMs: 0, timedOut: false });
    }
    const add = (d) => { if (out.length < MAX_OUTPUT) out += d.toString('utf8'); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TASK_TIMEOUT_MS);
    child.on('error', (e) => add(`\n${e.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, output: out.slice(0, MAX_OUTPUT), durationMs: Date.now() - t0, timedOut });
    });
  });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function chownRecursive(p) {
  if (RUNNER_UID == null) return;
  fs.chownSync(p, RUNNER_UID, RUNNER_GID);
  if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) chownRecursive(path.join(p, e));
}

async function processJob(id) {
  const dir = path.join(QUEUE, id);
  const req = JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'));
  const work = fs.mkdtempSync(path.join(WORK_ROOT, 'sbx-'));
  const results = [];
  try {
    if (fs.existsSync(path.join(dir, 'files'))) copyDir(path.join(dir, 'files'), work);
    chownRecursive(work);
    for (const task of req.tasks) {
      if (!safeTarget(task.target)) { results.push({ notRun: true, output: 'Ongeldig doel.' }); continue; }
      const c = commandFor(task);
      if (!c) { results.push({ notRun: true, output: `Hulpmiddel voor "${task.type}" is niet geïnstalleerd in de sandbox.` }); continue; }
      const r = await run(c[0], c[1], work);
      results.push({ ...r, command: `${path.basename(c[0])} ${c[1].join(' ')}` });
    }
  } catch (e) {
    results.push({ notRun: true, output: `Sandboxfout: ${e.message}` });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  const tmp = path.join(dir, 'result.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ id, results, isolation, finished: new Date().toISOString() }));
  fs.renameSync(tmp, path.join(dir, 'result.json'));
}

async function tick() {
  let entries = [];
  try { entries = fs.readdirSync(QUEUE); } catch { return; }
  for (const id of entries) {
    const dir = path.join(QUEUE, id);
    // claim: hernoem "ready" naar "taken" (atomisch), zodat een taak nooit twee keer draait
    try { fs.renameSync(path.join(dir, 'ready'), path.join(dir, 'taken')); } catch { continue; }
    console.log(`${new Date().toISOString()} taak ${id} gestart`);
    await processJob(id).catch((e) => console.error(`taak ${id} mislukt: ${e.message}`));
    console.log(`${new Date().toISOString()} taak ${id} klaar`);
  }
}

await updateIsolation();
console.log(`sandbox-worker actief; wachtrij ${QUEUE}; ${isolation.summary}; hulpmiddelen ${JSON.stringify(tools)}`);
heartbeat();
setInterval(heartbeat, 5000);
setInterval(() => updateIsolation().catch(() => {}), 60000);
let busy = false;
setInterval(async () => {
  if (busy) return;
  busy = true;
  try { await tick(); } finally { busy = false; }
}, 1000);
