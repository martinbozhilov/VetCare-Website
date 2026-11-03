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
// The page shell (head, header, footer, consent banner) is a copy of privacy.html / 404.html with
// root-absolute URLs. A nav or footer change has to be made here too — see CLAUDE.md, "Blog".
//
// Run `npm run blog` (or `npm run build`, which calls it first). Article format: see
// scripts/lib/blog-posts.js.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { SRC, SITE } = require('./lib/pages');
const {
  CONTENT_DIR, IMAGE_PREFIX, LONG_DASH, loadPosts, imageSource, withVersion,
} = require('./lib/blog-posts');

const OUT_DIR = path.join(SRC, 'blog');
const TITLE_SUFFIX = ' | VetCare - софтуер за ветеринарни клиники';
const LOGO = `${SITE}/assets/images/vetcare-logo-512.png`;
// The list page has no image of its own, so it shares the site's link-preview card.
const SITE_CARD = { url: `${SITE}/assets/images/vetcare-og.jpg`, alt: 'Екранът с пациентите във VetCare' };
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// The site writes a dash as " - " (no em or en dashes). Where a line wraps at the space before it,
// the next line starts with "- " and reads like a list bullet, so in visible text the space before
// the dash is a no-break space. Meta tags and JSON-LD keep the plain text.
const glueDash = (s) => s.replace(/ - /g, ' - ');
// JSON inside <script>: a "</script>" in any value would end the block early.
const jsonLd = (obj) => JSON.stringify(obj, null, 2).replace(/</g, '\\u003c');
const rel = (file) => path.relative(SRC, file).replace(/\\/g, '/');

