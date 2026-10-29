// Uitvoeringsmethoden achter één interface: handmatig (standaard), lokaal model via Ollama,
// en de officiële API's van OpenAI en Anthropic (optioneel, standaard uit, NIET GETEST zonder sleutels).
// Browserautomatisering van chatgpt.com/claude.ai is bewust niet geïmplementeerd: zie docs/HAALBAARHEID.md.
import { config } from './config.js';
import { getSettings } from './settings.js';

export const ROLE = { chatgpt: 'ChatGPT', claude: 'Claude' };

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { /* geen JSON */ }
    if (!res.ok) {
      const msg = data?.error?.message || data?.error || body.slice(0, 300);
      throw new Error(`HTTP ${res.status}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Geen antwoord binnen ${Math.round(timeoutMs / 1000)} s (time-out).`);
    throw e;
  } finally {
    clearTimeout(t);
  }
}

// ---- Ollama ----
export async function ollamaStatus() {
  const s = getSettings();
  if (!s.ollama_enabled) return { state: 'UIT', text: 'Uitgeschakeld in instellingen.' };
  try {
    const data = await fetchJson(`${config.ollamaUrl}/api/tags`, {}, 4000);
    const models = (data.models || []).map((m) => m.name);
    if (!models.length) return { state: 'CONFIGUREREN', text: `Ollama bereikbaar op ${config.ollamaUrl}, maar er zijn geen modellen geïnstalleerd (ollama pull <model>).`, models };
    if (!s.ollama_model) return { state: 'CONFIGUREREN', text: 'Ollama bereikbaar; kies een model in de instellingen.', models };
    if (!models.includes(s.ollama_model)) return { state: 'CONFIGUREREN', text: `Model "${s.ollama_model}" niet gevonden. Beschikbaar: ${models.join(', ')}`, models };
    return { state: 'WERKEND', text: `Bereikbaar op ${config.ollamaUrl}, model ${s.ollama_model}.`, models };
  } catch (e) {
    return { state: 'NIET_BEREIKBAAR', text: `Ollama niet bereikbaar op ${config.ollamaUrl}: ${e.message}` };
  }
}

export async function callOllama(prompt) {
  const s = getSettings();
  if (!s.ollama_enabled || !s.ollama_model) throw new Error('Lokale AI is niet ingeschakeld of er is geen model gekozen.');
  const t0 = Date.now();
  const data = await fetchJson(`${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: s.ollama_model, stream: false, messages: [{ role: 'user', content: prompt }] }),
  }, s.ollama_timeout_sec * 1000);
  const text = data?.message?.content;
  if (!text) throw new Error('Ollama gaf een leeg antwoord.');
  return { text, model: `${s.ollama_model} (lokaal via Ollama)`, method: 'lokaal model', costEur: 0, durationMs: Date.now() - t0 };
}

// ---- officiële API's ----
export function apiStatus(role) {
  const s = getSettings();
  const isClaude = role === 'claude';
  const key = isClaude ? config.anthropicApiKey : config.openaiApiKey;
  const model = isClaude ? s.anthropic_model : s.openai_model;
  const envName = isClaude ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  if (!s.api_enabled) return { state: 'OPTIONEEL', text: 'Optioneel; vereist een apart betaald API-account. Niet ingeschakeld.' };
  if (!key) return { state: 'CONFIGUREREN', text: `API ingeschakeld, maar omgevingsvariabele ${envName} is niet gezet.` };
  if (!model) return { state: 'CONFIGUREREN', text: 'Sleutel aanwezig; vul de modelnaam in bij Instellingen.' };
  return { state: 'GECONFIGUREERD', text: `Sleutel aanwezig, model ${model}. Werking wordt pas bij een eerste aanroep vastgesteld.` };
}

function cost(usageIn, usageOut, priceIn, priceOut) {
  if (priceIn == null || priceOut == null || usageIn == null || usageOut == null) return null;
  return (usageIn / 1e6) * priceIn + (usageOut / 1e6) * priceOut;
}

export async function callApi(role, prompt) {
  const st = apiStatus(role);
  if (st.state !== 'GECONFIGUREERD') throw new Error(st.text);
  const s = getSettings();
  const t0 = Date.now();
  if (role === 'claude') {
    const data = await fetchJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: s.anthropic_model, max_tokens: s.anthropic_max_tokens, messages: [{ role: 'user', content: prompt }] }),
    }, 600000);
    const text = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (!text) throw new Error('Anthropic API gaf geen tekst terug.');
    const u = data.usage || {};
    return { text, model: `${data.model || s.anthropic_model} (Anthropic API)`, method: 'api', durationMs: Date.now() - t0,
      costEur: cost(u.input_tokens, u.output_tokens, s.anthropic_price_in, s.anthropic_price_out),
      truncated: data.stop_reason === 'max_tokens' };
  }
  const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.openaiApiKey}` },
    body: JSON.stringify({ model: s.openai_model, messages: [{ role: 'user', content: prompt }] }),
  }, 600000);
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI API gaf geen tekst terug.');
  const u = data.usage || {};
  return { text, model: `${data.model || s.openai_model} (OpenAI API)`, method: 'api', durationMs: Date.now() - t0,
    costEur: cost(u.prompt_tokens, u.completion_tokens, s.openai_price_in, s.openai_price_out),
    truncated: data.choices[0].finish_reason === 'length' };
}
