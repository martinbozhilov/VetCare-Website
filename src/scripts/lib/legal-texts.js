// Loads the VetCare app's legal texts from content/legal/ for scripts/build-legal.js: reads the
// manifest (legal-documents.json) strictly, checks every text against its SHA-256, parses and
// composes the documents the way the app's LegalDocumentLibrary does.
//
// The texts are the app's, copied byte for byte and never edited here (CLAUDE.md, "Legal page").
// This module must not import `marked` at load time: scripts/gen-sitemap.js requires it only for
// the LEGAL_SOURCES constant.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SRC } = require('./pages');

const LEGAL_SOURCES = 'content/legal';
const LEGAL_DIR = path.join(SRC, 'content', 'legal');
const MANIFEST = 'legal-documents.json';

// Same rule as blog-posts.js (not imported: that module pulls in sharp).
const LONG_DASH = /[—–]/;

// The app's LegalTextHash.OfText: UTF-8, leading BOMs dropped, every line ending turned into LF
// (exactly the ones .NET's ReplaceLineEndings recognises), SHA-256, lowercase hex.
function normalizeLegalText(buf) {
  return buf.toString('utf8')
    .replace(/^\uFEFF+/, '')
    .replace(/\r\n|[\r\n\u0085\u2028\u2029\f]/g, '\n');
}

function legalTextHash(buf) {
  return crypto.createHash('sha256').update(Buffer.from(normalizeLegalText(buf), 'utf8')).digest('hex');
}

// The app prints dates with DateExtensions.FormatDate = ToString("d", bg-BG) = d.MM.yyyy 'г'. on its
// aspnet:10.0 image: "5.03.2027 г." (day unpadded, month padded, an ordinary space before "г.").
// Written by hand rather than with Intl, whose output depends on Node's ICU data. The effective date
// is re-checked against app.vetcare.bg before merge (PR checklist), which would catch a different
// space character.
function formatBgDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d}.${String(m).padStart(2, '0')}.${y} г.`;
}

// ── Manifest ──────────────────────────────────────────────────────────────────────────────────
function onlyKeys(obj, keys, where) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${LEGAL_SOURCES}/${MANIFEST}: ${where} must be an object`);
  }
  const got = Object.keys(obj).sort().join(',');
  if (got !== [...keys].sort().join(',')) {
    throw new Error(`${LEGAL_SOURCES}/${MANIFEST}: ${where} has keys {${got}}, expected {${[...keys].sort().join(',')}}. `
      + 'The site reads the manifest strictly: a new field or a second release is the lifecycle work that waits for VetCare#495, '
      + 'so extend the build for it instead of working around this check');
  }
}

function readManifest() {
  const file = path.join(LEGAL_DIR, MANIFEST);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    throw new Error(`${LEGAL_SOURCES}/${MANIFEST}: cannot be read (${e.code || e.message}); copy it from the app (CLAUDE.md "Legal page")`);
  }
  let json;
  try { json = JSON.parse(raw); } catch (e) { throw new Error(`${LEGAL_SOURCES}/${MANIFEST}: not valid JSON (${e.message})`); }

  onlyKeys(json, ['releases'], 'the manifest');
  if (!Array.isArray(json.releases) || json.releases.length !== 1) {
    throw new Error(`${LEGAL_SOURCES}/${MANIFEST}: expected exactly one release, found ${Array.isArray(json.releases) ? json.releases.length : 'none'}. `
      + 'A second release is the lifecycle work (old versions, the upcoming sub-processor list) that waits for VetCare#495: build it, do not work around this check');
  }
  const rel = json.releases[0];
  onlyKeys(rel, ['effectiveDate', 'terms', 'dpa', 'subProcessors'], 'the release');
  onlyKeys(rel.terms, ['version', 'file', 'sha256'], 'terms');
  onlyKeys(rel.dpa, ['version', 'file', 'sha256', 'clauses', 'clausesSha256'], 'dpa');
  onlyKeys(rel.subProcessors, ['version', 'file', 'sha256'], 'subProcessors');

  const bad = (what, v) => { throw new Error(`${LEGAL_SOURCES}/${MANIFEST}: ${what} is invalid (${JSON.stringify(v)})`); };
  const version = (v, what) => { if (!Number.isInteger(v) || v < 1) bad(what, v); };
  const fileName = (v, what) => {
    if (typeof v !== 'string' || !/^[a-z0-9-]+\.md$/.test(v)) bad(what, v);
    if (!fs.existsSync(path.join(LEGAL_DIR, v))) throw new Error(`${LEGAL_SOURCES}/${v}: listed in ${MANIFEST} but missing`);
  };
  const hash = (v, what) => { if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) bad(what, v); };

  if (typeof rel.effectiveDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rel.effectiveDate)
    || Number.isNaN(Date.parse(rel.effectiveDate))
    || new Date(`${rel.effectiveDate}T00:00:00Z`).toISOString().slice(0, 10) !== rel.effectiveDate) {
    bad('effectiveDate', rel.effectiveDate);
  }
  version(rel.terms.version, 'terms.version');
  fileName(rel.terms.file, 'terms.file');
  hash(rel.terms.sha256, 'terms.sha256');
  version(rel.dpa.version, 'dpa.version');
  fileName(rel.dpa.file, 'dpa.file');
  hash(rel.dpa.sha256, 'dpa.sha256');
  fileName(rel.dpa.clauses, 'dpa.clauses');
  hash(rel.dpa.clausesSha256, 'dpa.clausesSha256');
  version(rel.subProcessors.version, 'subProcessors.version');
  fileName(rel.subProcessors.file, 'subProcessors.file');
  hash(rel.subProcessors.sha256, 'subProcessors.sha256');
  return rel;
}

