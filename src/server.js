import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { openDb } from './db.js';
import { getSettings } from './settings.js';
import { configureLog, log } from './log.js';
import { ensureAdmin, loadSession, secretFromDisk } from './auth.js';
import { recoverInterrupted, startPoller } from './workflow.js';
import routes from './routes.js';
import { errorPage } from './views.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  });
  app.use('/static', express.static(path.join(here, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '20mb', parameterLimit: 100 }));
  app.use(loadSession);
  app.use(routes);
  app.use((req, res) => res.status(404).type('html').send(errorPage(req, 404, 'Pagina niet gevonden.')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) log.error('onverwachte fout', { path: req.path, error: err.message });
    res.status(status).type('html').send(errorPage(req, status, status >= 500 ? 'Interne fout; zie de logs.' : err.message));
  });
  return app;
}

export function init() {
  secretFromDisk();
  // Wachtrijmap van de sandbox: alleen leesbaar voor de app-gebruiker (en de worker),
  // niet voor de onbevoegde gebruiker waaronder geteste code draait.
  fs.mkdirSync(path.join(config.sandboxDir, 'queue'), { recursive: true });
  try { fs.chmodSync(config.sandboxDir, 0o700); } catch { /* niet ondersteund (Windows) */ }
  openDb();
  const s = getSettings();
  configureLog({ logLevel: s.log_level, logToFile: s.log_to_file, dataDir: config.dataDir });
  ensureAdmin();
  recoverInterrupted();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  init();
  startPoller();
  const app = createApp();
  app.listen(config.port, config.host, () => {
    log.info(`AI Collaboration Agent luistert op http://${config.host}:${config.port} (omgeving: ${config.appEnv})`);
  });
}
