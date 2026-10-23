# Image für den Poker-Server (server.js + index.html + Karten-SVGs).
# Node 22 (LTS); der Code braucht mindestens Node 18 (globales fetch).
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Abhängigkeiten zuerst (besseres Layer-Caching). Einzige Abhängigkeit: ws,
# Version fest über package-lock.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Nur die Dateien, die der Server zur Laufzeit braucht.
COPY server.js index.html ./
COPY cards ./cards

# data/   -> Ledger (ledger.json) und hochgeladene Medien (data/md/), wird als Volume eingebunden
# sounds/ -> beim Start geladene Sound-Dateien, wird als Volume eingebunden
RUN mkdir -p data sounds && chown -R node:node /app
USER node

# Der Server lauscht auf PORT (Standard im Code: 3000).
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000),r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
