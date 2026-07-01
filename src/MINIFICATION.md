# CSS & JS Minification

Uses [esbuild](https://esbuild.github.io/) to minify `assets/js/main.js` and `assets/css/styles.css`.

## Prerequisites

Node.js must be installed. Run once to install dependencies:

```bash
npm install
```

## Commands

| Command | Description |
|---|---|
| `npm run build` | Minify JS and CSS once |
| `npm run watch` | Re-minify JS automatically on every save |

## Output files

| Source | Minified output |
|---|---|
| `assets/js/main.js` | `assets/js/main.min.js` |
| `assets/css/styles.css` | `assets/css/styles.min.css` |

Reference the `.min.` files in `index.html` for production.
