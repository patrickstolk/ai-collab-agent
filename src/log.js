// Eenvoudige logger die gevoelige gegevens (sleutels, tokens, wachtwoorden) maskeert.
// Prompt- en antwoordinhoud wordt bewust nooit gelogd.
import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let level = 'info';
let fileStream = null;

const REDACT = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]+/gi,
  /(password|wachtwoord|api[_-]?key|secret|token)(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
];

export function redact(s) {
  let out = String(s);
  out = out.replace(REDACT[0], '[GEMASKEERD]').replace(REDACT[1], '[GEMASKEERD]');
  out = out.replace(REDACT[2], '$1[GEMASKEERD]');
  out = out.replace(REDACT[3], '$1$2[GEMASKEERD]');
  return out;
}

export function configureLog({ logLevel, logToFile, dataDir }) {
  if (LEVELS[logLevel]) level = logLevel;
  if (fileStream) { fileStream.end(); fileStream = null; }
  if (logToFile && dataDir) {
    const dir = path.join(dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fileStream = fs.createWriteStream(path.join(dir, 'app.log'), { flags: 'a' });
  }
}

function write(lvl, msg, extra) {
  if (LEVELS[lvl] < LEVELS[level]) return;
  const line = redact(`${new Date().toISOString()} ${lvl.toUpperCase()} ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
  (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  if (fileStream) fileStream.write(line + '\n');
}

export const log = {
  debug: (m, e) => write('debug', m, e),
  info: (m, e) => write('info', m, e),
  warn: (m, e) => write('warn', m, e),
  error: (m, e) => write('error', m, e),
};
