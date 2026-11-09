// Reads and validates the blog articles in content/blog/*.md.
//
// Shared by scripts/build-blog.js (renders them) and scripts/gen-sitemap.js (lists them). Every
// check here fails the build with the file name and the reason, because the alternative is a
// broken page or a broken link preview that nobody notices until it has been shared.
//
// An article is a Markdown file with a frontmatter block of flat `key: value` lines between two
// `---` lines. This is deliberately not YAML: there is nothing nested to express, and a YAML parser
// would turn `date: 2026-11-06` into a Date object and choke on an unquoted colon in a title.
// Values may be wrapped in single or double quotes; everything after the first `: ` is the value.
//
// Images are addressed by their public URL (`/blog/images/<file>`) and live in
// content/blog/images/<file>; build-blog.js copies them to blog/images/ next to the pages.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const { SRC, SITE } = require('./pages');

const CONTENT_DIR = path.join(SRC, 'content', 'blog');
const IMAGE_PREFIX = '/blog/images/';

const FIELDS = {
  title: true, // the H1
  slug: true, // must equal the file name; the URL is /blog/<slug>
  date: true, // YYYY-MM-DD, publication date
  description: true, // meta description, ~155 characters
  image: true, // /blog/images/<file>.jpg, exactly 1200 x 630
  image_alt: true,
  seo_title: false, // <title>/og:title when the H1 is too long for a search result
  updated: false, // YYYY-MM-DD, set when the article is materially revised (dateModified)
  // The search phrase the article targets: a note for whoever writes it, never output. Google ignores
  // <meta name="keywords">, so there is nothing to render it into; it is accepted so that articles
  // drafted with it can be dropped in as they are.
  keyword: false,
  // Topic labels, 1-4 comma-separated on one line: `tags: дневници, екип и права`. Shown under the
  // date on the article page and nowhere else (not on /blog, in <head>, the JSON-LD or the sitemap),
  // as plain labels, not links. Which tags exist is a closed list in the marketing repo
  // (data/tags.md), checked there; the build only checks their form (parseTags). Blank means none.
  tags: false,
};

// The share image is shown by Facebook, LinkedIn, X and WhatsApp exactly as the og:image:* tags
// describe it, so its size is fixed rather than merely recommended. See docs/brand/og-image.html for
// why it is an opaque JPG; WhatsApp silently drops previews over 600 KB.
const COVER = { width: 1200, height: 630, hardLimit: 600 * 1024, softLimit: 300 * 1024 };

// House style for everything a visitor reads: no em dash (—) or en dash (–). The site's copy uses a
// hyphen with spaces (" - ") instead, so an article that brings its own dashes fails the build.
const LONG_DASH = /[—–]/;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set(['index', 'images']); // blog/index.html, blog/images/

const kb = (n) => `${Math.round(n / 1024)} KB`;
const length = (s) => [...s].length;

