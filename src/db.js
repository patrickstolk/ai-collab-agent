// Databaselaag (SQLite via de ingebouwde node:sqlite-module).
// Alle SQL staat in dit bestand; voor PostgreSQL hoeft alleen deze module te worden
// vervangen door een implementatie met dezelfde exportfuncties.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

let db;

const MIGRATIONS = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pw_hash TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE jobs (
     id INTEGER PRIMARY KEY,
     title TEXT NOT NULL,
     assignment TEXT NOT NULL,
     acceptance_criteria TEXT NOT NULL DEFAULT '',
     workflow_type TEXT NOT NULL,
     variant TEXT NOT NULL DEFAULT 'volledig',
     handoff_mode TEXT NOT NULL,
     state TEXT NOT NULL,
     prev_state TEXT,
     final_status TEXT,
     cycle INTEGER NOT NULL DEFAULT 0,
     max_cycles INTEGER NOT NULL,
     max_requests INTEGER NOT NULL,
     request_count INTEGER NOT NULL DEFAULT 0,
     cost_eur REAL,
     cost_budget REAL,
     pending_token TEXT,
     clone_of INTEGER,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     finished_at TEXT);
   CREATE TABLE events (
     id INTEGER PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     cycle INTEGER NOT NULL,
     kind TEXT NOT NULL,
     actor TEXT NOT NULL,
     method TEXT,
     model TEXT,
     title TEXT,
     content TEXT,
     meta TEXT,
     created_at TEXT NOT NULL);
   CREATE INDEX events_job ON events(job_id, id);
   CREATE TABLE files (
     id INTEGER PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     path TEXT NOT NULL,
     version INTEGER NOT NULL,
     cycle INTEGER NOT NULL,
     origin TEXT NOT NULL,
     stored_path TEXT NOT NULL,
     sha256 TEXT NOT NULL,
     size INTEGER NOT NULL,
     read_status TEXT NOT NULL,
     read_note TEXT,
     extract_path TEXT,
     created_at TEXT NOT NULL);
   CREATE INDEX files_job ON files(job_id, path, version);
   CREATE TABLE checks (
     id INTEGER PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     cycle INTEGER NOT NULL,
     name TEXT NOT NULL,
     category TEXT NOT NULL,
     status TEXT NOT NULL,
     target TEXT,
     output TEXT,
     duration_ms INTEGER,
     created_at TEXT NOT NULL);
   CREATE TABLE issues (
     id INTEGER PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     cycle INTEGER NOT NULL,
     severity TEXT NOT NULL,
     description TEXT NOT NULL,
     suggestion TEXT,
     created_at TEXT NOT NULL);
   CREATE TABLE sandbox_runs (
     id TEXT PRIMARY KEY,
     job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
     cycle INTEGER NOT NULL,
     state TEXT NOT NULL,
     tasks TEXT NOT NULL,
     created_at TEXT NOT NULL);`,
];

export function now() {
  return new Date().toISOString();
}

export function openDb(file = config.dbPath) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get();
  let version = row ? row.version : 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  while (version < MIGRATIONS.length) {
    tx(() => {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(version);
    });
  }
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const q = (sql) => db.prepare(sql);

// ---- gebruikers en sessies ----
export const users = {
  count: () => q('SELECT COUNT(*) n FROM users').get().n,
  byName: (u) => q('SELECT * FROM users WHERE username = ?').get(u),
  byId: (id) => q('SELECT id, username FROM users WHERE id = ?').get(id),
  create: (username, pwHash) =>
    q('INSERT INTO users (username, pw_hash, created_at) VALUES (?, ?, ?)').run(username, pwHash, now()),
  setPassword: (id, pwHash) => q('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, id),
};

export const sessions = {
  create: (id, userId, csrf, expiresAt) =>
    q('INSERT INTO sessions (id, user_id, csrf, expires_at) VALUES (?, ?, ?, ?)').run(id, userId, csrf, expiresAt),
  get: (id) => q('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now()),
  delete: (id) => q('DELETE FROM sessions WHERE id = ?').run(id),
  purge: () => q('DELETE FROM sessions WHERE expires_at <= ?').run(now()),
};

// ---- instellingen (niet-geheime waarden) ----
export const settingsRepo = {
  all: () => Object.fromEntries(q('SELECT key, value FROM settings').all().map((r) => [r.key, JSON.parse(r.value)])),
  set: (key, value) =>
    q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value)),
};

// ---- opdrachten ----
export const jobs = {
  create(j) {
    const t = now();
    const r = q(`INSERT INTO jobs (title, assignment, acceptance_criteria, workflow_type, variant, handoff_mode, state,
        cycle, max_cycles, max_requests, cost_budget, pending_token, clone_of, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`)
      .run(j.title, j.assignment, j.acceptance_criteria || '', j.workflow_type, j.variant, j.handoff_mode, j.state,
        j.max_cycles, j.max_requests, j.cost_budget ?? null, j.pending_token, j.clone_of ?? null, t, t);
    return Number(r.lastInsertRowid);
  },
  get: (id) => q('SELECT * FROM jobs WHERE id = ?').get(id),
  list: () => q('SELECT * FROM jobs ORDER BY updated_at DESC').all(),
  update(id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    q(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]), now(), id);
  },
  // Atomische overgang: slaagt alleen als de opdracht nog in de verwachte toestand staat
  // met het verwachte stap-token. Voorkomt dubbele verwerking van dezelfde stap.
  transition(id, fromState, token, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const r = q(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ? AND state = ? AND pending_token = ?`)
      .run(...keys.map((k) => fields[k]), now(), id, fromState, token);
    return r.changes === 1;
  },
  delete: (id) => q('DELETE FROM jobs WHERE id = ?').run(id),
};

