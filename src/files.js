// Bestandsopslag per opdracht en tekstextractie. Ieder bestand krijgt een eerlijke
// leesstatus: GELEZEN, GEDEELTELIJK of NIET_GELEZEN, met een toelichting.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import yauzl from 'yauzl';
import { config } from './config.js';
import { files as filesRepo } from './db.js';
import { sanitizeRelPath } from './parse.js';

const require = createRequire(import.meta.url);

export const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'html', 'htm', 'css', 'csv', 'xml', 'sh', 'toml', 'ini', 'conf', 'cfg', 'sql', 'env', 'log']);
export const BINARY_EXT = new Set(['pdf', 'docx', 'xlsx', 'zip', 'step', 'stp']);
const SPECIAL_NAMES = new Set(['dockerfile', 'makefile', '.env.example', '.dockerignore', '.gitignore']);

export function extOf(name) {
  const base = path.posix.basename(name).toLowerCase();
  if (SPECIAL_NAMES.has(base)) return base;
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1) : '';
}

export function isAllowedUpload(name) {
  const e = extOf(name);
  return TEXT_EXT.has(e) || BINARY_EXT.has(e) || SPECIAL_NAMES.has(e);
}

// Bestandsnaam van een upload: alleen de basisnaam, veilige tekens.
export function safeUploadName(name) {
  const base = path.basename(String(name).replace(/\\/g, '/')).replace(/[^A-Za-z0-9._ -]/g, '_').trim();
  if (!base || base.startsWith('..') || base.length > 150) return null;
  return base;
}

// Controle van inhoud tegen extensie (magic bytes), om vermomde bestanden te weigeren.
export function validateContent(name, buf) {
  const e = extOf(name);
  if (e === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') return 'Bestand heeft extensie .pdf maar is geen PDF.';
  if (['docx', 'xlsx', 'zip'].includes(e) && !(buf[0] === 0x50 && buf[1] === 0x4b)) return `Bestand heeft extensie .${e} maar is geen ZIP-container.`;
  if (['step', 'stp'].includes(e) && !buf.subarray(0, 200).toString('latin1').includes('ISO-10303-21')) return 'Bestand is geen STEP-bestand (ISO-10303-21-kop ontbreekt).';
  return null;
}

export function jobDir(jobId) {
  return path.join(config.dataDir, 'jobs', String(jobId));
}

function absStored(rel) {
  const abs = path.resolve(config.dataDir, rel);
  if (!abs.startsWith(path.resolve(config.dataDir) + path.sep)) throw new Error('Ongeldig opslagpad');
  return abs;
}

export function readStored(fileRow) {
  return fs.readFileSync(absStored(fileRow.stored_path));
}

export function readExtract(fileRow) {
  if (!fileRow.extract_path) return null;
  try { return fs.readFileSync(absStored(fileRow.extract_path), 'utf8'); } catch { return null; }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function truncate(text) {
  if (text.length <= config.maxExtractPerFile) return { text, truncated: false };
  return { text: text.slice(0, config.maxExtractPerFile), truncated: true };
}

// ---- extractie per type ----
async function extractPdf(buf) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const r = await pdfParse(buf);
  const text = (r.text || '').trim();
  if (!text) return { status: 'NIET_GELEZEN', note: `PDF met ${r.numpages} pagina's zonder tekstlaag (vermoedelijk gescand); OCR is niet beschikbaar.`, text: null };
  return { status: 'GELEZEN', note: `Tekst uit ${r.numpages} pagina's geëxtraheerd; afbeeldingen en opmaak niet geanalyseerd.`, text };
}

async function extractDocx(buf) {
  const mammoth = (await import('mammoth')).default;
  const r = await mammoth.extractRawText({ buffer: buf });
  const text = (r.value || '').trim();
  if (!text) return { status: 'NIET_GELEZEN', note: 'Geen tekst gevonden in DOCX.', text: null };
  return { status: 'GELEZEN', note: 'Tekst geëxtraheerd; afbeeldingen, opmaak en wijzigingen bijhouden niet geanalyseerd.', text };
}

async function extractXlsx(buf) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const parts = [];
  let limited = false;
  wb.eachSheet((ws) => {
    parts.push(`## Werkblad: ${ws.name} (${ws.rowCount} rijen)`);
    let n = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (n++ >= 2000) { limited = true; return; }
      const vals = row.values.slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object') {
          if ('result' in v) return `${v.result ?? ''} [formule: ${v.formula ?? v.sharedFormula ?? ''}]`;
          if ('text' in v) return v.text;
          if (v instanceof Date) return v.toISOString();
          if ('richText' in v) return v.richText.map((t) => t.text).join('');
          return JSON.stringify(v);
        }
        return String(v);
      });
      parts.push(vals.join('\t'));
    });
  });
  return {
    status: limited ? 'GEDEELTELIJK' : 'GELEZEN',
    note: `Celwaarden${limited ? ' (max. 2000 rijen per werkblad)' : ''} geëxtraheerd; formules als tekst, opgeslagen formuleresultaten zoals in het bestand (niet herberekend), grafieken niet gelezen.`,
    text: parts.join('\n'),
  };
}

