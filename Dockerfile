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

RUN BUILD_ID=$(date +%s) && \
    sed -i "s/main.min.js/main.min.js?v=${BUILD_ID}/g" index.html && \
    sed -i "s/styles.min.css/styles.min.css?v=${BUILD_ID}/g" index.html

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
COPY --from=build /app/manifest.webmanifest /app/robots.txt /app/sitemap.xml ./

EXPOSE 80
