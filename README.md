# VetCare Website

Marketing landing page for VetCare, a free veterinary clinic management software. Static single-page site (HTML/CSS/JS, Alpine.js for interactivity), content in Bulgarian.

## Running locally

There's no dev server config in this repo. Serve the folder (or open the file directly) and run the build watcher alongside it:

```bash
# Terminal 1: serve the site
npx serve .
# or: python -m http.server 8000
# or just open index.html directly in a browser

# Terminal 2: one-time setup, then watch for JS changes
npm install
npm run watch
```

`index.html` loads `assets/js/main.min.js` and `assets/css/styles.min.css`, not the source files. `npm run watch` only re-minifies JS on save — after editing `assets/css/styles.css`, run `npm run build` and refresh manually.

## Structure

- `index.html` — all page sections (hero, how it works, benefits, story, pricing, demo, FAQ, contact, footer)
- `assets/js/main.js` — Alpine.js component with UI state and form handling
- `assets/css/styles.css` — all styles, organized by section
- `assets/images/` — site imagery

See [CLAUDE.md](./CLAUDE.md) for more detailed architecture notes and conventions.
