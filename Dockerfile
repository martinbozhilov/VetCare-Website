# ─────────────────────────────────────────────────────────────
# Stage 1 — build the static assets (esbuild minify via npm run build)
# ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

# install deps first for layer caching (package files live under src/)
COPY src/package.json src/package-lock.json ./
RUN npm ci

# bring in the source and produce assets/js/main.min.js + assets/css/styles.min.css
COPY src/ ./
RUN npm run build

# Cache busting. The built filenames are stable across deploys, so this query string is the only
# thing that tells a browser — or the Cloudflare edge — that the bytes changed.
#
# The webfont is in this list for a reason. Its URL appears twice (the preload in the HTML and the
# @font-face in icons.min.css) and used to be the one asset left unversioned, so a redeploy served
# the new icons.min.css immediately while the font came from cache for the full max-age in
# nginx.conf. Any glyph added in that deploy then renders as *nothing* — font-display: block, and
# no fallback font covers Tabler's PUA codepoints. Both copies must get the same BUILD_ID, or the
# preload no longer matches the @font-face and the file is fetched twice.
#
# privacy.html is rewritten alongside index.html: it loads the same four assets and was previously
# left out entirely, so it shipped uncacheable-busted references on every deploy.
RUN BUILD_ID=$(date +%s) && \
    sed -i "s/main.min.js/main.min.js?v=${BUILD_ID}/g" index.html privacy.html && \
    sed -i "s/styles.min.css/styles.min.css?v=${BUILD_ID}/g" index.html privacy.html && \
    sed -i "s/icons.min.css/icons.min.css?v=${BUILD_ID}/g" index.html privacy.html && \
    sed -i "s|tabler-icons-subset\.woff2|tabler-icons-subset.woff2?v=${BUILD_ID}|g" \
        index.html privacy.html assets/css/icons.min.css && \
    for f in index.html privacy.html assets/css/icons.min.css; do \
      grep -q "tabler-icons-subset.woff2?v=${BUILD_ID}" "$f" \
        || { echo "❌ Font cache-busting missed $f — did the preload or @font-face url pattern change?"; exit 1; }; \
    done && \
    echo "✅ assets busted with ?v=${BUILD_ID}"

# Demo-provisioning endpoint, baked into the <meta name="vetcare-demo-api"> tag that
# resolveDemoApi() in main.js reads first. The site is static (no runtime env), so this is
# the only configuration seam — the image is therefore environment-specific, which is why
# the deploy workflow passes the value explicitly per build.
#
# The empty-content meta in index.html is what gets replaced; the grep is a fail-fast guard so
# a drifted pattern breaks the build instead of silently shipping the empty tag. That matters:
# resolveDemoApi()'s last fallback is same-origin /api/demo/request, which on vetcare.bg (static
# nginx, no /api) is a 404 — a silent no-match here would ship a dead demo form.
ARG DEMO_API_URL="https://app.vetcare.bg/api/demo/request"
RUN if [ -n "$DEMO_API_URL" ]; then \
      sed -i "s|<meta name=\"vetcare-demo-api\" content=\"\">|<meta name=\"vetcare-demo-api\" content=\"${DEMO_API_URL}\">|" index.html && \
      grep -q "name=\"vetcare-demo-api\" content=\"${DEMO_API_URL}\"" index.html \
        || { echo "❌ Failed to inject DEMO_API_URL into index.html — meta tag pattern changed?"; exit 1; }; \
      echo "✅ demo API → ${DEMO_API_URL}"; \
    fi

# ─────────────────────────────────────────────────────────────
# Stage 2 — serve the built site with nginx
# ─────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS final

# our static-serving config (gzip + cache headers); front nginx stays the TLS/vhost layer
COPY nginx.conf /etc/nginx/conf.d/default.conf

# only the files the live page needs — no node_modules, scripts, package files or docs
WORKDIR /usr/share/nginx/html
COPY --from=build /app/index.html /app/privacy.html ./
COPY --from=build /app/assets ./assets
COPY --from=build /app/favicon.ico /app/favicon.svg /app/favicon-32.png /app/apple-touch-icon.png ./
COPY --from=build /app/robots.txt /app/sitemap.xml ./

EXPOSE 80
