// Verwerking van geplakte AI-antwoorden. Herkent alleen wat er aantoonbaar staat;
// bij twijfel wordt een waarschuwing teruggegeven in plaats van iets te raden.
import { MARK } from './prompts.js';

function between(text, [start, end]) {
  const i = text.indexOf(start);
  if (i < 0) return null;
  const j = text.indexOf(end, i + start.length);
  if (j < 0) return null;
  return text.slice(i + start.length, j).trim();
}

// ChatGPT kopieert soms markeringen als **===X===** of met escapes; normaliseer die varianten.
export function normalizeMarkers(text) {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\*\*(===[A-Z ]+===)\*\*/g, '$1')
    .replace(/\\=\\=\\=/g, '===')
    .replace(/\\_/g, '_');
}

export function parseAnalysis(raw) {
  const text = normalizeMarkers(raw);
  const warnings = [];
  const clarify = between(text, MARK.clarify);
  if (clarify) {
    const questions = clarify.split('\n').map((l) => l.trim()).filter(Boolean);
    return { type: 'verduidelijking', questions, warnings };
  }
  const analysis = between(text, MARK.analysis);
  const criteria = between(text, MARK.criteria);
  let prompt = between(text, MARK.claudePrompt);
  if (!prompt) {
    // Begin-markering zonder einde: neem alles erna.
    const i = text.indexOf(MARK.claudePrompt[0]);
    if (i >= 0) {
      prompt = text.slice(i + MARK.claudePrompt[0].length).trim();
      warnings.push('Eindmarkering van de Claude-prompt ontbrak; alle tekst na de beginmarkering is gebruikt.');
    }
  }
  if (!prompt) {
    warnings.push('Geen gemarkeerde prompt voor Claude gevonden. Het volledige antwoord wordt als prompt voorgesteld; controleer en bewerk dit vóór het versturen.');
    prompt = text.trim();
  }
  if (!analysis) warnings.push('Geen gemarkeerde analyse gevonden.');
  if (!criteria) warnings.push('Geen gemarkeerde acceptatiecriteria gevonden.');
  return { type: 'prompt', analysis, criteria, prompt, warnings };
}

const SAFE_PATH = /^[A-Za-z0-9._\-\/ ]+$/;

export function sanitizeRelPath(p) {
  let s = String(p).trim().replace(/\\/g, '/').replace(/^`+|`+$/g, '').replace(/^\.\//, '');
  s = s.replace(/^\*\*|\*\*$/g, '').trim();
  if (!s || s.length > 200 || !SAFE_PATH.test(s)) return null;
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const parts = s.split('/');
  if (parts.some((x) => x === '..' || x === '' || x === '.')) return null;
  return parts.join('/');
}

// Herkent "### BESTAND: pad" gevolgd door een codeblok (3+ backticks of tildes).
export function parseFiles(raw) {
  const text = String(raw).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const out = [];
  const warnings = [];
  const header = /^\s{0,3}#{1,6}\s*(?:\*\*)?\s*(?:BESTAND|FILE)\s*:\s*(.+?)\s*(?:\*\*)?\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(header);
    if (!m) continue;
    const rawPath = m[1].replace(/\s*\(.*\)\s*$/, '');
    // zoek opening fence binnen de volgende 3 regels
    let j = i + 1;
    while (j < lines.length && j <= i + 3 && !/^\s*(`{3,}|~{3,})/.test(lines[j])) j++;
    const open = j < lines.length ? lines[j].match(/^\s*(`{3,}|~{3,})/) : null;
    if (!open) {
      warnings.push(`Bij "${rawPath}" is geen codeblok gevonden; bestand overgeslagen.`);
      continue;
    }
    const fence = open[1];
    const closeRe = new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
    let k = j + 1;
    while (k < lines.length && !closeRe.test(lines[k])) k++;
    if (k >= lines.length) warnings.push(`Codeblok van "${rawPath}" is niet afgesloten; inhoud tot einde antwoord gebruikt.`);
    const content = lines.slice(j + 1, k).join('\n');
    const safe = sanitizeRelPath(rawPath);
    if (!safe) {
      warnings.push(`Ongeldig of onveilig bestandspad "${rawPath}"; bestand overgeslagen.`);
    } else if (out.some((f) => f.path === safe)) {
      warnings.push(`Bestand "${safe}" kwam meerdere keren voor; de laatste versie is gebruikt.`);
      out.splice(out.findIndex((f) => f.path === safe), 1, { path: safe, content: content + '\n' });
    } else {
      out.push({ path: safe, content: content + '\n' });
    }
    i = k;
  }
  if (!out.length && /```/.test(text)) {
    warnings.push('Het antwoord bevat codeblokken maar geen "### BESTAND:"-kopjes; er zijn geen bestanden opgeslagen.');
  }
  return { files: out, warnings };
}

const VERDICTS = ['GOEDGEKEURD', 'AFGEKEURD'];
const SEVERITIES = ['kritiek', 'hoog', 'middel', 'laag'];

export function parseReview(raw) {
  const text = normalizeMarkers(raw);
  const warnings = [];
  let block = between(text, MARK.review);
  if (!block) {
    // terugval: laatste ```json-blok met een "oordeel"-veld
    const m = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((x) => x[1]).filter((b) => b.includes('"oordeel"'));
    if (m.length) {
      block = m[m.length - 1];
      warnings.push('Review-markeringen ontbraken; het JSON-codeblok met "oordeel" is gebruikt.');
    }
  }
  if (!block) return { ok: false, warnings: ['Geen review-JSON gevonden. Kies handmatig hoe verder te gaan.'] };
  block = block.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '').trim();
  let data;
  try {
    data = JSON.parse(block);
  } catch (e) {
    return { ok: false, warnings: [`Review-JSON is ongeldig (${e.message}). Kies handmatig hoe verder te gaan.`] };
  }
  const verdict = String(data.oordeel || '').toUpperCase().trim();
  if (!VERDICTS.includes(verdict)) {
    return { ok: false, warnings: [`Onbekend oordeel "${data.oordeel}". Kies handmatig hoe verder te gaan.`] };
  }
  const issues = (Array.isArray(data.problemen) ? data.problemen : [])
    .filter((p) => p && p.beschrijving)
    .map((p) => {
      const sev = String(p.ernst || '').toLowerCase().trim();
      if (!SEVERITIES.includes(sev)) warnings.push(`Onbekende ernst "${p.ernst}" vervangen door "middel".`);
      return { severity: SEVERITIES.includes(sev) ? sev : 'middel', description: String(p.beschrijving), suggestion: p.suggestie ? String(p.suggestie) : null };
    });
  const criteria = (Array.isArray(data.criteria) ? data.criteria : []).map((c) => ({
    criterium: String(c.criterium ?? ''), status: String(c.status ?? 'ONBEKEND').toUpperCase(), toelichting: String(c.toelichting ?? ''),
  }));
  let finalVerdict = verdict;
  if (verdict === 'GOEDGEKEURD' && issues.some((i) => i.severity === 'kritiek' || i.severity === 'hoog')) {
    finalVerdict = 'AFGEKEURD';
    warnings.push('Review gaf GOEDGEKEURD maar meldt problemen met ernst kritiek/hoog; behandeld als AFGEKEURD.');
  }
  return { ok: true, verdict: finalVerdict, summary: String(data.samenvatting || ''), issues, criteria, warnings };
}
