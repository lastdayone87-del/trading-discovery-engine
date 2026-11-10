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
# Phase 2 Option C: persist the append-only acquisition lane baseline so
# crawls/hour, gate wait, and the discovery share are measurable. The writer
# is observational only and can never change an acquisition result.
# The rendered-admission governor enforces the single-slot budget: 40/h
# nominal, 48/h emergency when queued demand exists, and a 35% DISCOVERY floor
# whenever discovery work is waiting. Local/CI harnesses default it off.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    COMMUNITY_RETRY_WORKER_CONCURRENCY=3 \
    ACQUISITION_LANE_TELEMETRY_ENABLED=true \
    RENDERED_ADMISSION_GOVERNOR_ENABLED=true \
    RENDERED_ADMISSION_NOMINAL_PER_HOUR=40 \
    RENDERED_ADMISSION_EMERGENCY_PER_HOUR=48 \
    RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT=35 \
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
