// Eenheidstests voor parsing, statische controles, diff, zip, extractie en logging.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-unit-'));
const { parseAnalysis, parseFiles, parseReview, sanitizeRelPath } = await import('../src/parse.js');
const { checkHtml, isComposeFile } = await import('../src/checks.js');
const { lineDiff } = await import('../src/diff.js');
const { buildZip } = await import('../src/zip.js');
const { extractText, extractStep, validateContent, safeUploadName, isAllowedUpload } = await import('../src/files.js');
const { redact } = await import('../src/log.js');

test('analyse: markeringen worden herkend', () => {
  const r = parseAnalysis('intro\n===ANALYSE===\nA\n===EINDE ANALYSE===\n===ACCEPTATIECRITERIA===\n- c1\n===EINDE ACCEPTATIECRITERIA===\n===PROMPT VOOR CLAUDE===\nDoe X\n===EINDE PROMPT VOOR CLAUDE===');
  assert.equal(r.type, 'prompt');
  assert.equal(r.prompt, 'Doe X');
  assert.equal(r.criteria, '- c1');
  assert.deepEqual(r.warnings, []);
});

test('analyse: vetgedrukte markeringen uit ChatGPT-kopie', () => {
  const r = parseAnalysis('**===PROMPT VOOR CLAUDE===**\nDoe Y\n**===EINDE PROMPT VOOR CLAUDE===**');
  assert.equal(r.prompt, 'Doe Y');
});

test('analyse: zonder markeringen geen verzonnen prompt maar waarschuwing', () => {
  const r = parseAnalysis('Gewoon wat tekst');
  assert.equal(r.prompt, 'Gewoon wat tekst');
  assert.ok(r.warnings.some((w) => w.includes('Geen gemarkeerde prompt')));
});

test('analyse: verduidelijkingsvragen', () => {
  const r = parseAnalysis('===VERDUIDELIJKING NODIG===\n1. Welke poort?\n2. Welke host?\n===EINDE VERDUIDELIJKING===');
  assert.equal(r.type, 'verduidelijking');
  assert.equal(r.questions.length, 2);
});

test('bestanden: kopjes, geneste omheining, onveilige paden', () => {
  const ans = [
    '### BESTAND: index.html', '```html', '<p>a</p>', '```',
    '### BESTAND: docs/README.md', '````markdown', '```bash', 'ls', '```', '````',
    '### BESTAND: ../etc/passwd', '```', 'x', '```',
  ].join('\n');
  const r = parseFiles(ans);
  assert.deepEqual(r.files.map((f) => f.path), ['index.html', 'docs/README.md']);
  assert.ok(r.files[1].content.includes('```bash'));
  assert.ok(r.warnings.some((w) => w.includes('onveilig')));
});

