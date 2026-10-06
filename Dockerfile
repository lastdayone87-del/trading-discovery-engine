FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Community acquisition retry consumer loops: operationalMaintenanceWorkers
# reads OPERATIONAL_MAINTENANCE_WORKER_CONCURRENCY (default 1, cap 5).
# Set to 3 per measured capacity audit (Oct 2026): serial throughput
# ~9.7 attempts/h vs ~11.5/h arrivals; 3 loops ≈ 1.45x effective service
# within observed CPU/RAM headroom without touching the browser-lease,
# retry policy, or queue ordering. Takes effect on next deploy only.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    OPERATIONAL_MAINTENANCE_WORKER_CONCURRENCY=3

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build
RUN chown -R pwuser:pwuser /app

USER root
RUN apt-get update \
    && apt-get install --no-install-recommends -y tini \
    && rm -rf /var/lib/apt/lists/*

USER pwuser

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npm", "run", "start"]
