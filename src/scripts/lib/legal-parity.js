// The proof that legal.html says what the app says (scripts/build-legal.js runs it on the final
// HTML string, before anything is written).
//
// It is deliberately independent of the parser in legal-markdown.js: it works on the raw source
// lines and on the delivered HTML, so a bug in the parser (a dropped line, a merged paragraph, a
// leaked marker) can't also hide in the check. The tag-stripped text of each document, in reading
// order, must equal the composed source: for the terms and the DPA with whitespace collapsed, for
// the Commission's clauses with no-break spaces kept (they are the Official Journal's text, down to
// the typo).

// Source lines that never reach the page: the clinic's own data (no clinic on /legal) and the
// sections that only exist once a clinic has accepted.
const DROPPED_LINE = /\{\{(clinic\.(name|address)|#contact|#acceptance)\}\}/;

// What the page must say for a source text: syntax stripped, tokens filled, includes expanded.
// `includes` maps an include name to the expected text of what it expands to.
function expectedText(text, { values = {}, includes = {} } = {}) {
  const out = [];
  for (const raw of text.split('\n')) {
    const inc = raw.replace(/^[ \t]+|[ \t]+$/g, '').match(/^\{\{> ([a-z-]+)\}\}$/);
    if (inc) {
      if (!(inc[1] in includes)) throw new Error(`parity: no expansion given for the include "${inc[1]}"`);
      out.push(includes[inc[1]]);
      continue;
    }
    if (DROPPED_LINE.test(raw)) continue;
    if (/^\|[ \t:|-]+\|$/.test(raw)) continue; // a table delimiter row
    let s = raw
      .replace(/^[ \t]+/, '') // spaces and tabs only, never U+00A0
      .replace(/^#{1,6}[ \t]+/, '')
      .replace(/^- +/, '')
      .replace(/^: +/, '')
      .replace(/\*/g, '')
      .replace(/\|/g, ' ');
    s = s.replace(/\{\{(version|effectiveDate|lastChanged)\}\}/g, (all, k) => values[k]);
    out.push(s);
  }
  return out.join('\n');
}

// Reading-order text of an HTML fragment. Inline tags vanish without a trace, every other tag is
// a word break, and only the four entities esc() produces are decoded.
function visibleText(html) {
  return html
    .replace(/<\/?(strong|em|a)\b[^>]*>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

const loose = (s) => s.replace(/[\s ]+/g, ' ').trim();
const strict = (s) => s.replace(/[ \t\r\n]+/g, ' ').trim(); // keeps U+00A0

function region(html, attr) {
  const m = html.match(new RegExp(`<(article|section)\\b[^>]*data-legal="${attr}"[^>]*>([\\s\\S]*?)</\\1>`));
  if (!m) throw new Error(`parity: no region data-legal="${attr}" in the page`);
  return m[2];
}

function sameOrThrow(name, got, want) {
  if (got === want) return;
  let i = 0;
  while (i < got.length && i < want.length && got[i] === want[i]) i += 1;
  const around = (s) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 40));
  throw new Error(`parity (${name}): the page differs from the source at character ${i}\n  page:   ${around(got)}\n  source: ${around(want)}`);
}

function checkLegalPage(html, legal) {
  const { terms, dpa, subProcessors, clausesText } = legal;

  // 1. The terms
  sameOrThrow('terms', loose(visibleText(region(html, 'terms'))),
    loose(expectedText(terms.text, { values: terms.values })));

  // 2. The DPA, with its two includes expanded in place
  const spExpected = expectedText(subProcessors.text, { values: subProcessors.values });
  const clausesExpected = expectedText(clausesText);
  sameOrThrow('dpa', loose(visibleText(region(html, 'dpa'))),
    loose(expectedText(dpa.text, { values: dpa.values, includes: { clauses: clausesExpected, 'sub-processors': spExpected } })));

  // 3. The Commission's clauses, every no-break space and dash included
  sameOrThrow('clauses', strict(visibleText(region(html, 'clauses'))), strict(clausesExpected));

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
}

module.exports = { expectedText, visibleText, loose, strict, region, checkLegalPage };