export const events = {
  add(e) {
    const r = q(`INSERT INTO events (job_id, cycle, kind, actor, method, model, title, content, meta, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.job_id, e.cycle, e.kind, e.actor, e.method ?? null, e.model ?? null, e.title ?? null,
        e.content ?? null, e.meta ? JSON.stringify(e.meta) : null, now());
    return Number(r.lastInsertRowid);
  },
  forJob: (jobId) => q('SELECT * FROM events WHERE job_id = ? ORDER BY id').all(jobId).map(parseMeta),
  latest: (jobId, kind) => parseMeta(q('SELECT * FROM events WHERE job_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(jobId, kind)),
  latestInCycle: (jobId, kind, cycle) =>
    parseMeta(q('SELECT * FROM events WHERE job_id = ? AND kind = ? AND cycle = ? ORDER BY id DESC LIMIT 1').get(jobId, kind, cycle)),
};

function parseMeta(r) {
  if (r && r.meta) r.meta = JSON.parse(r.meta);
  return r;
}

export const files = {
  add(f) {
    const r = q(`INSERT INTO files (job_id, path, version, cycle, origin, stored_path, sha256, size, read_status,
        read_note, extract_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.job_id, f.path, f.version, f.cycle, f.origin, f.stored_path, f.sha256, f.size, f.read_status,
        f.read_note ?? null, f.extract_path ?? null, now());
    return Number(r.lastInsertRowid);
  },
  get: (id) => q('SELECT * FROM files WHERE id = ?').get(id),
  forJob: (jobId) => q('SELECT * FROM files WHERE job_id = ? ORDER BY path, version').all(jobId),
  maxVersion: (jobId, path) => q('SELECT MAX(version) v FROM files WHERE job_id = ? AND path = ?').get(jobId, path).v || 0,
  // Laatste versie van ieder door Claude gegenereerd bestand.
  latestGenerated: (jobId) => q(`SELECT f.* FROM files f JOIN (
        SELECT path, MAX(version) v FROM files WHERE job_id = ? AND origin = 'claude' GROUP BY path) m
        ON f.path = m.path AND f.version = m.v WHERE f.job_id = ? AND f.origin = 'claude' ORDER BY f.path`).all(jobId, jobId),
  inCycle: (jobId, cycle) => q("SELECT * FROM files WHERE job_id = ? AND cycle = ? AND origin = 'claude' ORDER BY path").all(jobId, cycle),
  uploads: (jobId) => q("SELECT * FROM files WHERE job_id = ? AND origin = 'upload' ORDER BY path").all(jobId),
  versions: (jobId, path) => q('SELECT * FROM files WHERE job_id = ? AND path = ? ORDER BY version').all(jobId, path),
};

export const checks = {
  add(c) {
    q(`INSERT INTO checks (job_id, cycle, name, category, status, target, output, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(c.job_id, c.cycle, c.name, c.category, c.status, c.target ?? null, c.output ?? null, c.duration_ms ?? null, now());
  },
  forJob: (jobId) => q('SELECT * FROM checks WHERE job_id = ? ORDER BY cycle, id').all(jobId),
  forCycle: (jobId, cycle) => q('SELECT * FROM checks WHERE job_id = ? AND cycle = ? ORDER BY id').all(jobId, cycle),
};

export const issues = {
  add: (i) => q('INSERT INTO issues (job_id, cycle, severity, description, suggestion, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(i.job_id, i.cycle, i.severity, i.description, i.suggestion ?? null, now()),
  forJob: (jobId) => q('SELECT * FROM issues WHERE job_id = ? ORDER BY cycle, id').all(jobId),
  forCycle: (jobId, cycle) => q('SELECT * FROM issues WHERE job_id = ? AND cycle = ? ORDER BY id').all(jobId, cycle),
};

export const sandboxRuns = {
  add: (r) => q('INSERT INTO sandbox_runs (id, job_id, cycle, state, tasks, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(r.id, r.job_id, r.cycle, 'WACHTRIJ', JSON.stringify(r.tasks), now()),
  pending: () => q("SELECT * FROM sandbox_runs WHERE state = 'WACHTRIJ'").all().map((r) => ({ ...r, tasks: JSON.parse(r.tasks) })),
  pendingForJob: (jobId) => q("SELECT COUNT(*) n FROM sandbox_runs WHERE job_id = ? AND state = 'WACHTRIJ'").get(jobId).n,
  setState: (id, state) => q('UPDATE sandbox_runs SET state = ? WHERE id = ?').run(state, id),
};
