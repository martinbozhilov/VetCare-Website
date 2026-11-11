// The proof that legal.html says what the app says (scripts/build-legal.js runs it on the final
// HTML string, before anything is written).
//
// It is deliberately independent of the parser in legal-markdown.js: it works on the raw source
// lines and on the delivered HTML, so a bug in the parser (a dropped line, a merged paragraph, a
// leaked marker) can't also hide in the check. The composed source is cut into blocks (every line
// is one: a heading, a paragraph, a list item, each table cell, a label, the content after a
// label) and each must equal, in reading order, the matching rendered block element (h2-h6, p, li,
// th, td, and the label span), with the emphasis kept: <strong>/<em> are mapped back to ** and *
// and compared with the source's own markers. So words, block boundaries (two paragraphs merged
// into one fail) and bold/italic are proven. Whitespace is collapsed for the terms and the DPA;
// for the Commission's clauses no-break spaces are kept (they are the Official Journal's text,
// down to the typo). Second, the whole visible text of each region (terms, DPA, clauses), in
// reading order, must equal the composed source text with the emphasis markers stripped, so text
// outside the block elements (an extra <div>, a bare text node, a paragraph repeated inside another
// element, words after a label) fails too. Third, every link in those regions must point where its
// text says: an href is its own text, or "mailto:" plus it (a link's words are read as plain text
// above, so the checks on them would not notice a wrong target). Not covered: which tag a block is
// (h3 vs h4, p vs li) and which cell is in which column.

