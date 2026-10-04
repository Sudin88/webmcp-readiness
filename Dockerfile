# Chromium needs its own user and a larger /dev/shm; the Playwright base image
# provides both. The renderer sandbox stays ON - it executes anonymous pages.
#
# SANDBOX PREREQUISITE, verified broken in this image on a host with
# kernel.apparmor_restrict_unprivileged_userns=1: Chromium fails to start with
# "No usable sandbox!" and every scan returns 500. Fix by matching the base image
# to the host kernel, or by shipping the AppArmor profile Chromium needs and
# granting CAP_SYS_ADMIN. See server/DEPLOY.md blocker 2.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# Chromium's setuid sandbox needs its helper to be SUID root. The Playwright base
# image ships chrome_sandbox mode 777, so `chromiumSandbox: true` cannot initialise
# and every launch dies with "Target page, context or browser has been closed".
# This must run as root, i.e. before the USER directive below.
RUN set -eux; \
    helper="$(find /ms-playwright -name chrome_sandbox -type f | head -1)"; \
    test -n "$helper"; \
    chown root:root "$helper"; \
    chmod 4755 "$helper"; \
    test "$(stat -c '%a' "$helper")" = "4755"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund

COPY lib ./lib
COPY server ./server
COPY web ./web
COPY vendor ./vendor

ENV NODE_ENV=production \
    PORT=9000

USER pwuser
EXPOSE 9000

# /healthz never launches Chromium, so it reported healthy on an image where every
# scan 500'd. This check must actually start the browser, which is the component
# most likely to break from a base-image or host change. Browser checks go to a
# marker file so the healthcheck itself stays a cheap HTTP call.
HEALTHCHECK --interval=60s --timeout=40s --start-period=45s --retries=3 \
  CMD node server/healthcheck.mjs

CMD ["node", "server/index.mjs"]