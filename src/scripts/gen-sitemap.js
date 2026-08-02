// Generates sitemap.xml from the HTML pages that actually exist in this directory.
//
// Why this exists: the file used to be hand-maintained and drifted. It claimed 2026-07-30 for both
// pages long after index.html and privacy.html had been edited on two different days — and a
// <lastmod> that can't be trusted is worse than none at all, because Google stops taking the
// sitemap's freshness signals seriously rather than just ignoring the bad field. Deriving the date
// from git makes it correct by construction.
//
// Pages are discovered, not listed: any *.html here is included unless it declares
// <meta name="robots" content="noindex">. Adding a page therefore needs no edit in this file
// (an <image:image> entry is the one thing worth adding by hand — see IMAGES below).
//
// Runs as part of `npm run build`. The output is committed like the other generated files, which
// is what makes the Docker build safe: .dockerignore drops .git, so there is no commit history in
// the image build. Without it this script would have to invent dates; instead it leaves the
// committed sitemap.xml untouched and exits (see the gitAvailable check).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..');
const OUT = path.join(SRC, 'sitemap.xml');
const SITE = 'https://vetcare.bg';

// Per-page <image:image> entries. Keys are file names, `loc` is relative to this directory.
// Every path is checked against the disk below: the og:image/twitter:image tags and this list have
// referenced a file that was never committed before, and nothing else catches that.
const IMAGES = {
  'index.html': [
    { loc: 'assets/images/rex-kolaj.png', title: 'Рекс — кучето, заради което създадохме VetCare' },
  ],
};

// Matches <meta name="robots" ... content="...noindex..."> in either attribute order.
const NOINDEX = /<meta\b(?=[^>]*\bname=["']robots["'])(?=[^>]*\bcontent=["'][^"']*noindex)[^>]*>/i;

const today = () => new Date().toISOString().slice(0, 10);

function git(args) {
  return execFileSync('git', args, {
    cwd: SRC,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// The date the page's content last changed. An uncommitted edit is happening right now, so it wins
// over the last commit — otherwise a build made while editing would stamp the previous commit's date.
function lastmod(file) {
  if (git(['status', '--porcelain', '--', file]).trim()) return today();
  return git(['log', '-1', '--format=%cs', '--', file]).trim() || today();
}

// index.html is served at the bare path; everything else keeps its file name, which is what
// nginx's `try_files $uri $uri/` resolves.
const urlFor = (file) => (file === 'index.html' ? `${SITE}/` : `${SITE}/${file}`);

const escape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function main() {
  try {
    git(['rev-parse', '--is-inside-work-tree']);
  } catch {
    console.log('· sitemap: no git here (Docker build?) — keeping the committed sitemap.xml');
    return;
  }

  const pages = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => {
      const html = fs.readFileSync(path.join(SRC, f), 'utf8');
      if (NOINDEX.test(html)) {
        console.log(`· sitemap: skipping ${f} (noindex)`);
        return false;
      }
      return true;
    })
    // index.html first, the rest alphabetically — purely so the diff stays readable.
    .sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));

  if (!pages.length) throw new Error('no indexable HTML pages found — refusing to write an empty sitemap');

  const entries = pages.map((file) => {
    const images = (IMAGES[file] || []).map((img) => {
      if (!fs.existsSync(path.join(SRC, img.loc))) {
        throw new Error(`${file}: sitemap image ${img.loc} does not exist on disk`);
      }
      return (
        `    <image:image>\n` +
        `      <image:loc>${SITE}/${img.loc}</image:loc>\n` +
        `      <image:title>${escape(img.title)}</image:title>\n` +
        `    </image:image>\n`
      );
    });

    return (
      `  <url>\n` +
      `    <loc>${urlFor(file)}</loc>\n` +
      `    <lastmod>${lastmod(file)}</lastmod>\n` +
      images.join('') +
      `  </url>\n`
    );
  });

  // No <priority>/<changefreq>: Google ignores both outright, and they were the other half of the
  // hand-maintained noise this script replaces.
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
    `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
    entries.join('') +
    `</urlset>\n`;

  fs.writeFileSync(OUT, xml);
  console.log(`✅ sitemap.xml — ${pages.length} page(s): ${pages.map(urlFor).join(', ')}`);
}

main();
