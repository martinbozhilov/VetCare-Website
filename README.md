# VetCare Website

Marketing landing page for VetCare, a free veterinary clinic management software. Static single-page site (HTML/CSS/JS, Alpine.js for interactivity), content in Bulgarian.

## Running locally

There's no dev server config in this repo. Serve the folder (or open the file directly) and run the build watcher alongside it:

```bash
# Terminal 1: serve the site (all source lives in src/)
npx serve src
# or: (cd src && python -m http.server 8000)
# or just open src/index.html directly in a browser

# Terminal 2: one-time setup, then watch for JS changes
cd src
npm install
npm run watch
```

`index.html` loads `assets/js/main.min.js` and `assets/css/styles.min.css`, not the source files. `npm run watch` only re-minifies JS on save — after editing `assets/css/styles.css`, run `npm run build` and refresh manually.

## Blog

Articles live in `src/content/blog/` — one Markdown file per article (`<slug>.md`), its images in `src/content/blog/images/`. `npm run build` (or `npm run blog`) turns them into static pages at `/blog` and `/blog/<slug>`, and updates `sitemap.xml`. Commit the generated `src/blog/` and `sitemap.xml` together with the article. The frontmatter fields and rules are in [CLAUDE.md](./CLAUDE.md#blog).

## Form submissions

The waitlist and contact forms send their data to `hello@vetcare.bg` via [Web3Forms](https://web3forms.com) (with hCaptcha), a client-side form relay, since this site has no backend of its own. The delivery config lives in the `VETCARE_CONTACT` object at the top of `assets/js/main.js`, which holds the live access key.

```js
const VETCARE_CONTACT = {
  toEmail: 'hello@vetcare.bg',
  web3formsEndpoint: 'https://api.web3forms.com/submit',
  web3formsAccessKey: '…',
};
```

The demo form is different: it POSTs to the VetCare app's `/api/demo/request`. That URL comes from `<meta name="vetcare-demo-api">` in `index.html`, filled at image build time from `DEMO_API_URL`.

Details are in [CLAUDE.md](./CLAUDE.md#form-submissions).

## Structure

- `index.html` — all page sections (hero, how it works, benefits, story, pricing, demo, FAQ, contact, footer)
- `assets/js/main.js` — Alpine.js component with UI state and form handling
- `assets/css/styles.css` — all styles, organized by section
- `assets/images/` — site imagery
- `content/blog/` — blog articles (Markdown) and their images; `blog/` is generated from them by `scripts/build-blog.js`

Everything above lives under the `src/` directory, which is the project root — `cd src` before running any `npm` command, and paths are relative to it.

See [CLAUDE.md](./CLAUDE.md) for more detailed architecture notes and conventions.
