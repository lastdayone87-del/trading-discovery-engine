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
# SEARCH_YOUTUBE pool in startSearchWorkers. The production safety baseline
# is 2 (discovery remains paused; do not let search outrun admission).
# Takes effect on next deploy only. An explicit runtime value still overrides
# this baked default.
# Phase 2 Option C: persist the append-only acquisition lane baseline so
# crawls/hour, gate wait, and the discovery share are measurable. The writer
# is observational only and can never change an acquisition result.
# The rendered-admission governor enforces the admission budget: 64/h
# nominal, 72/h emergency when queued demand exists, and a 35% DISCOVERY
# floor that binds while discovery demand is pending. Local/CI harnesses
# default it off. These defaults come from the Nov 2026 capacity
# experiment (docs/phase-2-rendered-capacity-experiment.md): the browser
# lease runs TWO Chromium slots under a memory-headroom guard, the
# rendered-crawl gate derives its concurrency from the same slot budget,
# and the sustained one-at-a-time rate measured ~41 crawls/hour — 64/72
# admits the burst capacity the two slots provide while the experiment
# doc tracks the two-slot sustained rate as pending post-merge
# measurement.
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_GC=1 \
    COMMUNITY_RETRY_WORKER_CONCURRENCY=3 \
    ACQUISITION_LANE_TELEMETRY_ENABLED=true \
    BROWSER_RUNTIME_CONCURRENCY=2 \
    RENDERED_ADMISSION_GOVERNOR_ENABLED=true \
    RENDERED_ADMISSION_NOMINAL_PER_HOUR=64 \
    RENDERED_ADMISSION_EMERGENCY_PER_HOUR=72 \
    RENDERED_ADMISSION_DISCOVERY_FLOOR_PCT=35 \
    RENDERED_FALLBACK_MAX_WAIT_MS=90000 \
    SEARCH_WORKER_CONCURRENCY=2 \
    CRAWLEE_MEMORY_MBYTES=3072 \
    NODE_OPTIONS=--max-old-space-size=3072

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
