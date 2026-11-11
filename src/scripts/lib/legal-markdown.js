// Reader for the VetCare app's legal texts (content/legal/*.md): a STRICT SUBSET of the app's own
// grammar, which is LegalMarkdownParser.cs in the app repo.
//
// Design, the same as the app's: a Markdown library parses the whole text (the app uses Markdig with
// pipe tables and definition lists on; this file uses markdown-it, the `commonmark` preset plus tables
// plus markdown-it-deflist), then an ALLOW-LIST maps the library's tokens to the site's nodes and
// everything it doesn't map is refused with file and line. The preset is chosen so that every
// CommonMark construct is recognised (block quotes, code, HTML, rules, ordered lists, links...) and
// can therefore be refused instead of slipping through as plain text; linkify and the typographer
// are off, so a bare URL stays text, as Markdig keeps it.
//
// Where the two libraries disagree the parser must not guess. markdown-it-deflist (Pandoc syntax)
// and markdown-it's tables accept forms that Markdig (PHP Markdown Extra syntax) refuses or reads
// differently, so a handful of RAW-LINE CHECKS run against the source lines the tokens point at:
// a label's previous line, the exact ":" marker and the four-space indentation of an item's content
// (markdown-it silently joins a less indented line to the paragraph above), the nesting depth, the
// "|" rows of a table, and edge spaces (markdown-it trims with String.trim(), which also drops
// U+00A0; Markdig does not). The backslash
// and entity refusals also read the raw source of each block, since markdown-it would turn an
// escape or an entity into plain text.
//
// Two refusals of the earlier hand-written parser are gone because markdown-it implements the
// CommonMark rule exactly as Markdig does, so it renders what the app renders: a heading's closing
// "#" sequence, and a line that merely looks like an ordered list item inside a paragraph (only
// "1." can interrupt a paragraph).
//
// "Strict" means: anything the app might accept but this parser doesn't implement is an error with
// file and line, never a guess. A loud failure can't publish a text that differs from the app's.
// If a new app text fails here, extend this parser to match the app; never edit the text.

const MarkdownIt = require('markdown-it');
const deflist = require('markdown-it-deflist');

const BACKSLASH = String.fromCharCode(92);

// Copies of the app's three sets (LegalMarkdownParser.cs): the tokens a text may use, the section
// markers ({{#name}}...{{/name}} around a whole paragraph or bullet item) and the includes.
const TOKENS = new Set(['version', 'effectiveDate', 'lastChanged', 'clinic.name', 'clinic.address',
  'contact.name', 'contact.email', 'acceptance.time']);
const SECTIONS = new Set(['contact', 'acceptance']);
const INCLUDES = new Set(['clauses', 'sub-processors']);

const SUFFIX = '; the site renders a strict subset of the app\'s grammar (scripts/lib/legal-markdown.js), so extend it to match LegalMarkdownParser.cs, never edit the text';

const err = (file, line, reason) => new Error(`${file}:${line}: ${reason}${SUFFIX}`);

