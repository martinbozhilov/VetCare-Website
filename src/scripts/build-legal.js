// Generates legal.html (served at /legal, "Правна информация") from content/legal/: the VetCare
// app's own legal texts (the terms of use, the data processing agreement with the Commission's
// standard contractual clauses and Annexes I-IV, Annex IV being the sub-processor list), copied
// byte for byte from the app repo and never edited here.
//
// The build does five things (lib/legal-texts.js, lib/legal-markdown.js, lib/legal-parity.js):
// checks every text against the manifest's SHA-256, parses it with a strict subset of the app's
// grammar, composes the documents the way the app does (tokens filled, includes expanded, Annex I
// without clinic data), renders static HTML inside the shared page shell (lib/page-shell.js), and
// proves the result: the page's text, in reading order, must equal the composed source.
//
// legal.html is entirely generated: never edit it by hand. The output is deterministic (no
// timestamps, no git), so the Docker build can run this again. See CLAUDE.md, "Legal page".
//
// Run `npm run legal` (or `npm run build`, which calls it right after the blog).

const fs = require('fs');
const path = require('path');
const { SRC, SITE } = require('./lib/pages');
const {
  esc, glueDash, SITE_CARD, head, header, FOOTER,
} = require('./lib/page-shell');
const { loadLegal, NNBSP } = require('./lib/legal-texts');
const { checkLegalPage } = require('./lib/legal-parity');

const LONG_DASH = /[—–]/;
const OUT_FILE = path.join(SRC, 'legal.html');
const TITLE = 'Правна информация - VetCare';
const DESCRIPTION = 'Общите условия за ползване на VetCare, договорът за обработване на лични данни и списъкът на подизпълнителите, със същия текст като в приложението.';