test('bestanden: codeblokken zonder kopje worden niet stilzwijgend opgeslagen', () => {
  const r = parseFiles('Hier:\n```js\nconsole.log(1)\n```');
  assert.equal(r.files.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('padcontrole', () => {
  assert.equal(sanitizeRelPath('a/b.txt'), 'a/b.txt');
  assert.equal(sanitizeRelPath('/abs'), null);
  assert.equal(sanitizeRelPath('C:/x'), null);
  assert.equal(sanitizeRelPath('a/../b'), null);
  assert.equal(sanitizeRelPath('a\\b.txt'), 'a/b.txt');
});

test('review: geldig, ongeldig en tegenstrijdig', () => {
  const ok = parseReview('tekst\n===REVIEW JSON===\n{"oordeel":"AFGEKEURD","samenvatting":"s","criteria":[],"problemen":[{"ernst":"hoog","beschrijving":"b"}]}\n===EINDE REVIEW JSON===');
  assert.equal(ok.ok, true);
  assert.equal(ok.verdict, 'AFGEKEURD');
  assert.equal(ok.issues[0].severity, 'hoog');
  assert.equal(parseReview('geen json').ok, false);
  assert.equal(parseReview('===REVIEW JSON===\n{kapot\n===EINDE REVIEW JSON===').ok, false);
  const contra = parseReview('===REVIEW JSON===\n{"oordeel":"GOEDGEKEURD","problemen":[{"ernst":"kritiek","beschrijving":"x"}]}\n===EINDE REVIEW JSON===');
  assert.equal(contra.verdict, 'AFGEKEURD');
  const fenced = parseReview('```json\n{"oordeel":"GOEDGEKEURD","problemen":[]}\n```');
  assert.equal(fenced.verdict, 'GOEDGEKEURD');
});

test('HTML-controle vindt ontbrekende id-verwijzing', () => {
  const good = '<!DOCTYPE html><html><body><input id="a"><button id="b">x</button><div id="c"></div><script>document.getElementById("a");document.querySelector("#c")</script></body></html>';
  assert.equal(checkHtml(good).status, 'GESLAAGD');
  assert.equal(checkHtml(good).inlineScripts.length, 1);
  const bad = good.replace('id="c"', 'id="d"');
  const r = checkHtml(bad);
  assert.equal(r.status, 'MISLUKT');
  assert.match(r.output, /niet-bestaande id's: c/);
  assert.equal(checkHtml('<!doctype html><div><span></div>').status, 'MISLUKT');
});

test('compose-herkenning', () => {
  assert.ok(isComposeFile('compose.yaml'));
  assert.ok(isComposeFile('deploy/docker-compose.prod.yml'));
  assert.ok(!isComposeFile('config.yaml'));
});

test('diff', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
});

test('zip is leesbaar met yauzl', async () => {
  const yauzl = (await import('yauzl')).default;
  const buf = buildZip([{ name: 'a.txt', data: 'hallo' }, { name: 'map/b.txt', data: 'wereld' }]);
  const names = await new Promise((res, rej) => yauzl.fromBuffer(buf, { lazyEntries: true }, (e, z) => {
    if (e) return rej(e);
    const n = [];
    z.on('entry', (en) => { n.push(en.fileName); z.readEntry(); });
    z.on('end', () => res(n));
    z.readEntry();
  }));
  assert.deepEqual(names, ['a.txt', 'map/b.txt']);
});

test('extractie: ZIP met tekst en onveilig pad', async () => {
  const buf = buildZip([{ name: 'src/app.py', data: 'print(1)' }, { name: '../evil.txt', data: 'x' }, { name: 'img.png', data: Buffer.from([0, 1, 2]) }]);
  const r = await extractText('x.zip', buf);
  assert.equal(r.status, 'GEDEELTELIJK');
  assert.match(r.text, /print\(1\)/);
  assert.match(r.note, /onveilig pad/);
});

test('extractie: STEP-kop en entiteiten, geometrie expliciet niet berekend', () => {
  const step = "ISO-10303-21;\nHEADER;\nFILE_NAME('part.step','2024',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\n#1=PRODUCT('Beugel','Beugel','',(#2));\n#3=CARTESIAN_POINT('',(0.,0.,0.));\n#4=CARTESIAN_POINT('',(1.,0.,0.));\nENDSEC;\nEND-ISO-10303-21;";
  const r = extractStep(Buffer.from(step));
  assert.equal(r.status, 'GEDEELTELIJK');
  assert.match(r.text, /CARTESIAN_POINT: 2/);
  assert.match(r.text, /Beugel/);
  assert.match(r.note, /NIET berekend/);
});

test('extractie: PDF zonder tekstlaag wordt niet als gelezen gemeld', async () => {
  const r = await extractText('x.pdf', Buffer.from('%PDF-1.4 kapot'));
  assert.equal(r.status, 'NIET_GELEZEN');
});

test('uploadvalidatie', () => {
  assert.equal(safeUploadName('../../x.txt'), 'x.txt');
  assert.ok(isAllowedUpload('Dockerfile'));
  assert.ok(isAllowedUpload('a.step'));
  assert.ok(!isAllowedUpload('a.exe'));
  assert.ok(validateContent('a.pdf', Buffer.from('nee')));
  assert.equal(validateContent('a.pdf', Buffer.from('%PDF-1.7')), null);
  assert.ok(validateContent('a.docx', Buffer.from('nee')));
});

test('logging maskeert geheimen maar laat gewone tekst staan', () => {
  assert.doesNotMatch(redact('key sk-abcdefghijklmnop123'), /abcdefghijklmnop/);
  assert.doesNotMatch(redact('password=geheim123'), /geheim123/);
  assert.doesNotMatch(redact('Authorization: Bearer abc.def'), /abc\.def/);
  assert.match(redact('SESSION_SECRET niet gezet'), /niet gezet/);
});