// ── Output bookkeeping ────────────────────────────────────────────────────────────────────────
// Files are only rewritten when their bytes change, so an unchanged build leaves mtimes alone and
// `npm run watch` doesn't see its own output as an edit.
const written = new Set();
function emit(file, content) {
  // House style: no em or en dashes in anything a visitor reads, the site uses " - " instead.
  // Articles are checked line by line in lib/blog-posts.js; this catches the templates in this file.
  if (typeof content === 'string' && LONG_DASH.test(content.replace(/<!--[\s\S]*?-->/g, ''))) {
    throw new Error(`${rel(file)}: the page text contains a long dash (— or –); use " - " instead`);
  }
  written.add(path.resolve(file));
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (fs.existsSync(file) && fs.readFileSync(file).equals(buf)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
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
// marked is ESM-only, hence the dynamic import from this CommonJS script.
let markedModule = null;
async function renderMarkdown(post) {
  if (!markedModule) markedModule = await import('marked');
  const md = new markedModule.Marked({ gfm: true });

  const tokens = md.lexer(post.body);
  const images = [];
  md.walkTokens(tokens, (t) => {
    // The page already has its one H1 — the title from the frontmatter.
    if (t.type === 'heading' && t.depth === 1) {
      throw new Error(`${post.sourceFile}: "# ${t.text}" is an H1; the title is the page's only H1 — use ## for sections`);
    }
    if (t.type === 'image') images.push(t.href);
    // Plain text only: code spans and URLs are other token types, so they keep their spaces.
    if (t.type === 'text') t.text = glueDash(t.text);
  });
  const ready = new Map();
  for (const href of images) {
    try {
      ready.set(href, await prepareImage(href, { maxWidth: INLINE_MAX_WIDTH }));
    } catch (err) {
      throw new Error(`${post.sourceFile}: ${err.message}`);
    }
  }

  // An image alone in its paragraph becomes a captioned figure. The caption is the image's title
  // if it has one (`![alt](src "caption")`), else its alt text — and when it repeats the alt it is
  // hidden from screen readers, which would otherwise read the same sentence twice.
  const figure = (t) => {
    const caption = t.title || t.text;
    const pic = picture(ready.get(t.href), t.text, { lazy: true }, '  ');
    if (!caption) return `<figure>\n${pic}\n</figure>\n`;
    const hidden = caption === t.text ? ' aria-hidden="true"' : '';
    return `<figure>\n${pic}\n  <figcaption${hidden}>${esc(caption)}</figcaption>\n</figure>\n`;
  };

  md.use({
    renderer: {
      paragraph(token) {
        const parts = token.tokens.filter((t) => !(t.type === 'text' && !t.text.trim()));
        if (parts.length === 1 && parts[0].type === 'image') return figure(parts[0]);
        return false; // marked's default
      },
      image(token) {
        return picture(ready.get(token.href), token.text, { lazy: true });
      },
    },
  });
  return md.parser(tokens);
}

// ── Page shell ────────────────────────────────────────────────────────────────────────────────
// Mirrors privacy.html / 404.html. Every URL is root-absolute: pages live one directory down and
// are served without an extension, so relative URLs would resolve against /blog/.
function head({ title, description, canonical, ogType, ogTitle, image, imageAlt, extra = '', source }) {
  return `<!DOCTYPE html>
<!-- GENERATED by scripts/build-blog.js from ${source} — do not edit; run \`npm run blog\`. -->
<html lang="bg">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">

  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}">
  <meta name="robots" content="index, follow, max-image-preview:large">
  <link rel="canonical" href="${esc(canonical)}">

  <meta property="og:type" content="${ogType}">
  <meta property="og:url" content="${esc(canonical)}">
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:description" content="${esc(description)}">
  <meta property="og:locale" content="bg_BG">
  <meta property="og:site_name" content="VetCare">
  <meta property="og:image" content="${esc(image)}">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${esc(imageAlt)}">
${extra}  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:description" content="${esc(description)}">
  <meta name="twitter:image" content="${esc(image)}">
  <meta name="twitter:image:alt" content="${esc(imageAlt)}">

  <meta name="theme-color" content="#207885">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
  <link rel="preload" as="style" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap" onload="this.onload=null;this.rel='stylesheet'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap"></noscript>

  <link rel="preconnect" href="https://cdn.jsdelivr.net">

  <!-- Self-hosted icon subset — see the matching block in index.html for why it isn't deferred. -->
  <link rel="preload" as="font" type="font/woff2" href="/assets/fonts/tabler-icons-subset.woff2" crossorigin>
  <link rel="stylesheet" href="/assets/css/icons.min.css">

  <link rel="preconnect" href="https://eu.i.posthog.com">
  <link rel="preconnect" href="https://eu-assets.i.posthog.com">
  <link rel="stylesheet" href="/assets/css/styles.min.css">

  <style>[x-cloak]{display:none!important}</style>
  <script defer src="/assets/js/main.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.14.1/dist/cdn.min.js"></script>
`;
}

const NAV = [
  ['/#kak-raboti', 'Как работи'],
  ['/#polzi', 'Ползи'],
  ['/#istoriya', 'История'],
  ['/#ceni', 'Цени'],
  ['/#kontakti', 'Контакти'],
];

// `current` is the aria-current value of the Блог link: "page" on /blog itself, "true" on an
// article (inside the blog, but not the blog page).
function header(current) {
  const desktop = NAV.map(([href, label]) => `      <a href="${href}" class="vc-nav-link">${label}</a>\n`).join('');
  const mobile = NAV.map(([href, label]) => `    <a href="${href}" @click="menuOpen = false" class="vc-mobile-menu-link">${label}</a>\n`).join('');
  return `<body x-data="vetcare">

<a class="vc-skip-link" href="#main-content">Прескочете към съдържанието</a>

<!-- HEADER -->
<header class="vc-header" :class="{ 'is-scrolled': scrolled, 'is-open': menuOpen }"
  @click.outside="menuOpen = false" @keydown.escape.window="menuOpen = false">
  <div class="vc-header-inner">
    <a href="/" class="vc-logo">
      <img src="/assets/images/rex-icon.svg" alt="VetCare лого - дигиталният Рекс" width="34" height="38">
      <span class="vc-logo-text">
        <span class="vc-logo-name">VetCare</span>
        <span class="vc-logo-sub">VETERINARY SOFTWARE</span>
      </span>
    </a>

    <nav class="vc-nav-desktop" aria-label="Главна навигация">
${desktop}      <a href="/blog" class="vc-nav-link is-active" aria-current="${current}">Блог</a>
      <a href="/#demo" class="vc-cta-btn">Пробвайте демо<i class="ti ti-arrow-right" aria-hidden="true"></i></a>
    </nav>

    <button @click="menuOpen = !menuOpen" :aria-label="menuOpen ? 'Затворете менюто' : 'Отворете менюто'"
      :aria-expanded="menuOpen.toString()" aria-controls="vc-mobile-menu" class="vc-hamburger">
      <i :class="menuOpen ? 'ti ti-x' : 'ti ti-menu-2'" aria-hidden="true"></i>
    </button>
  </div>

  <nav x-show="menuOpen" x-transition.opacity.duration.200ms id="vc-mobile-menu" class="vc-mobile-menu"
    aria-label="Мобилна навигация" style="display:none">
${mobile}    <a href="/blog" @click="menuOpen = false" class="vc-mobile-menu-link is-active" aria-current="${current}">Блог</a>
    <a href="/#demo" @click="menuOpen = false" class="vc-mobile-cta">Пробвайте демо<i class="ti ti-arrow-right" aria-hidden="true"></i></a>
  </nav>
</header>
`;
}

const FOOTER = `
  <!-- FOOTER -->
  <footer class="vc-footer">
    <div class="vc-footer-inner">
      <div class="vc-footer-top">
        <div class="vc-footer-brand">
          <div class="vc-footer-logo">
            <img src="/assets/images/rex-icon.svg" alt="VetCare лого" width="34" height="40">
            <span class="vc-footer-logo-text"><span class="vc-footer-logo-name">VetCare</span><span class="vc-footer-logo-sub">VETERINARY SOFTWARE</span></span>
          </div>
          <p class="vc-footer-tagline">Софтуер за ветеринарни клиники. Основните функции са безплатни.</p>
        </div>
        <nav class="vc-footer-nav" aria-label="Навигация">
          <span class="vc-footer-nav-heading">Навигация</span>
          <a href="/#kak-raboti" class="vc-footer-nav-link">Как работи</a>
          <a href="/#polzi" class="vc-footer-nav-link">Ползи</a>
          <a href="/#istoriya" class="vc-footer-nav-link">История</a>
          <a href="/#ceni" class="vc-footer-nav-link">Цени</a>
          <a href="/blog" class="vc-footer-nav-link">Блог</a>
        </nav>
        <nav class="vc-footer-nav" aria-label="Връзки">
          <span class="vc-footer-nav-heading">Връзка</span>
          <a href="/#demo" class="vc-footer-nav-link">Пробвайте демо</a>
          <a href="/#waitlist" class="vc-footer-nav-link">Ранна покана</a>
          <a href="/#kontakti" class="vc-footer-nav-link">Контакти</a>
          <a href="mailto:hello@vetcare.bg" class="vc-footer-nav-link">hello@vetcare.bg</a>
        </nav>
      </div>
      <div class="vc-footer-bottom">
        <!-- The literal year is the pre-hydration / no-JS fallback; Alpine overwrites it on init. -->
        <span>© <span x-text="new Date().getFullYear()">2026</span> VetCare</span>
        <span class="vc-footer-sep" aria-hidden="true">·</span>
        <a href="/privacy.html" class="vc-footer-legal-link">Поверителност и бисквитки</a>
        <span class="vc-footer-sep" aria-hidden="true">·</span>
        <button type="button" @click="openConsent()" class="vc-footer-cookie-btn">Управление на бисквитките</button>
      </div>
    </div>
  </footer>

<button type="button" x-show="scrollProgress > 0.15 && !showConsent" x-transition.opacity.duration.200ms
  style="display:none" @click="scrollToTop()" class="vc-to-top" aria-label="Обратно към началото">
  <i class="ti ti-arrow-up" aria-hidden="true"></i>
</button>

<div x-show="showConsent" style="display:none" class="vc-consent" role="dialog" aria-live="polite" aria-label="Съгласие за бисквитки">
  <p class="vc-consent-text">
    Използваме бисквитки и анализ на посещенията, за да подобряваме VetCare. Данните се събират само след вашето съгласие. Повече в
    <a href="/privacy.html" class="vc-consent-link">политиката за поверителност</a>.
  </p>
  <div class="vc-consent-actions">
    <button type="button" @click="declineAnalytics()" class="vc-consent-btn vc-consent-btn--decline">Отказвам</button>
    <button type="button" @click="acceptAnalytics()" class="vc-consent-btn">Приемам</button>
  </div>
</div>

</body>
</html>
`;

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
    // No byline on the page; structured data names the organisation, not a person.
    author: { '@type': 'Organization', name: 'VetCare', url: SITE },
    publisher: { '@type': 'Organization', name: 'VetCare', url: SITE, logo: { '@type': 'ImageObject', url: LOGO } },
    mainEntityOfPage: { '@type': 'WebPage', '@id': post.url },
    url: post.url,
  };
  const extra = `  <meta property="article:published_time" content="${post.date}">\n`
    + (post.updated ? `  <meta property="article:modified_time" content="${post.updated}">\n` : '');
  const meta = post.updated
    ? `${timeTag(post.date)} · Обновена на ${timeTag(post.updated)}`
    : timeTag(post.date);

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
  }) + `
  <script type="application/ld+json">
${indentBlock(jsonLd(ld), '  ')}
  </script>
</head>
${header('true')}
<main id="main-content" tabindex="-1">

  <!-- ARTICLE -->
  <article class="vc-article">
    <div class="vc-container">
      <div class="vc-article-head">
        <a href="/blog" class="vc-article-back"><i class="ti ti-arrow-left" aria-hidden="true"></i>Всички статии</a>
        <h1 class="vc-article-title">${esc(glueDash(post.title))}</h1>
        <p class="vc-article-meta">${meta}</p>
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
  }) + `</head>
${header('page')}
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

async function main() {
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