// ── Links in the app's own texts ──────────────────────────────────────────────────────────────
// URLs and emails in the terms, the DPA and the sub-processor list become links; the words never
// change (the parity check reads the link text). The clauses are never linkified.
function linkify(text) {
  const segs = [];
  const emailRe = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g;
  const pushEmails = (t) => {
    let at = 0;
    for (const m of t.matchAll(emailRe)) {
      let e = m[0];
      while (e.endsWith('.')) e = e.slice(0, -1);
      if (m.index > at) segs.push({ text: t.slice(at, m.index) });
      segs.push({ text: e, href: `mailto:${e}` });
      at = m.index + e.length;
    }
    if (at < t.length) segs.push({ text: t.slice(at) });
  };
  const urlRe = /https?:\/\/[^\s<>"]+/g;
  let at = 0;
  for (const m of text.matchAll(urlRe)) {
    let u = m[0];
    for (;;) {
      if (/[.,;:!?]$/.test(u)) u = u.slice(0, -1);
      else if (u.endsWith(')') && !u.includes('(')) u = u.slice(0, -1);
      else break;
    }
    if (m.index > at) pushEmails(text.slice(at, m.index));
    segs.push({ text: u, href: u });
    at = m.index + u.length;
  }
  if (at < text.length) pushEmails(text.slice(at));
  return segs;
}

function renderRuns(runs, { glue }) {
  return runs.map((r) => {
    let html;
    if (glue) {
      html = linkify(r.text).map((seg) => {
        if (!seg.href) return esc(glueDash(seg.text));
        const external = /^https?:/.test(seg.href) && !seg.href.startsWith('https://vetcare.bg/');
        return `<a href="${esc(seg.href)}" class="vc-legal-link"${external ? ' target="_blank" rel="noopener"' : ''}>${esc(seg.text)}</a>`;
      }).join('');
    } else {
      html = esc(r.text);
    }
    if (r.bold && r.italic) return `<strong><em>${html}</em></strong>`;
    if (r.bold) return `<strong>${html}</strong>`;
    if (r.italic) return `<em>${html}</em>`;
    return html;
  }).join('');
}

const plainOf = (runs) => runs.map((r) => r.text).join('');
const indent = (lines, pad) => lines.map((l) => (l ? pad + l : l));

// ── Rendering: one block per line, nested content indented two spaces ─────────────────────────
function renderBlocks(blocks, { glue }) {
  const out = [];
  for (const b of blocks) {
    if (b.type === 'heading') {
      const tag = `h${b.level + 1}`;
      out.push(`<${tag}${b.id ? ` id="${b.id}"` : ''}>${renderRuns(b.runs, { glue })}</${tag}>`);
    } else if (b.type === 'paragraph') {
      // A paragraph that is exactly one bold run is a sub-heading (the terms' section lines):
      // presentation only, the text and its emphasis are unchanged.
      const sub = b.runs.length === 1 && b.runs[0].bold && !b.runs[0].italic;
      out.push(`<p${sub ? ' class="vc-legal-subhead"' : ''}>${renderRuns(b.runs, { glue })}</p>`);
    } else if (b.type === 'bullets') {
      out.push('<ul>');
      for (const it of b.items) out.push(`  <li>${renderRuns(it.runs, { glue })}</li>`);
      out.push('</ul>');
    } else if (b.type === 'table') {
      const labels = b.header.map((c) => esc(plainOf(c)));
      out.push('<table class="vc-legal-table" role="table">');
      out.push('  <thead role="rowgroup">');
      out.push('    <tr role="row">');
      for (const c of b.header) out.push(`      <th scope="col" role="columnheader">${renderRuns(c, { glue })}</th>`);
      out.push('    </tr>');
      out.push('  </thead>');
      out.push('  <tbody role="rowgroup">');
      for (const row of b.rows) {
        out.push('    <tr role="row">');
        row.forEach((c, i) => {
          out.push(i === 0
            ? `      <th scope="row" role="rowheader">${renderRuns(c, { glue })}</th>`
            : `      <td role="cell" data-label="${labels[i]}">${renderRuns(c, { glue })}</td>`);
        });
        out.push('    </tr>');
      }
      out.push('  </tbody>');
      out.push('</table>');
    } else if (b.type === 'item') {
      out.push('<div class="vc-legal-item">');
      out.push(`  <span class="vc-legal-item-label">${esc(b.label)}</span>`);
      out.push('  <div class="vc-legal-item-content">');
      out.push(...indent(renderBlocks(b.content, { glue }), '    '));
      out.push('  </div>');
      out.push('</div>');
    } else if (b.type === 'group') {
      if (b.name === 'clauses') {
        // No id: `main section[id]` (the section spy in main.js) must ignore it.
        out.push('<section class="vc-legal-clauses" data-legal="clauses">');
        out.push(...indent(renderBlocks(b.blocks, { glue: b.glue }), '  '));
        out.push('</section>');
      } else {
        out.push(...renderBlocks(b.blocks, { glue: b.glue }));
      }
    } else {
      throw new Error(`legal.html: cannot render a ${b.type}`);
    }
  }
  return out;
}

// ── Page ──────────────────────────────────────────────────────────────────────────────────────
function page({ termsTitle, dpaTitle, termsHtml, dpaHtml }) {
  return head({
    title: TITLE,
    description: DESCRIPTION,
    canonical: `${SITE}/legal`,
    ogType: 'website',
    ogTitle: TITLE,
    image: SITE_CARD.url,
    imageAlt: SITE_CARD.alt,
    source: 'content/legal/',
    generator: 'scripts/build-legal.js',
    command: 'npm run legal',
    robots: 'index, follow',
  }) + `</head>
${header({ blog: null })}
<main id="main-content" tabindex="-1">

  <!-- LEGAL -->
  <section class="vc-legal-section">
    <div class="vc-legal-container">

      <h1 class="vc-legal-title">Правна информация</h1>
      <p class="vc-legal-meta">Текстовете са същите като в приложението <strong>app.vetcare.bg</strong> · Контакт: <a href="mailto:hello@vetcare.bg" class="vc-legal-link">hello@vetcare.bg</a></p>

      <nav class="vc-legal-toc" aria-labelledby="vc-legal-toc-title">
        <p id="vc-legal-toc-title" class="vc-legal-toc-title">Съдържание</p>
        <ol class="vc-legal-toc-list">
          <li><a href="#obshti-usloviya" class="vc-legal-link">${esc(termsTitle)}</a></li>
          <li><a href="#dogovor-za-obrabotvane" class="vc-legal-link">${esc(dpaTitle)}</a></li>
          <li><a href="#podizpalniteli" class="vc-legal-link">Подизпълнители</a></li>
          <li><a href="#stari-versii" class="vc-legal-link">Стари версии</a></li>
        </ol>
      </nav>

      <div class="vc-legal-prose">
        <article class="vc-legal-doc" data-legal="terms" aria-labelledby="obshti-usloviya">
${termsHtml}
        </article>
        <article class="vc-legal-doc" data-legal="dpa" aria-labelledby="dogovor-za-obrabotvane">
${dpaHtml}
        </article>
        <section class="vc-legal-doc" aria-labelledby="stari-versii">
          <h2 id="stari-versii">Стари версии</h2>
          <p>Все още няма по-стари версии на тези документи.</p>
        </section>
      </div>

    </div>
  </section>

</main>
${FOOTER}`;
}

// Files are only rewritten when their bytes change, so an unchanged build leaves mtimes alone and
// `npm run watch` doesn't see its own output as an edit.
function emit(file, content) {
  const buf = Buffer.from(content);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return;
  fs.writeFileSync(file, buf);
}

async function main() {
  const legal = await loadLegal();
  for (const w of legal.warnings) console.warn(`⚠ legal: ${w}`);

  // House style: no em or en dashes in the page's OWN copy. The vendored texts are deliberately
  // outside this check (the Commission's clauses keep their two em dashes: they are a quote).
  const own = page({ termsTitle: '', dpaTitle: '', termsHtml: '', dpaHtml: '' });
  if (LONG_DASH.test(own.replace(/<!--[\s\S]*?-->/g, ''))) {
    throw new Error('legal.html: the page\'s own text contains a long dash (— or –); use " - " instead');
  }

  const pad = '          ';
  const render = (blocks) => indent(renderBlocks(blocks, { glue: true }), pad).join('\n');
  const html = page({
    termsTitle: legal.terms.title,
    dpaTitle: legal.dpa.title,
    termsHtml: render(legal.terms.blocks),
    dpaHtml: render(legal.dpa.blocks),
  });

  checkLegalPage(html, legal);
  // The app prints "9.11.2026" + U+202F + "г." (formatBgDate): the page must carry exactly that, and
  // never the look-alike with an ordinary space.
  const plainSpaced = legal.effectiveDateText.replace(NNBSP, ' ');
  if (!html.includes(legal.effectiveDateText) || html.includes(plainSpaced)) {
    throw new Error('legal.html: the effective date must appear with U+202F before "г." and never with an ordinary space');
  }
  emit(OUT_FILE, html);
  console.log(`✅ legal - terms v${legal.terms.version}, DPA v${legal.dpa.version}, sub-processors v${legal.subProcessors.version}, в сила от ${legal.effectiveDateText}`);
}

main().catch((err) => {
  console.error(`❌ legal: ${err.message}`);
  process.exit(1);
});
