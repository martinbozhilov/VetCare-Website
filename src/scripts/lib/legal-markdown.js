// Parser for the VetCare app's legal texts (content/legal/*.md): a STRICT SUBSET of the app's own
// grammar, which is LegalMarkdownParser.cs in the app repo (it reads the files with Markdig, with pipe
// tables and definition lists on, and refuses every construct it doesn't map).
//
// Why a dedicated parser and not a `marked` extension: the app's grammar is line-oriented ("every
// line is its own paragraph"), and four of its constructs fight marked's block lexer (soft-wrapped
// paragraphs, indented code, lazy continuation, definition lists). A small parser mirrors the app's
// block model one to one (heading, paragraph, bullet list, table, labelled item) and refuses
// everything else by construction. Emphasis is the one subtle CommonMark rule (delimiter runs,
// flanking, the rule of 3), so inline text goes through marked's inline lexer, which implements it.
//
// "Strict" means: anything the app might accept but this parser doesn't implement is an error with
// file and line, never a guess. A loud failure can't publish a text that differs from the app's.
// If a new app text fails here, extend this parser to match the app; never edit the text.

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

// ── Inline ────────────────────────────────────────────────────────────────────────────────────
// Run = { text, bold, italic }. `Lexer` and `getDefaults` come from marked (an ES module, loaded by
// the caller with `await import('marked')`).
function makeInline({ Lexer, getDefaults }) {
  // gfm: false matters: GFM would autolink bare URLs, which Markdig, as the app configures it,
  // keeps as text.
  const options = { ...getDefaults(), gfm: false };

  function walk(tokens, bold, italic, out, file, line) {
    for (const t of tokens) {
      if (t.type === 'text') out.push({ text: t.raw, bold, italic });
      else if (t.type === 'strong') walk(t.tokens, true, italic, out, file, line);
      else if (t.type === 'em') walk(t.tokens, bold, true, out, file, line);
      else throw err(file, line, `inline construct "${t.type}" (${JSON.stringify(t.raw)}) is not supported`);
    }
  }

  return function inline(text, file, line) {
    if (text.includes(BACKSLASH)) {
      throw err(file, line, 'a backslash (the app\'s escapes are a construct the site doesn\'t implement)');
    }
    if (/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(text)) {
      throw err(file, line, 'an HTML entity reference (the app refuses it; marked would decode it)');
    }
    const raw = [];
    walk(Lexer.lexInline(text, options), false, false, raw, file, line);
    // Adjacent runs with the same style merge, as in the app's AddInline.
    const runs = [];
    for (const r of raw) {
      const last = runs[runs.length - 1];
      if (last && last.bold === r.bold && last.italic === r.italic) last.text += r.text;
      else runs.push({ ...r });
    }
    return runs.filter((r) => r.text !== '');
  };
}

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

// ── Blocks ────────────────────────────────────────────────────────────────────────────────────
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*$/;
const TABLE_DELIM = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const THEMATIC = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const ORDERED = /^\d{1,9}[.)]([ \t]|$)/;