function extractZip(buf) {
  return new Promise((resolve) => {
    // decodeStrings: false → yauzl breekt niet af op één onveilige naam; wij valideren zelf per item.
    yauzl.fromBuffer(buf, { lazyEntries: true, validateEntrySizes: true, decodeStrings: false }, (err, zip) => {
      if (err) return resolve({ status: 'NIET_GELEZEN', note: `ZIP kon niet worden geopend: ${err.message}`, text: null });
      const listing = [];
      const texts = [];
      const skipped = [];
      let total = 0;
      let count = 0;
      const MAX_ENTRIES = 500;
      const MAX_TOTAL = 20 * 1024 * 1024;
      zip.on('entry', (entry) => {
        count++;
        if (count > MAX_ENTRIES) { skipped.push('(meer dan 500 items; rest niet gelezen)'); zip.close(); return finish(); }
        const name = Buffer.isBuffer(entry.fileName) ? entry.fileName.toString('utf8') : String(entry.fileName);
        listing.push(`${name} (${entry.uncompressedSize} bytes)`);
        const safe = sanitizeRelPath(name.replace(/\/$/, ''));
        const isDir = name.endsWith('/');
        if (isDir) return zip.readEntry();
        if (!safe) { skipped.push(`${name}: onveilig pad`); return zip.readEntry(); }
        const e = extOf(safe);
        if (!TEXT_EXT.has(e) && !SPECIAL_NAMES.has(e)) { skipped.push(`${safe}: type .${e} niet uitgepakt`); return zip.readEntry(); }
        if (total + entry.uncompressedSize > MAX_TOTAL) { skipped.push(`${safe}: limiet uitgepakte grootte bereikt`); return zip.readEntry(); }
        zip.openReadStream(entry, (e2, stream) => {
          if (e2) { skipped.push(`${safe}: ${e2.message}`); return zip.readEntry(); }
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', (e3) => { skipped.push(`${safe}: ${e3.message}`); zip.readEntry(); });
          stream.on('end', () => {
            const b = Buffer.concat(chunks);
            total += b.length;
            if (looksBinary(b)) skipped.push(`${safe}: binaire inhoud`);
            else texts.push(`--- ${safe}\n${b.toString('utf8')}`);
            zip.readEntry();
          });
        });
      });
      let done = false;
      function finish() {
        if (done) return;
        done = true;
        const text = `# Inhoud van ZIP\n${listing.join('\n')}\n\n# Uitgepakte tekstbestanden\n${texts.join('\n\n')}`;
        resolve({
          status: skipped.length ? 'GEDEELTELIJK' : 'GELEZEN',
          note: `${texts.length} tekstbestand(en) gelezen${skipped.length ? `; niet gelezen: ${skipped.slice(0, 15).join('; ')}${skipped.length > 15 ? ' …' : ''}` : ''}.`,
          text,
        });
      }
      zip.on('end', finish);
      zip.on('error', (e) => { skipped.push(`fout: ${e.message}`); finish(); });
      zip.readEntry();
    });
  });
}