// Spaces and tabs only: String.trim() would also eat U+00A0, which the Commission's text uses.
const trimST = (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const isBlank = (s) => /^[ \t]*$/.test(s);

const md = new MarkdownIt('commonmark').enable('table').use(deflist);

const plain = (runs) => runs.map((r) => r.text).join('');

// Mirrors CheckTokens: every {{name}} must be a known token and no stray braces may remain.
function checkTokens(runs, file, line, { kind, inItem }) {
  for (const r of runs) {
    if (!r.text.includes('{{') && !r.text.includes('}}')) continue;
    if (kind === 'clauses') throw err(file, line, 'a "{{" in the clauses (they take no tokens)');
    if (inItem) throw err(file, line, 'a token inside a labelled item (the app\'s Fill never descends into one, so it would stay unfilled)');
    for (const m of r.text.matchAll(/\{\{([A-Za-z0-9.]+)\}\}/g)) {
      if (!TOKENS.has(m[1])) throw err(file, line, `unknown token {{${m[1]}}}`);
    }
    if (/\{\{|\}\}/.test(r.text.replace(/\{\{[A-Za-z0-9.]+\}\}/g, ''))) {
      throw err(file, line, 'a stray "{{" or "}}"');
    }
  }
}

// Mirrors TakeSection: {{#name}}...{{/name}} around a whole paragraph or bullet item.
function takeSection(runs, file, line) {
  if (!runs.length) return { runs, section: null };
  const first = runs[0].text.match(/^\{\{#([a-z]+)\}\}/);
  const last = runs[runs.length - 1].text.match(/\{\{\/([a-z]+)\}\}$/);
  if (!first && !last) return { runs, section: null };
  if (!first || !last || first[1] !== last[1] || !SECTIONS.has(first[1])) {
    throw err(file, line, 'unknown or unbalanced section marker');
  }
  const out = runs.map((r) => ({ ...r }));
  out[0].text = out[0].text.slice(first[0].length);
  out[out.length - 1].text = out[out.length - 1].text.slice(0, -last[0].length);
  return { runs: out.filter((r) => r.text !== ''), section: first[1] };
}

const ATX = /^ {0,3}#{1,6}([ \t]|$)/;
// What may precede a block's text on its first source line: indentation and the marker of an ATX
// heading, a bullet or a definition.
const LINE_PREFIX = /^[ \t]*(?:(?:#{1,6}|-|:)[ \t]+)?/;

// `text` is already normalised (BOM dropped, every line ending an LF). `kind` is 'document' (terms,
// DPA wrapper, sub-processor list) or 'clauses' (the Commission's text: headings, paragraphs and
// labelled items only, no tokens, no includes).
function parseLegalMarkdown(text, file, { kind }) {
  const lines = text.split('\n');
  const env = {};
  const tokens = md.parse(text, env);

  // A link reference definition produces no token at all, so the text would vanish unnoticed.
  if (Object.keys(env.references || {}).length) {
    const at = lines.findIndex((l) => /^ {0,3}\[[^\]]+\]:/.test(l));
    throw err(file, at + 1, 'a link reference definition');
  }

  // Index of the token that closes the block opened at `i`.
  function closeOf(i) {
    let depth = 0;
    for (let j = i; j < tokens.length; j += 1) {
      depth += tokens[j].nesting;
      if (depth === 0) return j;
    }
    throw new Error(`${file}: unbalanced token stream`);
  }

  // Raw checks on the source lines [from, to) of one block (0-based).
  function checkEdges(from, to) {
    for (let ln = from; ln < to; ln += 1) {
      const s = trimST(lines[ln].replace(LINE_PREFIX, ''));
      if (s !== s.trim()) throw err(file, ln + 1, 'a line that starts or ends with a no-break space');
    }
  }

  // The backslash and entity refusals, on the raw source of an inline token (`line` is the 1-based
  // line of its first source line).
  function checkRaw(inline, line) {
    inline.content.split('\n').forEach((s, k) => {
      if (s.includes(BACKSLASH)) {
        throw err(file, line + k, 'a backslash (the app\'s escapes are a construct the site doesn\'t implement)');
      }
      if (/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(s)) {
        throw err(file, line + k, 'an HTML entity reference (the app refuses it; markdown-it would decode it)');
      }
    });
  }

  // The rows of a paragraph's inline token: every source line is its own paragraph in the app (no
  // soft wrapping). Row = { runs, line }. Adjacent runs with the same style merge and empty runs are
  // dropped, as in the app's AddInline.
  function rowsOf(inline, line) {
    checkRaw(inline, line);
    const rows = [];
    let runs = [];
    let breaks = 0;
    let em = 0;
    let strong = 0;
    let rowLine = line;
    const flush = () => {
      const merged = [];
      for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
        else merged.push({ ...r });
      }
      const kept = merged.filter((r) => r.text !== '');
      if (kept.length) rows.push({ runs: kept, line: rowLine });
      runs = [];
    };
    for (const c of inline.children) {
      if (c.type === 'text') runs.push({ text: c.content, bold: strong > 0, italic: em > 0 });
      else if (c.type === 'em_open') em += 1;
      else if (c.type === 'em_close') em -= 1;
      else if (c.type === 'strong_open') strong += 1;
      else if (c.type === 'strong_close') strong -= 1;
      else if (c.type === 'softbreak' || c.type === 'hardbreak') {
        if (em > 0 || strong > 0) throw err(file, line + breaks, 'emphasis across two lines (the app refuses it)');
        flush();
        breaks += 1;
        rowLine = line + breaks;
      } else {
        throw err(file, line + breaks, `inline construct "${c.type}" (${JSON.stringify(c.markup || c.content)}) is not supported`);
      }
    }
    flush();
    return rows;
  }

  // The runs of a heading, a table cell or a label: always one source line.
  const runsOf = (inline, line) => rowsOf(inline, line).flatMap((r) => r.runs);

  // Cells of a raw table line, split the way the app's reader sees them.
  const rawCells = (s) => {
    let t = trimST(s);
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|');
  };

  function table(i, ctx) {
    const t = tokens[i];
    const [start, end] = t.map;
    const raw = (ln) => lines[ln].replace(/^ +/, '');
    if (!raw(start).startsWith('|')) throw err(file, start + 1, 'a table row that does not start with "|"');
    const width = rawCells(lines[start]).length;
    for (let ln = start + 2; ln < end; ln += 1) {
      if (!raw(ln).startsWith('|')) throw err(file, ln + 1, 'a table row that does not start with "|"');
      const n = rawCells(lines[ln]).length;
      if (n !== width) throw err(file, ln + 1, `a table row with ${n} cells under a header of ${width}`);
    }
    for (let ln = start; ln < end; ln += 1) {
      if (ln === start + 1) continue;
      for (const c of rawCells(lines[ln])) {
        const s = trimST(c);
        if (s !== s.trim()) throw err(file, ln + 1, 'a line that starts or ends with a no-break space');
      }
    }
    const rows = [];
    const stop = closeOf(i);
    for (let j = i + 1; j < stop; j += 1) {
      if (tokens[j].type !== 'tr_open') continue;
      const line = tokens[j].map[0] + 1;
      const cells = [];
      for (let k = j + 1; tokens[k].type !== 'tr_close'; k += 1) {
        if (tokens[k].type !== 'inline') continue;
        const runs = runsOf(tokens[k], line);
        checkTokens(runs, file, line, { kind, inItem: ctx.inItem });
        cells.push(runs);
      }
      rows.push(cells);
    }
    return { type: 'table', header: rows[0], rows: rows.slice(1), line: start + 1 };
  }

  // A labelled item, found at block depth `d`: one dt, one dd, `:` and three spaces, content
  // indented by four spaces per level.
  function definitions(i, d) {
    const stop = closeOf(i);
    const nodes = [];
    let j = i + 1;
    while (j < stop) {
      const dt = tokens[j];
      if (dt.type !== 'dt_open') throw err(file, tokens[j].map ? tokens[j].map[0] + 1 : 0, `the Markdown construct "${dt.type}" is not supported`);
      const dtLine = dt.map[0];
      if (d >= 2) throw err(file, dtLine + 1, 'a third level of items');
      if (dtLine > 0 && !isBlank(lines[dtLine - 1]) && !ATX.test(lines[dtLine - 1])) {
        throw err(file, dtLine + 1, 'a label line directly after a line of text');
      }
      const inline = tokens[j + 1];
      checkRaw(inline, dtLine + 1);
      if (inline.children.some((c) => c.type !== 'text') || /[*_{}]/.test(inline.content)) {
        throw err(file, dtLine + 1, 'a label with emphasis or braces (labels are plain text)');
      }
      checkEdges(dtLine, dtLine + 1);
      const label = trimST(inline.content);
      j = closeOf(j) + 1;

      const dds = [];
      while (j < stop && tokens[j].type === 'dd_open') { dds.push(j); j = closeOf(j) + 1; }
      if (dds.length !== 1) throw err(file, dtLine + 1, 'a second definition for one label');
      const dd = tokens[dds[0]];
      // dd.map[0] is not the marker's line for every item but the first (markdown-it-deflist starts it
      // at the label), so the line comes from the first block of the content, which starts on it.
      const from = tokens[dds[0] + 1].map[0];
      const to = dd.map[1];
      if (from !== dtLine + 1) throw err(file, from + 1, 'a blank line between a label and its content');
      if (!new RegExp(`^ {${4 * d}}: {3}\\S`).test(lines[from])) {
        throw err(file, from + 1, 'a definition marker other than ":" and three spaces');
      }
      const indent = ' '.repeat(4 * (d + 1));
      for (let ln = from + 1; ln < to; ln += 1) {
        if (!isBlank(lines[ln]) && !lines[ln].startsWith(indent)) {
          throw err(file, ln + 1, 'a lazy continuation line (Markdig would join it to the paragraph above)');
        }
      }
      const content = walk(dds[0] + 1, closeOf(dds[0]), d + 1, { inItem: true });
      nodes.push({ type: 'item', label, content, line: dtLine + 1 });
    }
    return nodes;
  }

  function bullets(i, d) {
    const list = tokens[i];
    const line = list.map[0] + 1;
    if (list.markup !== '-') throw err(file, line, 'a "*" or "+" bullet list');
    if (d !== 0 || kind !== 'document') throw err(file, line, 'a bullet list here (only top-level lists in the terms, the DPA and the sub-processor list)');
    const items = [];
    const stop = closeOf(i);
    let j = i + 1;
    while (j < stop) {
      const open = tokens[j];
      const end = closeOf(j);
      const itemLine = open.map[0] + 1;
      const inner = tokens.slice(j + 1, end);
      if (inner.length !== 3 || inner[0].type !== 'paragraph_open') throw err(file, itemLine, 'a bullet item is one line of text');
      checkEdges(inner[0].map[0], inner[0].map[1]);
      const rows = rowsOf(inner[1], itemLine);
      if (rows.length !== 1 || inner[0].map[1] - inner[0].map[0] !== 1) throw err(file, itemLine, 'a bullet item is one line of text');
      const sec = takeSection(rows[0].runs, file, itemLine);
      checkTokens(sec.runs, file, itemLine, { kind, inItem: false });
      items.push({ runs: sec.runs, section: sec.section, line: itemLine });
      j = end + 1;
    }
    return { type: 'bullets', items };
  }

  function paragraph(i, d, ctx, nodes) {
    const open = tokens[i];
    const line = open.map[0] + 1;
    checkEdges(open.map[0], open.map[1]);
    const top = kind === 'document' && d === 0;
    const rows = rowsOf(tokens[i + 1], line);
    rows.forEach((row, k) => {
      const s = plain(row.runs);
      if (/^:([ \t]|$)/.test(s)) {
        throw err(file, row.line, k > 0 ? 'a label line directly after a line of text' : 'a definition without a label above it');
      }
      const inc = row.runs.length === 1 && !row.runs[0].bold && !row.runs[0].italic ? s.match(/^\{\{> ([a-z-]+)\}\}$/) : null;
      if (inc) {
        if (d !== 0 || kind !== 'document' || !INCLUDES.has(inc[1])) {
          throw err(file, row.line, `an include "${inc[1]}" here`);
        }
        nodes.push({ type: 'include', name: inc[1], line: row.line });
        return;
      }
      if (/\{\{>/.test(s)) throw err(file, row.line, 'an include that is not alone on its line');
      let runs = row.runs;
      let section = null;
      if (top) {
        const sec = takeSection(runs, file, row.line);
        runs = sec.runs;
        section = sec.section;
        checkTokens(runs, file, row.line, { kind, inItem: false });
      } else {
        checkTokens(runs, file, row.line, { kind, inItem: ctx.inItem });
      }
      nodes.push({ type: 'paragraph', runs, section, line: row.line });
    });
  }

  // The allow-list: maps the blocks in tokens[from, to) at depth `d` (0 at the top, 1 inside an
  // item, 2 inside a nested item) and refuses every other construct.
  function walk(from, to, d, ctx) {
    const nodes = [];
    let i = from;
    while (i < to) {
      const t = tokens[i];
      const line = t.map ? t.map[0] + 1 : 0;
      switch (t.type) {
        case 'paragraph_open':
          paragraph(i, d, ctx, nodes);
          i = closeOf(i) + 1;
          break;
        case 'heading_open': {
          if (t.markup === '######') throw err(file, line, 'a level 6 heading');
          if (t.markup === '=' || t.markup === '-') throw err(file, t.map[1], 'a setext heading');
          checkEdges(t.map[0], t.map[1]);
          const runs = runsOf(tokens[i + 1], line);
          checkTokens(runs, file, line, { kind, inItem: ctx.inItem });
          nodes.push({ type: 'heading', level: t.markup.length, runs, line });
          i = closeOf(i) + 1;
          break;
        }
        case 'bullet_list_open':
          nodes.push(bullets(i, d));
          i = closeOf(i) + 1;
          break;
        case 'table_open':
          nodes.push(table(i, ctx));
          i = closeOf(i) + 1;
          break;
        case 'dl_open':
          nodes.push(...definitions(i, d));
          i = closeOf(i) + 1;
          break;
        case 'ordered_list_open': throw err(file, line, 'an ordered list');
        case 'blockquote_open': throw err(file, line, 'a block quote');
        case 'code_block': throw err(file, line, 'indented code');
        case 'fence': throw err(file, line, 'a fenced code block');
        case 'hr': throw err(file, line, 'a thematic break');
        case 'html_block': throw err(file, line, 'raw HTML');
        default: throw err(file, line, `the Markdown construct "${t.type}" is not supported`);
      }
    }
    return nodes;
  }

  return walk(0, tokens.length, 0, { inItem: false });
}

module.exports = { TOKENS, SECTIONS, INCLUDES, parseLegalMarkdown, plain, trimST };
