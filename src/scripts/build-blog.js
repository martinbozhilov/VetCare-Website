// Generates the blog — blog/index.html (the list) and blog/<slug>.html (one per article) — from
// content/blog/*.md, plus blog/images/ (the articles' images and a WebP companion for each).
//
// Why a generator: the site is static HTML with no templating, and an article has to be addable as
// one Markdown file and one image, without touching code. The output is plain HTML, so the text is
// in the page without JavaScript (search engines and link previews read it as is).
//
// blog/ is entirely generated and owned by this script: anything in it that this run did not
// produce is deleted, so a removed article can't linger as a live, orphaned URL. Never edit it by
// hand. The output is committed like the other generated files, and the Docker build runs this
// again (`npm run build`), which is safe because the output is deterministic — no timestamps and no
// git: dateModified comes from the article's `updated` field, not from history.
//
// The page shell (head, header, footer, consent banner) lives in lib/page-shell.js, shared with /legal.
// A nav or footer change has to be made there and in the three hand-written pages — see CLAUDE.md.
//
// Run `npm run blog` (or `npm run build`, which calls it first). Article format: see
// scripts/lib/blog-posts.js.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const MarkdownIt = require('markdown-it');
const { SRC, SITE } = require('./lib/pages');
const {
  esc, glueDash, LONG_DASH, writeIfChanged, SITE_CARD, head, header, FOOTER,
} = require('./lib/page-shell');
const {
  CONTENT_DIR, IMAGE_PREFIX, loadPosts, imageSource, withVersion,
} = require('./lib/blog-posts');

const OUT_DIR = path.join(SRC, 'blog');
const TITLE_SUFFIX = ' | VetCare - софтуер за ветеринарни клиники';
const LOGO = `${SITE}/assets/images/vetcare-logo-512.png`;
// The Organization node in index.html's JSON-LD (its "@id"). Articles name it as author and publisher,
// so search engines see one organisation across the site. Absolute, because a bare "#organization"
// would resolve against each article's own URL. checkHomeOrganization() fails the build if
// index.html's node ever carries a different id.
const ORG_ID = `${SITE}/#organization`;
const BLOG_INTRO = 'Практични статии за работата във ветеринарната клиника';
// WebP companions of in-text images are capped at twice the 1160px content width (.vc-container);
// the cover is already 1200px wide and is never resized.
const INLINE_MAX_WIDTH = 2320;

const MONTHS = ['януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август', 'септември',
  'октомври', 'ноември', 'декември'];
// "6 ноември 2026" — spelled out by hand rather than Intl, whose bg-BG long format appends " г.".
const formatDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

// JSON inside <script>: a "</script>" in any value would end the block early.
const jsonLd = (obj) => JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
const rel = (file) => path.relative(SRC, file).replace(/\\/g, '/');

// ── Output bookkeeping ────────────────────────────────────────────────────────────────────────
// Every file goes through writeIfChanged (lib/page-shell.js); `written` is what removeStale keeps.
const written = new Set();
function emit(file, content) {
  // House style: no em or en dashes in anything a visitor reads, the site uses " - " instead.
  // Articles are checked line by line in lib/blog-posts.js; this catches the templates in this file.
  if (typeof content === 'string' && LONG_DASH.test(content.replace(/<!--[\s\S]*?-->/g, ''))) {
    throw new Error(`${rel(file)}: the page text contains a long dash (— or –); use " - " instead`);
  }
  written.add(path.resolve(file));
  writeIfChanged(file, content);
}

function removeStale(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.resolve(dir, entry.name);
    if (entry.isDirectory()) {
      removeStale(full);
      if (!fs.readdirSync(full).length) fs.rmdirSync(full);
    } else if (!written.has(full)) {
      fs.unlinkSync(full);
      console.log(`· blog: removed stale ${rel(full)}`);
    }
  }
}