// STEP (ISO 10303-21) is tekst: kop en entiteitstypen zijn betrouwbaar te lezen,
// geometrie (maten, volumes) vereist een CAD-kernel en wordt dus niet berekend.
export function extractStep(buf) {
  const text = buf.toString('latin1');
  const header = (text.match(/HEADER;([\s\S]*?)ENDSEC;/) || [])[1] || '';
  const counts = {};
  for (const m of text.matchAll(/^#\d+\s*=\s*([A-Z_0-9]+)\s*\(/gm)) counts[m[1]] = (counts[m[1]] || 0) + 1;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25);
  const products = [...text.matchAll(/PRODUCT\s*\(\s*'([^']*)'/g)].map((m) => m[1]).slice(0, 50);
  const units = [...new Set([...text.matchAll(/SI_UNIT\s*\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, '')))].slice(0, 10);
  const out = [
    '# STEP-kop', header.trim(),
    `\n# Statistieken\nAantal entiteiten: ${total}`,
    `Producten/onderdelen: ${products.join(', ') || '(geen gevonden)'}`,
    `SI-eenheden: ${units.join(' | ') || '(geen gevonden)'}`,
    '\n# Meest voorkomende entiteitstypen', ...top.map(([k, v]) => `${k}: ${v}`),
  ].join('\n');
  return {
    status: 'GEDEELTELIJK',
    note: 'STEP-kop, producten, eenheden en entiteit-statistieken gelezen. Geometrie (maten, volumes, massa) is NIET berekend: daarvoor is een CAD-kernel (bijv. OpenCascade) nodig die niet is geïnstalleerd.',
    text: out,
  };
}

export async function extractText(name, buf) {
  const e = extOf(name);
  try {
    if (e === 'pdf') return await extractPdf(buf);
    if (e === 'docx') return await extractDocx(buf);
    if (e === 'xlsx') return await extractXlsx(buf);
    if (e === 'zip') return await extractZip(buf);
    if (e === 'step' || e === 'stp') return extractStep(buf);
    if (looksBinary(buf)) return { status: 'NIET_GELEZEN', note: 'Bestand bevat binaire gegevens; niet als tekst gelezen.', text: null };
    return { status: 'GELEZEN', note: null, text: buf.toString('utf8') };
  } catch (err) {
    return { status: 'NIET_GELEZEN', note: `Fout bij lezen: ${err.message}`, text: null };
  }
}

function writeFileSafe(rel, data) {
  const abs = absStored(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

async function storeWithExtract({ jobId, relPath, storedRel, buf, origin, cycle }) {
  writeFileSafe(storedRel, buf);
  const ex = await extractText(relPath, buf);
  let note = ex.note;
  let status = ex.status;
  let extractRel = null;
  if (ex.text != null) {
    const t = truncate(ex.text);
    if (t.truncated) {
      status = 'GEDEELTELIJK';
      note = `${note ? note + ' ' : ''}Tekst afgekapt na ${config.maxExtractPerFile} tekens.`;
    }
    extractRel = path.posix.join('jobs', String(jobId), 'extract', `${crypto.randomUUID()}.txt`);
    writeFileSafe(extractRel, t.text);
  }
  const version = filesRepo.maxVersion(jobId, relPath) + 1;
  return filesRepo.add({
    job_id: jobId, path: relPath, version, cycle, origin, stored_path: storedRel,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length,
    read_status: status, read_note: note, extract_path: extractRel,
  });
}

export async function storeUpload(jobId, name, buf) {
  const storedRel = path.posix.join('jobs', String(jobId), 'uploads', name);
  return storeWithExtract({ jobId, relPath: name, storedRel, buf, origin: 'upload', cycle: 0 });
}

export async function storeGenerated(jobId, cycle, relPath, content) {
  const storedRel = path.posix.join('jobs', String(jobId), 'resultaat', `ronde-${cycle + 1}`, relPath);
  return storeWithExtract({ jobId, relPath, storedRel, buf: Buffer.from(content, 'utf8'), origin: 'claude', cycle });
}

// Bestanden met hun tekst, voor gebruik in prompts.
export function withText(rows) {
  return rows.map((r) => ({ ...r, text: readExtract(r) }));
}

export function removeJobFiles(jobId) {
  fs.rmSync(jobDir(jobId), { recursive: true, force: true });
}
