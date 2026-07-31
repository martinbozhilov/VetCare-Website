// Generates a self-hosted, subsetted Tabler icon font plus the matching CSS, from the icons the
// HTML pages actually reference.
//
// Why this exists: the full webfont is 831 KB of woff2 and 227 KB of CSS covering 5610 icons, and
// this site uses ~26 of them. Loading it from jsDelivr also put two serialized round-trips in front
// of the first icon paint (the @font-face src isn't discoverable until the CSS has been fetched and
// applied), and Tabler's @font-face declares no font-display, so the browser's default `auto` —
// which behaves like `block` — left icons invisible for the whole load. The hero CTA's arrow was
// the most visible casualty.
//
// Run `npm run icons` (or just `npm run build`, which calls it) after adding or removing a
// `ti ti-*` class in any HTML file, or the new icon will render as a blank box.

const fs = require('fs');
const path = require('path');
const subsetFont = require('subset-font');
const fontverter = require('fontverter');
const opentype = require('opentype.js');

const SRC = path.join(__dirname, '..');
const PKG = path.join(SRC, 'node_modules', '@tabler', 'icons-webfont', 'dist');
const OUT_FONT = path.join(SRC, 'assets', 'fonts', 'tabler-icons-subset.woff2');
const OUT_CSS = path.join(SRC, 'assets', 'css', 'icons.css');

function usedIconNames() {
  const names = new Set();
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(SRC, file), 'utf8');
    for (const m of html.matchAll(/\bti ti-([a-z0-9-]+)/g)) names.add(m[1]);
  }
  return [...names].sort();
}

// Tabler ships one `.ti-<name>:before{content:"\xxxx"}` rule per icon; that mapping is the only
// place the codepoints live, so read them straight out of the package's own CSS.
function codepointMap(css) {
  const map = new Map();
  for (const m of css.matchAll(/\.ti-([a-z0-9-]+):before\{content:"\\([0-9a-f]+)"\}/g)) {
    map.set(m[1], parseInt(m[2], 16));
  }
  return map;
}

// tabler-icons.ttf carries a GSUB table with a coverage record neither harfbuzz nor opentype.js can
// read ("Coverage format must be 1 or 2"), which makes hb_subset_or_fail bail out on the whole font.
// GSUB only drives Tabler's optional ligature names (`<i class="ti">arrow-right</i>`); this site
// addresses icons by their PUA codepoint through `content:`, so the table is dead weight — dropping
// it both fixes the subsetter and removes 168 KB before compression.
function dropTable(buf, tag) {
  const numTables = buf.readUInt16BE(4);
  const keep = [];
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16;
    if (buf.toString('ascii', o, o + 4) === tag) continue;
    keep.push({
      tag: buf.toString('ascii', o, o + 4),
      checksum: buf.readUInt32BE(o + 4),
      offset: buf.readUInt32BE(o + 8),
      length: buf.readUInt32BE(o + 12),
    });
  }
  if (keep.length === numTables) throw new Error(`Table ${tag} not found — font layout changed?`);

  const pad = (n) => (n + 3) & ~3;
  const dirSize = 12 + keep.length * 16;
  const out = Buffer.alloc(keep.reduce((n, t) => n + pad(t.length), dirSize));

  // sfnt header: version, table count, then the binary-search hint fields it mandates.
  out.writeUInt32BE(buf.readUInt32BE(0), 0);
  out.writeUInt16BE(keep.length, 4);
  const pow2 = Math.floor(Math.log2(keep.length));
  out.writeUInt16BE(16 * 2 ** pow2, 6);
  out.writeUInt16BE(pow2, 8);
  out.writeUInt16BE(keep.length * 16 - 16 * 2 ** pow2, 10);

  let cursor = dirSize;
  keep.forEach((t, i) => {
    const o = 12 + i * 16;
    out.write(t.tag, o, 4, 'ascii');
    out.writeUInt32BE(t.checksum, o + 4); // table bytes are copied verbatim, so this still holds
    out.writeUInt32BE(cursor, o + 8);
    out.writeUInt32BE(t.length, o + 12);
    buf.copy(out, cursor, t.offset, t.offset + t.length);
    // head.checkSumAdjustment covers the whole file, which just changed; zero is the documented
    // "not computed" value and harfbuzz recomputes it for the subset anyway.
    if (t.tag === 'head') out.writeUInt32BE(0, cursor + 8);
    cursor += pad(t.length);
  });
  return out;
}

// A subset that silently lost a glyph would ship as a blank box, so read the result back and check
// every requested codepoint still draws something.
async function verify(woff2, names, codepoints) {
  const ttf = await fontverter.convert(woff2, 'truetype');
  const buf = Buffer.from(ttf);
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const empty = names.filter((n) => {
    const glyph = font.charToGlyph(String.fromCodePoint(codepoints.get(n)));
    return !glyph || glyph.index === 0 || glyph.path.commands.length === 0;
  });
  if (empty.length) throw new Error(`Subset is missing outlines for: ${empty.join(', ')}`);
}

async function main() {
  const sourceCss = fs.readFileSync(path.join(PKG, 'tabler-icons.min.css'), 'utf8');
  const codepoints = codepointMap(sourceCss);
  const names = usedIconNames();

  const missing = names.filter((n) => !codepoints.has(n));
  if (missing.length) {
    // A typo'd or renamed class would otherwise silently ship as a blank box.
    throw new Error(`Unknown icon(s) in HTML, not present in @tabler/icons-webfont: ${missing.join(', ')}`);
  }

  // Subset from the .ttf, not the .woff2 the CDN serves: harfbuzz needs an uncompressed input.
  const source = fs.readFileSync(path.join(PKG, 'fonts', 'tabler-icons.ttf'));
  const cdnSize = fs.statSync(path.join(PKG, 'fonts', 'tabler-icons.woff2')).size;
  const text = names.map((n) => String.fromCodePoint(codepoints.get(n))).join('');
  const subset = await subsetFont(dropTable(source, 'GSUB'), text, { targetFormat: 'woff2' });

  await verify(subset, names, codepoints);

  fs.mkdirSync(path.dirname(OUT_FONT), { recursive: true });
  fs.writeFileSync(OUT_FONT, subset);

  const rules = names
    .map((n) => `.ti-${n}:before { content: "\\${codepoints.get(n).toString(16)}"; }`)
    .join('\n');

  // font-display: block, not swap — a fallback font has nothing sensible to draw for these private
  // use area codepoints, so swapping would flash tofu. With the subset preloaded in <head> the
  // block period is effectively zero anyway.
  fs.writeFileSync(OUT_CSS, `/* GENERATED by scripts/subset-icons.js — do not edit by hand.
   Subset of @tabler/icons-webfont containing only the ${names.length} icons used in the HTML.
   Regenerate with \`npm run icons\` after changing which \`ti ti-*\` classes the pages use. */

@font-face {
  font-family: "tabler-icons";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("../fonts/tabler-icons-subset.woff2") format("woff2");
}

.ti {
  font-family: "tabler-icons" !important;
  speak: none;
  font-style: normal;
  font-weight: normal;
  font-variant: normal;
  text-transform: none;
  line-height: 1;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

${rules}
`);

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(
    `icons: ${names.length} glyphs — woff2 ${kb(cdnSize)} -> ${kb(subset.length)}, `
    + `css ${kb(sourceCss.length)} -> ${kb(fs.statSync(OUT_CSS).size)}`
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