// ── Images ────────────────────────────────────────────────────────────────────────────────────
// /blog/images/<file> is copied byte for byte from content/blog/images/<file> (the JPG stays the
// og:image and the <img> fallback) and gets WebP companions next to it, which is what browsers
// actually download: <name>.webp at full size and <name>-<width>.webp steps below it. Lighthouse
// flagged phones fetching the 1200px cover for a ~350px-wide slot; the srcset/sizes pair lets the
// browser pick. 800 is there for Lighthouse's own mobile device (412px at 1.75x needs ~663px, just
// past 640); 1200/1600 only appear for in-text images wider than that. Images elsewhere on the site
// (e.g. /assets/images/) are used as they are, with their existing .webp sibling if there is one.
//
// Every URL gets ?v=<content hash> (withVersion, lib/blog-posts.js) — the <img> fallback, each srcset
// entry, og:image and the JSON-LD — which is what lets nginx cache /blog/images/ for a year.
const STEP_WIDTHS = [640, 800, 1200, 1600];
// What each slot renders at, for `sizes`: one .vc-container (1160px, ~92vw below 1240px), or half
// of it for the list card's image column from 720px.
const SIZES = {
  column: '(min-width: 1240px) 1160px, 92vw',
  card: '(min-width: 1240px) 580px, (min-width: 720px) 46vw, 92vw',
};
const prepared = new Map();
function prepareImage(publicPath, { maxWidth } = {}) {
  if (!prepared.has(publicPath)) prepared.set(publicPath, doPrepareImage(publicPath, maxWidth));
  return prepared.get(publicPath);
}
async function doPrepareImage(publicPath, maxWidth) {
  const source = imageSource(publicPath);
  const sourceBytes = fs.readFileSync(source);
  const meta = await sharp(source).metadata();
  const image = { src: withVersion(publicPath, sourceBytes), webp: null, width: meta.width, height: meta.height };

  if (!publicPath.startsWith(IMAGE_PREFIX)) {
    const sibling = publicPath.replace(/\.(png|jpe?g)$/i, '.webp');
    const siblingFile = path.join(SRC, sibling.slice(1));
    if (sibling !== publicPath && fs.existsSync(siblingFile)) {
      image.webp = esc(withVersion(sibling, fs.readFileSync(siblingFile)));
    }
    return image;
  }

  const target = path.join(OUT_DIR, 'images', publicPath.slice(IMAGE_PREFIX.length));
  emit(target, sourceBytes);
  if (meta.format === 'jpeg' || meta.format === 'png') {
    const encode = (width) => sharp(source)
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    const full = await encode(Math.min(meta.width, maxWidth || meta.width));
    const webpPath = publicPath.replace(/\.(png|jpe?g)$/i, '.webp');
    emit(target.replace(/\.(png|jpe?g)$/i, '.webp'), full.data);
    const candidates = [];
    // Only steps that save something real; one just under full size would be noise.
    for (const width of STEP_WIDTHS.filter((w) => w * 1.15 < full.info.width)) {
      const step = await encode(width);
      emit(target.replace(/\.(png|jpe?g)$/i, `-${width}.webp`), step.data);
      candidates.push(`${esc(withVersion(webpPath.replace(/\.webp$/, `-${width}.webp`), step.data))} ${width}w`);
    }
    candidates.push(`${esc(withVersion(webpPath, full.data))} ${full.info.width}w`);
    image.webp = candidates.join(', ');
    image.responsive = candidates.length > 1;
    // width/height must describe the file the browser loads (the WebP); the aspect ratio, which is
    // what they actually reserve, is the same for every variant and for the fallback.
    image.width = full.info.width;
    image.height = full.info.height;
  }
  return image;
}

function picture(image, alt, { lazy = false, priority = false, cls = '', sizes = SIZES.column } = {}, indent = '') {
  const attrs = [`src="${esc(image.src)}"`, `alt="${esc(alt)}"`, `width="${image.width}"`, `height="${image.height}"`];
  if (lazy) attrs.push('loading="lazy"', 'decoding="async"');
  if (priority) attrs.push('fetchpriority="high"');
  if (cls) attrs.push(`class="${cls}"`);
  const img = `<img ${attrs.join(' ')}>`;
  if (!image.webp) return `${indent}${img}`;
  const sizesAttr = image.responsive ? ` sizes="${sizes}"` : '';
  return `${indent}<picture>\n`
    + `${indent}  <source type="image/webp" srcset="${image.webp}"${sizesAttr}>\n`
    + `${indent}  ${img}\n`
    + `${indent}</picture>`;
}

