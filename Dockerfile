FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_GC=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build
RUN chown -R pwuser:pwuser /app

USER pwuser

CMD ["sh", "-c", "npm run migrate && npm run start"]