// Source lines that never reach the page. Two rules, deliberately different:
// - SECTION_LINE: the sections that only exist once a clinic has accepted or has a contact. They are
//   left out wherever they are (the app shows a section only when it is on, and none is on here).
// - CLINIC_LINE: the clinic's own data (no clinic on /legal). Left out only inside Annex I, the
//   part of a text from a heading matching ANNEX_I up to the next heading of the same or a higher
//   level. A clinic token anywhere else is an error, so a clause can't vanish from the page unseen.
// The Annex I scope is tracked on the raw heading lines (the number of "#" is the level), not taken
// from the parser.
const SECTION_LINE = /\{\{(#contact|#acceptance)\}\}/;
const CLINIC_LINE = /\{\{clinic\.(name|address)\}\}/;
const ANNEX_I = /^Приложение I( |$)/;

// What the page must say for a source text, as a list of blocks: syntax stripped (emphasis markers
// kept), tokens filled, includes expanded. `includes` maps an include name to the block list of
// what it expands to.
function expectedBlocks(text, { values = {}, includes = {} } = {}) {
  const out = [];
  let annexLevel = null; // the level of the heading that opened Annex I, while inside it
  for (const [at, raw] of text.split('\n').entries()) {
    const inc = raw.replace(/^[ \t]+|[ \t]+$/g, '').match(/^\{\{> ([a-z-]+)\}\}$/);
    if (inc) {
      if (!(inc[1] in includes)) throw new Error(`parity: no expansion given for the include "${inc[1]}"`);
      out.push(...includes[inc[1]]);
      continue;
    }
    if (SECTION_LINE.test(raw)) continue;
    const heading = raw.match(/^(#{1,6})[ \t]+(.*)$/);
    if (heading) {
      if (annexLevel !== null && heading[1].length <= annexLevel) annexLevel = null;
      if (ANNEX_I.test(heading[2].trim())) annexLevel = heading[1].length;
    }
    if (CLINIC_LINE.test(raw)) {
      if (annexLevel === null) throw new Error(`parity: a clinic token outside Annex I on source line ${at + 1}`);
      continue;
    }
    if (/^\|[ \t:|-]+\|$/.test(raw)) continue; // a table delimiter row
    const s = raw
      .replace(/^[ \t]+/, '') // spaces and tabs only, never U+00A0
      .replace(/^#{1,6}[ \t]+/, '')
      .replace(/^- +/, '')
      .replace(/^: +/, '')
      .replace(/\{\{(version|effectiveDate|lastChanged)\}\}/g, (all, k) => values[k]);
    if (/^\|.*\|$/.test(s)) {
      out.push(...s.slice(1, -1).split('|')); // a table row: one block per cell
    } else {
      out.push(s);
    }
  }
  return out.filter((b) => b.trim() !== '');
}

function decode(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// The page's own blocks of an HTML fragment, in reading order, with emphasis written as markers.
// `a` tags vanish (the words stay), every other tag is dropped, and only the four entities esc()
// produces are decoded.
function renderedBlocks(html) {
  const out = [];
  const re = /<(h[2-6]|p|li|th|td|span)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  for (const m of html.matchAll(re)) {
    if (m[1] === 'span' && !/\bvc-legal-item-label\b/.test(m[2])) continue;
    const inner = m[3]
      .replace(/<strong><em>/g, '***').replace(/<\/em><\/strong>/g, '***')
      .replace(/<strong>|<\/strong>/g, '**')
      .replace(/<em>|<\/em>/g, '*')
      .replace(/<\/?a\b[^>]*>/g, '')
      .replace(/<[^>]*>/g, '');
    out.push(decode(inner));
  }
  return out;
}

// Reading-order text of an HTML fragment (leak checks). Inline tags vanish without a trace, every
// other tag is a word break.
function visibleText(html) {
  return decode(html
    .replace(/<\/?(strong|em|a)\b[^>]*>/g, '')
    .replace(/<[^>]*>/g, ' '));
}

const loose = (s) => s.replace(/[\s ]+/g, ' ').trim();
const strict = (s) => s.replace(/[ \t\r\n]+/g, ' ').trim(); // keeps U+00A0

function region(html, attr) {
  const m = html.match(new RegExp(`<(article|section)\\b[^>]*data-legal="${attr}"[^>]*>([\\s\\S]*?)</\\1>`));
  if (!m) throw new Error(`parity: no region data-legal="${attr}" in the page`);
  return m[2];
}

// The whole region: its complete visible text must equal the expected blocks joined in reading
// order (emphasis markers stripped), whatever elements it sits in. `norm` collapses whitespace.
function sameTextOrThrow(name, html, want, norm) {
  const g = norm(visibleText(html));
  const w = norm(want.join(' ').replace(/[*]/g, ''));
  if (g === w) return;
  let c = 0;
  while (c < g.length && c < w.length && g[c] === w[c]) c += 1;
  const around = (x) => JSON.stringify(x.slice(Math.max(0, c - 40), c + 50));
  throw new Error(`parity (${name}, whole region): the visible text differs from the source at character ${c}
  page:   ${around(g)}
  source: ${around(w)}`);
}

// Blocks must match one for one: same count, each equal after `norm`.
function sameBlocksOrThrow(name, got, want, norm) {
  const g = got.map(norm);
  const w = want.map(norm);
  const around = (s) => JSON.stringify(s.length > 90 ? `${s.slice(0, 90)}...` : s);
  for (let i = 0; i < Math.max(g.length, w.length); i += 1) {
    if (g[i] === w[i]) continue;
    let c = 0;
    const a = g[i] || '';
    const b = w[i] || '';
    while (c < a.length && c < b.length && a[c] === b[c]) c += 1;
    throw new Error(`parity (${name}): block ${i + 1} of ${w.length} (page has ${g.length}) differs from the source at character ${c}\n  page:   ${around(a)}\n  source: ${around(b)}`);
  }
}

function checkLegalPage(html, legal) {
  const { terms, dpa, subProcessors, clausesText } = legal;

  // 1. The terms
  const termsExpected = expectedBlocks(terms.text, { values: terms.values });
  sameBlocksOrThrow('terms', renderedBlocks(region(html, 'terms')), termsExpected, loose);
  sameTextOrThrow('terms', region(html, 'terms'), termsExpected, loose);

  // 2. The DPA, with its two includes expanded in place
  const spExpected = expectedBlocks(subProcessors.text, { values: subProcessors.values });
  const clausesExpected = expectedBlocks(clausesText);
  const dpaExpected = expectedBlocks(dpa.text, { values: dpa.values, includes: { clauses: clausesExpected, 'sub-processors': spExpected } });
  sameBlocksOrThrow('dpa', renderedBlocks(region(html, 'dpa')), dpaExpected, loose);
  sameTextOrThrow('dpa', region(html, 'dpa'), dpaExpected, loose);

  // 3. The Commission's clauses, every no-break space and dash included
  sameBlocksOrThrow('clauses', renderedBlocks(region(html, 'clauses')), clausesExpected, strict);
  sameTextOrThrow('clauses', region(html, 'clauses'), clausesExpected, strict);

  // 4. Leaked syntax
  const old = html.match(/<section class="vc-legal-doc" aria-labelledby="stari-versii">([\s\S]*?)<\/section>/);
  if (!old) throw new Error('parity: the "Стари версии" section is missing');
  const regions = { terms: region(html, 'terms'), dpa: region(html, 'dpa'), clauses: region(html, 'clauses'), 'stari-versii': old[1] };
  for (const [name, inner] of Object.entries(regions)) {
    const text = visibleText(inner);
    for (const bad of ['{{', '}}', '*', '|---']) {
      if (text.includes(bad)) throw new Error(`leak (${name}): the page text contains "${bad}"`);
    }
    for (const piece of inner.split(/<[^>]*>/)) {
      const t = piece.trim();
      if (t && (t.startsWith(':') || t.startsWith('#'))) {
        throw new Error(`leak (${name}): a text node starts with "${t[0]}": ${JSON.stringify(t.slice(0, 60))}`);
      }
    }
  }

  // 5. Anchors: each once, in this order
  let last = -1;
  for (const id of ['obshti-usloviya', 'dogovor-za-obrabotvane', 'podizpalniteli', 'stari-versii']) {
    const needle = `id="${id}"`;
    const first = html.indexOf(needle);
    if (first < 0 || html.indexOf(needle, first + 1) >= 0) throw new Error(`anchor: ${needle} must occur exactly once`);
    if (first < last) throw new Error(`anchor: ${needle} is out of order`);
    last = first;
  }

  // 6. No empty field label in the DPA (an Annex I line that kept its label but lost its value)
  for (const m of regions.dpa.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    if (visibleText(m[1]).trim().endsWith(':')) {
      throw new Error(`leak (dpa): a list item ends with ":" (an empty field): ${JSON.stringify(visibleText(m[1]).trim().slice(-60))}`);
    }
  }

  // 7. Every link points where its text says (the clauses are never linkified, so there is nothing
  // to find in them, and checking them is harmless)
  for (const name of ['terms', 'dpa', 'clauses']) {
    for (const m of region(html, name).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const href = decode((m[1].match(/\bhref="([^"]*)"/) || [null, ''])[1]);
      const text = decode(m[2].replace(/<[^>]*>/g, ''));
      if (href !== text && href !== `mailto:${text}`) {
        throw new Error(`parity (links): href "${href}" does not match its text "${text}"`);
      }
    }
  }
}

module.exports = { expectedBlocks, renderedBlocks, visibleText, loose, strict, region, checkLegalPage };