// ── Markdown ──────────────────────────────────────────────────────────────────────────────────
// markdown-it with GFM's output: tables (alignment as an `align` attribute), ~~strikethrough~~ as
// <del>, autolinks and raw HTML. Task lists ("- [ ] x") are not supported and stay plain text.
// Strikethrough is "~~x~~" only: a single "~" stays a literal tilde (marked also took "~x~"). The
// marketing drafts write "~70" and "~950; ~400" for "about", and a single-tilde rule would strike
// the text between two such numbers through.
function makeMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: true });
  // Bare "http(s)://", "www." and e-mail addresses become links, as in GFM, but a bare domain
  // ("vetcare.bg") must not: linkify-it's fuzzy matching is what finds "www." and a domain alike, so
  // it is on by default (fuzzyLink) and its schemaless matches are filtered down to the "www." ones.
  const match = md.linkify.match.bind(md.linkify);
  md.linkify.match = (text) => (match(text) || []).filter((m) => m.schema !== '' || /^www\./i.test(m.raw));

  const rules = md.renderer.rules;
  rules.s_open = () => '<del>';
  rules.s_close = () => '</del>';
  rules.hardbreak = () => '<br>';
  // GFM's table alignment is an attribute, markdown-it's an inline style (and this site has none).
  const align = (tokens, i, options, env, self) => {
    const t = tokens[i];
    const style = t.attrGet('style');
    if (style) {
      t.attrs = t.attrs.filter((a) => a[0] !== 'style');
      t.attrSet('align', style.replace(/^text-align:/, ''));
    }
    return self.renderToken(tokens, i, options);
  };
  rules.th_open = align;
  rules.td_open = align;
  // The apostrophe is written &#39; in text and code, as GFM renderers write it (attributes keep
  // markdown-it's own escaping).
  rules.text = (tokens, i) => esc(tokens[i].content).replace(/'/g, '&#39;');
  for (const name of ['code_inline', 'code_block', 'fence']) {
    const base = rules[name];
    rules[name] = (...args) => base(...args).replace(/'/g, '&#39;');
  }
  // The image and figure rules read what renderMarkdown prepared for this article from `env`.
  rules.image = (tokens, i, options, env) => {
    const t = tokens[i];
    return picture(env.ready.get(t.attrGet('src')), t.content, { lazy: true });
  };
  // An image alone in its paragraph is a captioned figure. The caption is the image's title if it
  // has one (`![alt](src "caption")`), else its alt text, and when it repeats the alt it is hidden
  // from screen readers, which would otherwise read the same sentence twice.
  rules.vc_figure = (tokens, i, options, env) => {
    const t = tokens[i].meta;
    const alt = t.content;
    const caption = t.attrGet('title') || alt;
    const pic = picture(env.ready.get(t.attrGet('src')), alt, { lazy: true }, '  ');
    if (!caption) return `<figure>\n${pic}\n</figure>\n`;
    const hidden = caption === alt ? ' aria-hidden="true"' : '';
    return `<figure>\n${pic}\n  <figcaption${hidden}>${esc(caption)}</figcaption>\n</figure>\n`;
  };
  return md;
}
const markdown = makeMarkdown();

async function renderMarkdown(post) {
  const env = { ready: new Map() };
  const tokens = markdown.parse(post.body, env);
  const images = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    // The page already has its one H1 — the title from the frontmatter.
    if (t.type === 'heading_open' && t.tag === 'h1') {
      throw new Error(`${post.sourceFile}: "# ${tokens[i + 1].content}" is an H1; the title is the page's only H1 — use ## for sections`);
    }
    if (t.type !== 'inline') continue;
    for (const c of t.children) {
      if (c.type === 'image') images.push(c.attrGet('src'));
      // Plain text only: code spans, URLs and an image's alt are other tokens, so they keep their spaces.
      if (c.type === 'text') c.content = glueDash(c.content);
    }
  }
  for (const href of images) {
    try {
      env.ready.set(href, await prepareImage(href, { maxWidth: INLINE_MAX_WIDTH }));
    } catch (err) {
      throw new Error(`${post.sourceFile}: ${err.message}`);
    }
  }

  // A paragraph that holds one image (whitespace-only text ignored) becomes a figure token. A
  // paragraph inside a tight list is hidden and keeps its image inline, as before.
  for (let i = 0; i + 2 < tokens.length; i += 1) {
    if (tokens[i].type !== 'paragraph_open' || tokens[i].hidden) continue;
    const parts = tokens[i + 1].children.filter((c) => !(c.type === 'text' && !c.content.trim()));
    if (parts.length !== 1 || parts[0].type !== 'image') continue;
    const figure = new tokens[i].constructor('vc_figure', '', 0);
    figure.block = true;
    figure.meta = parts[0];
    tokens.splice(i, 3, figure);
  }
  return markdown.renderer.render(tokens, markdown.options, env);
}