function isoDate(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field}: "${value}" is not YYYY-MM-DD`);
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new Error(`${field}: "${value}" is not a real date`);
  }
  return value;
}

// tags: comma-separated, each value trimmed; blank (or absent) means no tags, like the other
// optional fields. A tag is lowercase words with exactly one ordinary space (U+0020) between them,
// written entirely in Cyrillic а-я (U+0430-U+044F) or entirely in Latin a-z. Anything else fails
// rather than being normalised: a tag has to match the marketing repo's list exactly, and a capital,
// a no-break space or a Latin "с" inside a Cyrillic word looks the same on screen but is not the
// same tag. Messages name the offending character by code point, since some of them are invisible.
const MAX_TAGS = 4;
const CYRILLIC_TAG = /^[а-я]+(?: [а-я]+)*$/;
const LATIN_TAG = /^[a-z]+(?: [a-z]+)*$/;
const SINGLE_SPACED = /^\S+(?: \S+)*$/; // \s also matches tabs and no-break spaces
const TAG_CHAR = /[а-яa-z ]/;
const charName = (ch) => `"${ch}" (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`;

function parseTags(value) {
  if (!value) return [];
  const tags = value.split(',').map((t) => t.trim());
  if (tags.includes('')) {
    throw new Error(`tags: "${value}" has an empty tag; check for a leading, trailing or doubled comma`);
  }
  if (tags.length > MAX_TAGS) {
    throw new Error(`tags: "${value}" has ${tags.length} tags; an article takes 1 to ${MAX_TAGS}`);
  }
  for (const tag of tags) {
    if (CYRILLIC_TAG.test(tag) || LATIN_TAG.test(tag)) continue;
    if (!SINGLE_SPACED.test(tag)) {
      throw new Error(`tags: "${tag}" must have exactly one ordinary space between words (no double spaces, tabs or no-break spaces)`);
    }
    const bad = [...tag].find((ch) => !TAG_CHAR.test(ch));
    if (bad) {
      throw new Error(`tags: "${tag}" contains ${charName(bad)}; a tag is lowercase letters (а-я or a-z) and single spaces`);
    }
    // Only allowed characters and spacing, yet neither pattern matched, so both alphabets are in it.
    // Name the letters of the smaller group: that is almost always the lookalike that slipped in.
    const letters = [...tag].filter((ch) => ch !== ' ');
    const latin = letters.filter((ch) => /[a-z]/.test(ch));
    const cyrillic = letters.filter((ch) => !/[a-z]/.test(ch));
    const [odd, alphabet] = latin.length <= cyrillic.length ? [latin, 'Latin'] : [cyrillic, 'Cyrillic'];
    throw new Error(`tags: "${tag}" mixes Cyrillic and Latin letters (${alphabet} ${[...new Set(odd)].map(charName).join(', ')}); write each tag in one alphabet`);
  }
  const repeated = tags.find((t, i) => tags.indexOf(t) !== i);
  if (repeated) throw new Error(`tags: "${repeated}" is listed more than once`);
  return tags;
}

function parseFrontmatter(text) {
  const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) throw new Error('must start with a frontmatter block between two "---" lines');

  const data = {};
  m[1].split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const kv = line.match(/^([a-z_]+):(?:\s+(.*))?$/);
    if (!kv) throw new Error(`frontmatter line ${i + 2}: expected "key: value", got "${line}"`);
    const key = kv[1];
    let value = (kv[2] || '').trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1).trim();
    if (!(key in FIELDS)) {
      throw new Error(`unknown frontmatter field "${key}" (allowed: ${Object.keys(FIELDS).join(', ')})`);
    }
    if (key in data) throw new Error(`frontmatter field "${key}" appears twice`);
    data[key] = value;
  });

  for (const [key, required] of Object.entries(FIELDS)) {
    if (required && !data[key]) throw new Error(`frontmatter field "${key}" is missing or empty`);
  }
  return { data, body: m[2] };
}

// Maps a public image URL to the file on disk. /blog/images/* comes from content/blog/images/;
// anything else root-absolute (e.g. an existing screenshot under /assets/images/) is served as is.
function imageSource(publicPath) {
  if (!publicPath.startsWith('/') || publicPath.startsWith('//') || /[?#]|\.\./.test(publicPath)) {
    throw new Error(`image "${publicPath}" must be a root-absolute path on this site, e.g. ${IMAGE_PREFIX}<file>.jpg`);
  }
  const file = publicPath.startsWith(IMAGE_PREFIX)
    ? path.join(CONTENT_DIR, 'images', publicPath.slice(IMAGE_PREFIX.length))
    : path.join(SRC, publicPath.slice(1));
  if (!fs.existsSync(file)) {
    throw new Error(`image "${publicPath}" not found — expected ${path.relative(SRC, file).replace(/\\/g, '/')}`);
  }
  return file;
}

// Every image URL the blog emits carries ?v=<hash of the file's bytes>, so a replaced image gets a
// new URL and /blog/images/ can be cached for a year (nginx.conf). Hashing the bytes, not a build
// id, means an unchanged image keeps its URL — and its cached copies — across builds and deploys.
const contentVersion = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
const withVersion = (url, buf) => `${url}?v=${contentVersion(buf)}`;
// The versioned URL of an image as it is served. /blog/images/* is a byte-for-byte copy of its
// source, so the source's hash is the served file's hash — which lets gen-sitemap.js compute the
// same URL without depending on build output.
const versionedImage = (publicPath) => withVersion(publicPath, fs.readFileSync(imageSource(publicPath)));

async function checkCover(publicPath, warn) {
  if (!publicPath.startsWith(IMAGE_PREFIX)) throw new Error(`image must live under ${IMAGE_PREFIX}`);
  const file = imageSource(publicPath);
  const meta = await sharp(file).metadata();
  if (meta.format !== 'jpeg') {
    throw new Error(`image ${publicPath} is ${meta.format}, not a JPG — link previews need an opaque JPG`);
  }
  if (meta.width !== COVER.width || meta.height !== COVER.height) {
    throw new Error(`image ${publicPath} is ${meta.width} x ${meta.height}; it must be exactly ${COVER.width} x ${COVER.height}`);
  }
  const size = fs.statSync(file).size;
  if (size > COVER.hardLimit) {
    throw new Error(`image ${publicPath} is ${kb(size)}; WhatsApp drops previews over ${kb(COVER.hardLimit)} — recompress it`);
  }
  if (size > COVER.softLimit) warn(`image ${publicPath} is ${kb(size)}; aim for under ${kb(COVER.softLimit)}`);
  return file;
}

async function loadPost(fileName) {
  const warnings = [];
  const warn = (msg) => warnings.push(msg);
  const text = fs.readFileSync(path.join(CONTENT_DIR, fileName), 'utf8');
  const dashLines = text.split(/\r?\n/).flatMap((line, i) => (LONG_DASH.test(line) ? [i + 1] : []));
  if (dashLines.length) {
    throw new Error(`long dash (— or –) on line ${dashLines.join(', ')}; the site uses " - " (a hyphen with spaces) instead`);
  }
  const { data, body } = parseFrontmatter(text);

  const expected = path.basename(fileName, '.md');
  if (!SLUG.test(data.slug)) {
    throw new Error(`slug "${data.slug}" must be lowercase Latin letters, digits and single hyphens`);
  }
  if (data.slug !== expected) throw new Error(`slug "${data.slug}" must match the file name (${expected}.md)`);
  if (RESERVED_SLUGS.has(data.slug)) throw new Error(`slug "${data.slug}" is reserved`);

  const date = isoDate(data.date, 'date');
  const updated = data.updated ? isoDate(data.updated, 'updated') : null;
  if (updated && updated < date) throw new Error(`updated (${updated}) is before date (${date})`);
  const tags = parseTags(data.tags);
  const today = new Date().toISOString().slice(0, 10);
  if (date > today) warn(`date ${date} is in the future — the page will show it as is`);

  const searchTitle = data.seo_title || data.title;
  if (length(searchTitle) > 60) {
    warn(`${data.seo_title ? 'seo_title' : 'title'} is ${length(searchTitle)} characters; search results cut it at ~60 — set or shorten seo_title`);
  }
  if (length(data.description) > 160) {
    warn(`description is ${length(data.description)} characters; search results cut it at ~155`);
  }

  const coverFile = await checkCover(data.image, warn);

  return {
    sourceFile: path.relative(SRC, path.join(CONTENT_DIR, fileName)).replace(/\\/g, '/'),
    coverSourceFile: path.relative(SRC, coverFile).replace(/\\/g, '/'),
    slug: data.slug,
    title: data.title,
    seoTitle: searchTitle,
    date,
    updated,
    tags,
    description: data.description,
    image: data.image,
    imageAlt: data.image_alt,
    body,
    path: `/blog/${data.slug}`,
    url: `${SITE}/blog/${data.slug}`,
    warnings,
  };
}

// Newest first, which is the order of the list page. Same-day articles fall back to the slug so the
// order (and therefore the generated HTML) never depends on the file system.
async function loadPosts() {
  const files = fs.existsSync(CONTENT_DIR)
    ? fs.readdirSync(CONTENT_DIR).filter((f) => f.endsWith('.md')).sort()
    : [];
  const posts = [];
  const errors = [];
  for (const f of files) {
    try {
      posts.push(await loadPost(f));
    } catch (err) {
      errors.push(`content/blog/${f}: ${err.message}`);
    }
  }
  if (errors.length) throw new Error(`invalid blog article(s):\n  ${errors.join('\n  ')}`);
  return posts.sort((a, b) => (a.date === b.date ? a.slug.localeCompare(b.slug) : a.date < b.date ? 1 : -1));
}

module.exports = { CONTENT_DIR, IMAGE_PREFIX, LONG_DASH, loadPosts, imageSource, withVersion, versionedImage };
