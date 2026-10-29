# AI Collaboration Agent – webapplicatie
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    DATA_DIR=/data \
    SANDBOX_DIR=/sandbox-jobs \
    PORT=3000

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

# Datamappen eigendom van de onbevoegde gebruiker "node" (uid 1000); de rechten worden
# bij de eerste start naar een leeg Docker-volume gekopieerd.
RUN mkdir -p /data /sandbox-jobs \
 && chown node:node /data /sandbox-jobs \
 && chmod 700 /sandbox-jobs

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