const timeTag = (iso) => `<time datetime="${iso}">${formatDate(iso)}</time>`;
const indentBlock = (html, pad) => html.trimEnd().split('\n').map((l) => (l ? pad + l : l)).join('\n');

// ── Pages ─────────────────────────────────────────────────────────────────────────────────────
async function articlePage(post) {
  const body = await renderMarkdown(post);
  const cover = await prepareImage(post.image);
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description,
    image: [`${SITE}${cover.src}`],
    datePublished: post.date,
    dateModified: post.updated || post.date,
    inLanguage: 'bg',
    // No byline on the page; structured data names the organisation, not a person: the home page's
    // Organization node, by its @id.
    author: { '@type': 'Organization', '@id': ORG_ID, name: 'VetCare', url: SITE },
    publisher: { '@type': 'Organization', '@id': ORG_ID, name: 'VetCare', url: SITE, logo: { '@type': 'ImageObject', url: LOGO } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': post.url },
    url: post.url,
  };
  const extra = `  <meta property="article:published_time" content="${post.date}">\n`
    + (post.updated ? `  <meta property="article:modified_time" content="${post.updated}">\n` : '');
  const meta = post.updated
    ? `${timeTag(post.date)} · Обновена на ${timeTag(post.updated)}`
    : timeTag(post.date);
  // Tags: plain labels under the date, not links (there are no tag pages yet), and nowhere else on
  // the site. One line of HTML, so tagging an article is a one-line diff in its page, and no element
  // at all without tags. The "·" ends each tag but the last, inside its <li>, so a row that wraps on
  // a phone ends with a dot instead of starting with one; it is aria-hidden like the footer's
  // separators. role="list" because Safari drops the list role (and with it the aria-label) from a
  // list styled list-style: none.
  const sep = '<span class="vc-article-tags-sep" aria-hidden="true">·</span>';
  const tagList = post.tags.length
    ? `\n        <ul class="vc-article-tags" role="list" aria-label="Теми">${post.tags
      .map((t, i) => `<li class="vc-article-tag">${esc(t)}${i < post.tags.length - 1 ? sep : ''}</li>`)
      .join('')}</ul>`
    : '';

  return head({
    title: post.seoTitle + TITLE_SUFFIX,
    description: post.description,
    canonical: post.url,
    ogType: 'article',
    ogTitle: post.seoTitle,
    // Versioned like every other image URL: a replaced cover is a new URL, so a Facebook/LinkedIn
    // re-scrape fetches the new picture instead of trusting its cached copy of the old one.
    image: `${SITE}${cover.src}`,
    imageAlt: post.imageAlt,
    extra,
    source: post.sourceFile,
    generator: 'scripts/build-blog.js',
    command: 'npm run blog',
  }) + `
  <script type="application/ld+json">
${indentBlock(jsonLd(ld), '  ')}
  </script>
</head>
${header({ blog: 'true' })}
<main id="main-content" tabindex="-1">

  <!-- ARTICLE -->
  <article class="vc-article">
    <div class="vc-container">
      <div class="vc-article-head">
        <a href="/blog" class="vc-article-back"><i class="ti ti-arrow-left" aria-hidden="true"></i>Всички статии</a>
        <h1 class="vc-article-title">${esc(glueDash(post.title))}</h1>
        <p class="vc-article-meta">${meta}</p>${tagList}
      </div>

      <div class="vc-article-cover">
${picture(cover, post.imageAlt, { priority: true, cls: 'vc-article-cover-img' }, '        ')}
      </div>

      <div class="vc-prose">
${indentBlock(body, '        ')}
      </div>

      <aside class="vc-article-cta" aria-label="Пробвайте VetCare">
        <p class="vc-article-cta-text">Пробвайте VetCare&nbsp;- основното е безплатно завинаги.</p>
        <a href="/#demo" class="vc-hero-primary-btn vc-article-cta-btn">Пробвайте демото<i class="ti ti-arrow-right" aria-hidden="true"></i></a>
      </aside>

      <div class="vc-article-foot">
        <a href="/blog" class="vc-article-back"><i class="ti ti-arrow-left" aria-hidden="true"></i>Всички статии</a>
      </div>
    </div>
  </article>

</main>
${FOOTER}`;
}

