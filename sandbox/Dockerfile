# Geïsoleerde testomgeving voor gegenereerde code (zie compose.yaml voor de beperkingen:
# geen netwerk, read-only, resource-limieten, minimale capabilities).
FROM node:24-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pytest \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin runner \
 && mkdir -p /sandbox-jobs \
 && chown 1000:1000 /sandbox-jobs \
 && chmod 700 /sandbox-jobs

COPY sandbox/worker.mjs /sandbox/worker.mjs

ENV SANDBOX_DIR=/sandbox-jobs \
    SANDBOX_RUNNER_UID=10001 \
    SANDBOX_RUNNER_GID=10001 \
    SANDBOX_WORK_DIR=/tmp \
    SANDBOX_TASK_TIMEOUT_SEC=60

# De worker draait als root (alleen met de capabilities uit compose.yaml) zodat hij
# de te testen code als de onbevoegde gebruiker "runner" (uid 10001) kan starten.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const h=JSON.parse(require('fs').readFileSync('/sandbox-jobs/heartbeat.json','utf8'));process.exit(Date.now()-Date.parse(h.time)<30000?0:1)"
CMD ["node", "/sandbox/worker.mjs"]
