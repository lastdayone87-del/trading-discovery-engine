FROM mcr.microsoft.com/playwright:v1.62.1-noble

# Community acquisition retry consumer loops: COMMUNITY_RETRY_WORKER_CONCURRENCY
# scales startCommunityRetryWorker only (default 1, cap 5); all other
# maintenance families (official recheck, country-boundary recovery,
# false-negative recovery, corpus pipeline) always run exactly one loop each.
# Set to 3 per measured capacity audit (Oct 2026): serial throughput
# ~9.7 attempts/h vs ~11.5/h arrivals; 3 loops ≈ 1.45x effective service
# within observed CPU/RAM headroom without touching the browser-lease,
# retry policy, or queue ordering. Takes effect on next deploy only.
# Search worker concurrency: SEARCH_WORKER_CONCURRENCY scales the
# SEARCH_YOUTUBE pool in startSearchWorkers (default 4 per measured
# capacity work, Oct 2026; production database holds no override for this
# knob because it is env-only). Takes effect on next deploy only. An
# explicit runtime value still overrides this baked default.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    COMMUNITY_RETRY_WORKER_CONCURRENCY=3 \
    SEARCH_WORKER_CONCURRENCY=4

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
