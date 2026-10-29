// Instelbare (niet-geheime) waarden met veilige standaarden: alles wat geld kan kosten staat uit.
import { settingsRepo } from './db.js';

export const DEFAULTS = {
  max_cycles: 3,
  max_requests: 20,
  cost_budget_eur: null, // alleen relevant bij API-gebruik
  workflow_mode: 'handmatig', // handmatig | automatisch (automatisch vereist API's)
  default_handoff: 'handmatig', // handmatig | api
  ollama_enabled: false,
  ollama_model: '',
  ollama_timeout_sec: 600,
  api_enabled: false,
  openai_model: '',
  anthropic_model: '',
  anthropic_max_tokens: 16000,
  // Prijzen in EUR per 1 miljoen tokens; leeg = kosten niet berekenbaar.
  openai_price_in: null,
  openai_price_out: null,
  anthropic_price_in: null,
  anthropic_price_out: null,
  sandbox_enabled: true,
  log_level: 'info',
  log_to_file: false,
  prompt_warn_chars: 100000,
};

export function getSettings() {
  return { ...DEFAULTS, ...settingsRepo.all() };
}

const INT_FIELDS = ['max_cycles', 'max_requests', 'ollama_timeout_sec', 'anthropic_max_tokens', 'prompt_warn_chars'];
const NUM_FIELDS = ['cost_budget_eur', 'openai_price_in', 'openai_price_out', 'anthropic_price_in', 'anthropic_price_out'];
const BOOL_FIELDS = ['ollama_enabled', 'api_enabled', 'sandbox_enabled', 'log_to_file'];
const ENUMS = {
  workflow_mode: ['handmatig', 'automatisch'],
  default_handoff: ['handmatig', 'api'],
  log_level: ['debug', 'info', 'warn', 'error'],
};
const TEXT_FIELDS = ['ollama_model', 'openai_model', 'anthropic_model'];

// Valideert formulierinvoer; retourneert { values, errors }.
export function parseSettingsForm(body) {
  const values = {};
  const errors = [];
  for (const k of INT_FIELDS) {
    const v = parseInt(body[k], 10);
    if (!Number.isFinite(v) || v < 0) errors.push(`${k}: ongeldig getal`);
    else values[k] = v;
  }
  if (values.max_cycles > 10) errors.push('max_cycles: maximaal 10');
  if (values.max_requests < 1) errors.push('max_requests: minimaal 1');
  for (const k of NUM_FIELDS) {
    const raw = String(body[k] ?? '').trim().replace(',', '.');
    if (raw === '') { values[k] = null; continue; }
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 0) errors.push(`${k}: ongeldig bedrag`);
    else values[k] = v;
  }
  for (const k of BOOL_FIELDS) values[k] = body[k] === 'on' || body[k] === '1';
  for (const [k, opts] of Object.entries(ENUMS)) {
    if (!opts.includes(body[k])) errors.push(`${k}: ongeldige keuze`);
    else values[k] = body[k];
  }
  for (const k of TEXT_FIELDS) {
    const v = String(body[k] ?? '').trim();
    if (v && !/^[A-Za-z0-9._:\/-]{1,100}$/.test(v)) errors.push(`${k}: ongeldige modelnaam`);
    else values[k] = v;
  }
  if (values.workflow_mode === 'automatisch' && !values.api_enabled) {
    errors.push('Automatische workflow vereist ingeschakelde API-integratie (zonder API is alleen handmatige overdracht mogelijk).');
  }
  if (values.default_handoff === 'api' && !values.api_enabled) {
    errors.push('Standaard-overdracht "api" vereist ingeschakelde API-integratie.');
  }
  return { values, errors };
}

export function saveSettings(values) {
  for (const [k, v] of Object.entries(values)) settingsRepo.set(k, v);
}
