// Authenticatie: één of meer lokale gebruikers, wachtwoorden gehasht met scrypt,
// sessies in de database (overleven een herstart), CSRF-token per sessie, en
// beperking van inlogpogingen per IP-adres.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { users, sessions } from './db.js';
import { log } from './log.js';

const COOKIE = 'aca_sid';

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 12) return 'Wachtwoord moet minimaal 12 tekens lang zijn.';
  return null;
}

// Eerste gebruiker: via ADMIN_PASSWORD, of via een eenmalige installatiecode in de logs.
let setupCode = null;
export function ensureAdmin() {
  if (users.count() > 0) return;
  if (config.adminPassword) {
    const err = validatePasswordStrength(config.adminPassword);
    if (err) throw new Error(`ADMIN_PASSWORD ongeldig: ${err}`);
    users.create(config.adminUser, hashPassword(config.adminPassword));
    log.info(`beheerder "${config.adminUser}" aangemaakt vanuit ADMIN_PASSWORD`);
    return;
  }
  setupCode = crypto.randomBytes(9).toString('base64url');
  const file = path.join(config.dataDir, 'SETUP_CODE.txt');
  fs.writeFileSync(file, setupCode + '\n', { mode: 0o600 });
  log.warn(`Nog geen gebruiker. Open /setup en gebruik de installatiecode uit ${file} (ook: docker compose exec app cat /data/SETUP_CODE.txt)`);
}

export function setupPending() {
  return users.count() === 0 && !!setupCode;
}

export function completeSetup(code, username, password) {
  if (!setupPending()) return 'Installatie is al voltooid.';
  const a = Buffer.from(String(code));
  const b = Buffer.from(setupCode);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'Onjuiste installatiecode.';
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(username || '')) return 'Gebruikersnaam: 3-40 tekens (letters, cijfers, . _ -).';
  const err = validatePasswordStrength(password);
  if (err) return err;
  users.create(username, hashPassword(password));
  setupCode = null;
  try { fs.unlinkSync(path.join(config.dataDir, 'SETUP_CODE.txt')); } catch { /* al weg */ }
  return null;
}

// ---- beperking van inlogpogingen ----
const attempts = new Map();
export function loginBlocked(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return a.count >= 5;
}
export function loginFailed(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60 * 1000) attempts.set(ip, { first: Date.now(), count: 1 });
  else a.count++;
}
export function loginSucceeded(ip) {
  attempts.delete(ip);
}

// ---- sessies ----
function sign(id) {
  return `${id}.${crypto.createHmac('sha256', config.sessionSecret).update(id).digest('base64url')}`;
}
function unsign(v) {
  const [id, sig] = String(v || '').split('.');
  if (!id || !sig) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(id).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? id : null;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieAttrs(maxAgeSec) {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.cookieSecure ? '; Secure' : ''}`;
}

export function login(res, userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600 * 1000).toISOString();
  sessions.purge();
  sessions.create(id, userId, csrf, expires);
  res.setHeader('Set-Cookie', `${COOKIE}=${sign(id)}; ${cookieAttrs(config.sessionHours * 3600)}`);
}

export function logout(req, res) {
  if (req.session) sessions.delete(req.session.id);
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
}

export function loadSession(req, _res, next) {
  const id = unsign(parseCookies(req.headers.cookie)[COOKIE]);
  const s = id ? sessions.get(id) : null;
  if (s) {
    req.session = s;
    req.user = users.byId(s.user_id);
  }
  next();
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.method === 'GET') return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  return res.status(401).send('Niet ingelogd.');
}

// CSRF: alle POST-verzoeken van ingelogde gebruikers moeten het sessietoken meesturen.
export function csrfValid(req, sent) {
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(req.session.csrf);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Multipart-formulieren worden pas in de route geparsed; die route roept csrfValid zelf aan.
export function checkCsrf(req, res, next) {
  if (req.method !== 'POST' || !req.session) return next();
  if (String(req.headers['content-type'] || '').startsWith('multipart/form-data')) return next();
  if (csrfValid(req, (req.body && req.body._csrf) || req.headers['x-csrf-token'])) return next();
  log.warn('CSRF-controle mislukt', { path: req.path });
  return res.status(403).send('Ongeldig of verlopen formulier (CSRF). Laad de pagina opnieuw.');
}

export function secretFromDisk() {
  if (config.sessionSecret) return;
  const file = path.join(config.dataDir, 'session_secret');
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (fs.existsSync(file)) {
    config.sessionSecret = fs.readFileSync(file, 'utf8').trim();
  } else {
    config.sessionSecret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, config.sessionSecret, { mode: 0o600 });
    log.warn('SESSION_SECRET niet gezet; willekeurige sleutel gegenereerd en opgeslagen in de datamap.');
  }
}