// `text` is already normalised (BOM dropped, every line ending an LF). `kind` is 'document' (terms,
// DPA wrapper, sub-processor list) or 'clauses' (the Commission's text: headings, paragraphs and
// labelled items only, no tokens, no includes).
function parseLegalMarkdown(text, file, { inline, kind }) {
  const lines = text.split('\n').map((s, i) => ({ s, n: i + 1 }));

  // With `sections` the caller strips {{#name}}...{{/name}} markers and checks the tokens itself.
  function runsOf(s, n, ctx, { sections = false } = {}) {
    const runs = inline(s, file, n);
    if (!sections) checkTokens(runs, file, n, { kind, inItem: ctx.inItem });
    return runs;
  }

  function parseBlocks(buf, d, ctx) {
    const nodes = [];
    let i = 0;
    while (i < buf.length) {
      const { s, n } = buf[i];
      if (isBlank(s)) { i += 1; continue; }

      // 1. Indented code
      if (/^( {4}|\t)/.test(s)) throw err(file, n, 'indented code');

      // 2. ATX heading
      const h = s.match(HEADING);
      if (h) {
        if (h[1].length === 6) throw err(file, n, 'a level 6 heading');
        if (/(^|[ \t])#+$/.test(h[2])) throw err(file, n, 'a heading with a closing "#" sequence');
        nodes.push({ type: 'heading', level: h[1].length, runs: runsOf(h[2], n, ctx), line: n });
        i += 1;
        continue;
      }

      // Thematic break (before the bullet rule: "- - -" is one, not a list)
      if (THEMATIC.test(s)) throw err(file, n, 'a thematic break');

      // 3. Bullet list
      if (s.startsWith('- ')) {
        if (d !== 0 || kind !== 'document') throw err(file, n, 'a bullet list here (only top-level lists in the terms, the DPA and the sub-processor list)');
        const items = [];
        let j = i;
        while (j < buf.length) {
          const cur = buf[j];
          const body = trimST(cur.s.replace(/^- +/, ''));
          const runs = runsOf(body, cur.n, ctx, { sections: true });
          const sec = takeSection(runs, file, cur.n);
          checkTokens(sec.runs, file, cur.n, { kind, inItem: false });
          items.push({ runs: sec.runs, section: sec.section, line: cur.n });
          // find what follows the item
          let k = j + 1;
          while (k < buf.length && isBlank(buf[k].s)) k += 1;
          if (k >= buf.length) { j = k; break; }
          const nxt = buf[k];
          if (nxt.s.startsWith('- ')) { j = k; continue; }
          if (k === j + 1 && !HEADING.test(nxt.s)) {
            throw err(file, nxt.n, 'a bullet item is one line of text');
          }
          j = k;
          break;
        }
        nodes.push({ type: 'bullets', items });
        i = j;
        continue;
      }

      // 4. Table
      if (s.startsWith('|') && i + 1 < buf.length && TABLE_DELIM.test(buf[i + 1].s)) {
        const cells = (row) => {
          let t = trimST(row.s);
          if (t.startsWith('|')) t = t.slice(1);
          if (t.endsWith('|')) t = t.slice(0, -1);
          return t.split('|').map((c) => runsOf(trimST(c), row.n, ctx));
        };
        const header = cells(buf[i]);
        let j = i + 2;
        const rows = [];
        while (j < buf.length && !isBlank(buf[j].s)) {
          if (!buf[j].s.startsWith('|')) throw err(file, buf[j].n, 'a table row that does not start with "|"');
          const row = cells(buf[j]);
          if (row.length !== header.length) {
            throw err(file, buf[j].n, `a table row with ${row.length} cells under a header of ${header.length}`);
          }
          rows.push(row);
          j += 1;
        }
        nodes.push({ type: 'table', header, rows, line: n });
        i = j;
        continue;
      }

      // 5. Labelled item (definition list): the label alone on a line, then ":   content"
      if (i + 1 < buf.length && /^: {3}\S/.test(buf[i + 1].s)) {
        if (d >= 2) throw err(file, n, 'a third level of items');
        if (i > 0 && !isBlank(buf[i - 1].s) && !HEADING.test(buf[i - 1].s)) {
          throw err(file, n, 'a label line directly after a line of text');
        }
        const label = trimST(s);
        if (/[*_{}]/.test(label)) throw err(file, n, 'a label with emphasis or braces (labels are plain text)');
        const content = [{ s: buf[i + 1].s.slice(4), n: buf[i + 1].n }];
        let j = i + 2;
        while (j < buf.length) {
          const cur = buf[j];
          if (isBlank(cur.s)) { content.push({ s: '', n: cur.n }); j += 1; continue; }
          if (cur.s.startsWith('    ')) { content.push({ s: cur.s.slice(4), n: cur.n }); j += 1; continue; }
          if (!isBlank(buf[j - 1].s)) {
            throw err(file, cur.n, 'a lazy continuation line (Markdig would join it to the paragraph above)');
          }
          break;
        }
        while (content.length && isBlank(content[content.length - 1].s)) content.pop();
        const inner = parseBlocks(content, d + 1, { inItem: true });
        // a label itself must not carry a token (it is plain literal text in the app)
        nodes.push({ type: 'item', label, content: inner, line: n });
        i = j;
        continue;
      }

      // 6. Refused line starts
      if (s.startsWith('>')) throw err(file, n, 'a block quote');
      if (s.startsWith('<')) throw err(file, n, 'raw HTML');
      if (s.startsWith('```') || s.startsWith('~~~')) throw err(file, n, 'a fenced code block');
      if (/^[*+] /.test(s)) throw err(file, n, 'a "*" or "+" bullet list');
      if (ORDERED.test(s)) throw err(file, n, 'an ordered list');
      if (/^:([ \t]|$)/.test(s)) throw err(file, n, 'a definition without a label above it');
      if (i + 1 < buf.length && SETEXT.test(buf[i + 1].s)) throw err(file, buf[i + 1].n, 'a setext heading');

      // 7. Include
      const inc = trimST(s).match(/^\{\{> ([a-z-]+)\}\}$/);
      if (inc) {
        if (d !== 0 || kind !== 'document' || !INCLUDES.has(inc[1])) {
          throw err(file, n, `an include "${inc[1]}" here`);
        }
        nodes.push({ type: 'include', name: inc[1], line: n });
        i += 1;
        continue;
      }
      if (/\{\{>/.test(s)) throw err(file, n, 'an include that is not alone on its line');

      // 8. Paragraph (one per line)
      const top = kind === 'document' && d === 0;
      let runs = runsOf(trimST(s), n, ctx, { sections: top });
      let section = null;
      if (top) {
        const sec = takeSection(runs, file, n);
        runs = sec.runs;
        section = sec.section;
        checkTokens(runs, file, n, { kind, inItem: false });
      }
      nodes.push({ type: 'paragraph', runs, section, line: n });
      i += 1;
    }
    return nodes;
  }

  return parseBlocks(lines, 0, { inItem: false });
}

module.exports = { TOKENS, SECTIONS, INCLUDES, makeInline, parseLegalMarkdown, plain, trimST };
