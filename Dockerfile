# Chromium needs its own user and a larger /dev/shm; the Playwright base image
# provides both. Sandbox stays ON - the renderer executes anonymous pages.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund

COPY lib ./lib
COPY server ./server
COPY web ./web

ENV NODE_ENV=production \
    PORT=8080

USER pwuser
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