async function listPage(posts) {
  const cards = [];
  for (const [i, post] of posts.entries()) {
    const cover = await prepareImage(post.image);
    // The first card is above the fold; lazy-loading it would only delay the page's largest image.
    const img = picture(cover, post.imageAlt, { lazy: i > 0, priority: i === 0, cls: 'vc-blog-card-img', sizes: SIZES.card }, '              ');
    cards.push(`        <li>
          <article class="vc-blog-card">
            <div class="vc-blog-card-media">
${img}
            </div>
            <div class="vc-blog-card-body">
              <h2 class="vc-blog-card-title"><a href="${post.path}" class="vc-blog-card-link">${esc(glueDash(post.title))}</a></h2>
              <p class="vc-blog-card-date">${timeTag(post.date)}</p>
              <p class="vc-blog-card-desc">${esc(glueDash(post.description))}</p>
            </div>
          </article>
        </li>
`);
  }
  const list = cards.length
    ? `      <ul class="vc-blog-list">\n${cards.join('')}      </ul>`
    : '      <p class="vc-blog-empty">Скоро тук ще публикуваме първите статии.</p>';

  return head({
    title: 'Блог' + TITLE_SUFFIX,
    description: `${BLOG_INTRO}.`,
    canonical: `${SITE}/blog`,
    ogType: 'website',
    ogTitle: 'Блог' + TITLE_SUFFIX,
    image: SITE_CARD.url,
    imageAlt: SITE_CARD.alt,
    source: 'content/blog/*.md',
    generator: 'scripts/build-blog.js',
    command: 'npm run blog',
  }) + `</head>
${header({ blog: 'page' })}
<main id="main-content" tabindex="-1">

  <!-- BLOG -->
  <section class="vc-blog-section">
    <div class="vc-container">
      <h1 class="vc-blog-title">Блог</h1>
      <p class="vc-blog-intro">${BLOG_INTRO}</p>
${list}
    </div>
  </section>

</main>
${FOOTER}`;
}

// index.html is hand-written, so nothing else ties its Organization "@id" to ORG_ID: fail here
// rather than ship articles that point at an id the home page doesn't define.
function checkHomeOrganization() {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error(`index.html: no <script type="application/ld+json"> block, but articles reference its Organization (${ORG_ID})`);
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (err) {
    throw new Error(`index.html: its JSON-LD doesn't parse (${err.message})`);
  }
  const orgs = (data['@graph'] || []).filter((n) => n['@type'] === 'Organization');
  if (orgs.length !== 1 || orgs[0]['@id'] !== ORG_ID) {
    const found = orgs.map((n) => n['@id']).join(', ') || 'none';
    throw new Error(`index.html: the JSON-LD needs exactly one Organization node with "@id": "${ORG_ID}" (articles name it as author and publisher); found ${found}`);
  }
}

async function main() {
  checkHomeOrganization();
  const posts = await loadPosts();
  for (const post of posts) {
    for (const w of post.warnings) console.warn(`⚠ blog: ${post.sourceFile}: ${w}`);
  }

  for (const post of posts) emit(path.join(OUT_DIR, `${post.slug}.html`), await articlePage(post));
  emit(path.join(OUT_DIR, 'index.html'), await listPage(posts));
  removeStale(OUT_DIR);

  // Not an error — but an image nobody references is usually one an edited article forgot.
  const imagesDir = path.join(CONTENT_DIR, 'images');
  if (fs.existsSync(imagesDir)) {
    for (const f of fs.readdirSync(imagesDir, { recursive: true })) {
      const publicPath = IMAGE_PREFIX + String(f).replace(/\\/g, '/');
      if (fs.statSync(path.join(imagesDir, f)).isFile() && !prepared.has(publicPath)) {
        console.warn(`⚠ blog: content/blog/images/${String(f).replace(/\\/g, '/')} isn't used by any article`);
      }
    }
  }

  console.log(`✅ blog — ${posts.length} article(s): /blog${posts.map((p) => `, ${p.path}`).join('')}`);
}

main().catch((err) => {
  console.error(`❌ blog: ${err.message}`);
  process.exit(1);
});