function readText(fileName, want) {
  const buf = fs.readFileSync(path.join(LEGAL_DIR, fileName));
  const got = legalTextHash(buf);
  if (got !== want) {
    throw new Error(`${LEGAL_SOURCES}/${fileName}: SHA-256 ${got} does not match ${MANIFEST} (${want}). `
      + 'The texts are the app\'s: copy them again from the app commit (CLAUDE.md "Legal page"), never edit them here');
  }
  return normalizeLegalText(buf);
}

// ── Composition (mirrors LegalDocumentLibrary.Compose) ────────────────────────────────────────
const ALWAYS_DROP_TOKENS = /\{\{clinic\.(name|address)\}\}/;

function fill(runs, values, where) {
  return runs.map((r) => {
    const text = r.text.replace(/\{\{([A-Za-z0-9.]+)\}\}/g, (all, name) => {
      if (Object.prototype.hasOwnProperty.call(values, name)) return values[name];
      throw new Error(`${where}: the token {{${name}}} has no value on this page (no clinic, no acceptance, and no section is on)`);
    });
    if (/\{\{|\}\}/.test(text)) throw new Error(`${where}: "{{" or "}}" left after filling the tokens`);
    return { ...r, text };
  });
}

// `resolve(name)` returns the blocks an include expands to.
function compose(nodes, { values, file, resolve }) {
  const out = [];
  for (const node of nodes) {
    const where = `${LEGAL_SOURCES}/${file}:${node.line || ''}`;
    if (node.type === 'heading') {
      if (node.runs.some((r) => ALWAYS_DROP_TOKENS.test(r.text))) throw new Error(`${where}: a clinic token in a heading`);
      out.push({ type: 'heading', level: node.level, runs: fill(node.runs, values, where), line: node.line });
    } else if (node.type === 'paragraph') {
      if (node.section !== null) continue; // no section is on: the page has no contact, no acceptance
      if (node.runs.some((r) => ALWAYS_DROP_TOKENS.test(r.text))) continue; // no clinic on this page
      out.push({ type: 'paragraph', runs: fill(node.runs, values, where), line: node.line });
    } else if (node.type === 'bullets') {
      const items = node.items
        .filter((it) => it.section === null && !it.runs.some((r) => ALWAYS_DROP_TOKENS.test(r.text)))
        .map((it) => ({ runs: fill(it.runs, values, `${LEGAL_SOURCES}/${file}:${it.line}`), line: it.line }));
      if (items.length) out.push({ type: 'bullets', items }); // a list whose items all drop disappears
    } else if (node.type === 'table') {
      const cell = (runs) => {
        if (runs.some((r) => ALWAYS_DROP_TOKENS.test(r.text))) throw new Error(`${where}: a clinic token in a table cell`);
        return fill(runs, values, where);
      };
      out.push({ type: 'table', header: node.header.map(cell), rows: node.rows.map((row) => row.map(cell)), line: node.line });
    } else if (node.type === 'include') {
      out.push(resolve(node));
    } else {
      throw new Error(`${where}: unexpected ${node.type} in a document`);
    }
  }
  return out;
}

function firstHeading(blocks, id, what) {
  const h = blocks[0];
  if (!h || h.type !== 'heading' || h.level !== 1) {
    throw new Error(`${LEGAL_SOURCES}: ${what} must start with a level-1 heading (the anchor #${id} goes on it)`);
  }
  h.id = id;
  return h.runs.map((r) => r.text).join('');
}

