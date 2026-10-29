// Centrale configuratie uit omgevingsvariabelen. Geheimen (wachtwoorden, API-sleutels)
// komen uitsluitend uit de omgeving en worden nooit in de database of frontend opgeslagen.
import path from 'node:path';

const env = process.env;

function int(name, def) {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

function bool(name, def) {
  const v = (env[name] ?? '').toLowerCase();
  if (['1', 'true', 'yes', 'ja'].includes(v)) return true;
  if (['0', 'false', 'no', 'nee'].includes(v)) return false;
  return def;
}

const dataDir = path.resolve(env.DATA_DIR || './data');

export const config = {
  appEnv: env.APP_ENV || 'production', // production | test | development
  port: int('PORT', 3000),
  host: env.HOST || '0.0.0.0',
  dataDir,
  dbPath: path.join(dataDir, 'app.db'),
  sessionSecret: env.SESSION_SECRET || '',
  adminUser: env.ADMIN_USER || 'admin',
  adminPassword: env.ADMIN_PASSWORD || '',
  cookieSecure: bool('COOKIE_SECURE', false),
  trustProxy: bool('TRUST_PROXY', false),
  sessionHours: int('SESSION_HOURS', 12),
  maxUploadMb: int('MAX_UPLOAD_MB', 25),
  maxUploadFiles: int('MAX_UPLOAD_FILES', 20),
  sandboxDir: path.resolve(env.SANDBOX_DIR || path.join(dataDir, 'sandbox-jobs')),
  sandboxTimeoutSec: int('SANDBOX_TIMEOUT_SEC', 180),
  ollamaUrl: env.OLLAMA_URL || 'http://localhost:11434',
  // API-sleutels: alleen gebruikt wanneer API-integratie expliciet is ingeschakeld in de instellingen.
  openaiApiKey: env.OPENAI_API_KEY || '',
  anthropicApiKey: env.ANTHROPIC_API_KEY || '',
  // Maximale hoeveelheid geëxtraheerde tekst per bestand en per prompt (tekens).
  maxExtractPerFile: int('MAX_EXTRACT_PER_FILE', 60000),
  maxExtractPerPrompt: int('MAX_EXTRACT_PER_PROMPT', 150000),
};
