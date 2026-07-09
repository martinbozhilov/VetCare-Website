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

## Form submissions

The demo, waitlist, and contact forms send their data to `hello@vetcare.bg` via [Web3Forms](https://web3forms.com) — a client-side form relay, since this site has no backend of its own.

All delivery config (destination email, endpoint, access key) lives in one place: the `VETCARE_CONTACT` object at the top of `assets/js/main.js`.

```js
const VETCARE_CONTACT = {
  toEmail: 'hello@vetcare.bg',
  web3formsEndpoint: 'https://api.web3forms.com/submit',
  web3formsAccessKey: 'REPLACE_WITH_WEB3FORMS_ACCESS_KEY',
};
```

## Structure

- `index.html` — all page sections (hero, how it works, benefits, story, pricing, demo, FAQ, contact, footer)
- `assets/js/main.js` — Alpine.js component with UI state and form handling
- `assets/css/styles.css` — all styles, organized by section
- `assets/images/` — site imagery

Everything above lives under the `src/` directory, which is the project root — `cd src` before running any `npm` command, and paths are relative to it.

See [CLAUDE.md](./CLAUDE.md) for more detailed architecture notes and conventions.