async function loadLegal() {
  const rel = readManifest();
  const marked = await import('marked');
  const { makeInline, parseLegalMarkdown } = require('./legal-markdown');
  const inline = makeInline({ Lexer: marked.Lexer, getDefaults: marked.getDefaults });

  const termsText = readText(rel.terms.file, rel.terms.sha256);
  const dpaText = readText(rel.dpa.file, rel.dpa.sha256);
  const clausesText = readText(rel.dpa.clauses, rel.dpa.clausesSha256);
  const spText = readText(rel.subProcessors.file, rel.subProcessors.sha256);

  const warnings = [];
  const today = new Date().toISOString().slice(0, 10);
  const effectiveDateText = formatBgDate(rel.effectiveDate);
  if (rel.effectiveDate > today) {
    warnings.push(`effectiveDate ${rel.effectiveDate} is in the future: /legal shows "в сила от ${effectiveDateText}" as is`);
  }
  for (const [file, text] of [[rel.terms.file, termsText], [rel.dpa.file, dpaText], [rel.subProcessors.file, spText]]) {
    const at = text.split('\n').findIndex((l) => LONG_DASH.test(l));
    if (at >= 0) {
      warnings.push(`content/legal/${file} has a long dash on line ${at + 1}; the site renders the app's text unchanged, raise it in the app repo`);
    }
  }

  const parse = (text, file, kind) => parseLegalMarkdown(text, file, { inline, kind });
  const termsNodes = parse(termsText, rel.terms.file, 'document');
  const dpaNodes = parse(dpaText, rel.dpa.file, 'document');
  const clausesNodes = parse(clausesText, rel.dpa.clauses, 'clauses');
  const spNodes = parse(spText, rel.subProcessors.file, 'document');

  // With one release, the list in effect was introduced by that release (LegalDocumentCatalog.cs).
  const dpaValues = { version: String(rel.dpa.version), effectiveDate: effectiveDateText, lastChanged: effectiveDateText };
  const spValues = { version: String(rel.subProcessors.version), effectiveDate: effectiveDateText, lastChanged: effectiveDateText };

  const terms = {
    blocks: compose(termsNodes, {
      values: { version: String(rel.terms.version), effectiveDate: effectiveDateText },
      file: rel.terms.file,
      resolve: (n) => { throw new Error(`${LEGAL_SOURCES}/${rel.terms.file}:${n.line}: the terms take no includes`); },
    }),
  };
  const subBlocks = compose(spNodes, {
    values: spValues,
    file: rel.subProcessors.file,
    resolve: (n) => { throw new Error(`${LEGAL_SOURCES}/${rel.subProcessors.file}:${n.line}: the sub-processor list takes no includes`); },
  });
  const dpa = {
    blocks: compose(dpaNodes, {
      values: dpaValues,
      file: rel.dpa.file,
      resolve: (n) => (n.name === 'clauses'
        ? { type: 'group', name: 'clauses', glue: false, blocks: clausesNodes }
        : { type: 'group', name: 'sub-processors', glue: true, blocks: subBlocks }),
    }),
  };

  terms.title = firstHeading(terms.blocks, 'obshti-usloviya', rel.terms.file);
  dpa.title = firstHeading(dpa.blocks, 'dogovor-za-obrabotvane', rel.dpa.file);
  const subGroup = dpa.blocks.find((b) => b.type === 'group' && b.name === 'sub-processors');
  if (!subGroup || !subGroup.blocks[0] || subGroup.blocks[0].type !== 'heading') {
    throw new Error(`${LEGAL_SOURCES}/${rel.dpa.file}: the sub-processors include must come with a heading (the anchor #podizpalniteli goes on it)`);
  }
  subGroup.blocks[0].id = 'podizpalniteli';

  terms.text = termsText;
  dpa.text = dpaText;
  dpa.clausesText = clausesText;
  dpa.values = dpaValues;
  return {
    effectiveDate: rel.effectiveDate,
    effectiveDateText,
    terms: { ...terms, version: rel.terms.version, values: { version: String(rel.terms.version), effectiveDate: effectiveDateText } },
    dpa: { ...dpa, version: rel.dpa.version },
    subProcessors: { version: rel.subProcessors.version, text: spText, values: spValues },
    clausesText,
    warnings,
  };
}

module.exports = { LEGAL_DIR, LEGAL_SOURCES, normalizeLegalText, legalTextHash, formatBgDate, loadLegal };
