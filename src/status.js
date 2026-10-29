// Bepaling van de eindstatus. Een opdracht is alleen GESLAAGD als de AI-beoordeling
// positief is ÉN er daadwerkelijk uitgevoerde tests zijn die allemaal slaagden.
import { checks as checksRepo, events, issues as issuesRepo, files as filesRepo } from './db.js';
import { STATUS } from './checks.js';

export function computeFinalStatus(job) {
  const reasons = [];
  const generated = filesRepo.inCycle(job.id, job.cycle);
  const claudeAnswer = events.latestInCycle(job.id, 'antwoord_claude', job.cycle);
  if (!claudeAnswer) {
    reasons.push('Er is geen resultaat van Claude ontvangen; er is niets beoordeeld of getest.');
    return { status: STATUS.UNTESTED, reasons };
  }
  const rows = checksRepo.forCycle(job.id, job.cycle);
  const executed = rows.filter((c) => c.category === 'UITGEVOERDE_TEST');
  const statics = rows.filter((c) => c.category === 'STATISCH');
  const notRun = rows.filter((c) => c.category === 'NIET_UITGEVOERD');
  const review = events.latestInCycle(job.id, 'review_oordeel', job.cycle);
  const verdict = review?.meta?.verdict || null;
  const openIssues = issuesRepo.forCycle(job.id, job.cycle);

  const failedExec = executed.filter((c) => c.status === STATUS.FAIL);
  const failedStatic = statics.filter((c) => c.status === STATUS.FAIL);

  if (verdict) reasons.push(`AI-beoordeling door ${review.meta.reviewer || 'ChatGPT'}: ${verdict}${review.meta.manual ? ' (handmatig vastgesteld door gebruiker)' : ''}.`);
  else reasons.push('Er is geen AI-beoordeling van de laatste versie.');
  reasons.push(`Daadwerkelijk uitgevoerde tests: ${executed.length} (${executed.length - failedExec.length} geslaagd, ${failedExec.length} mislukt).`);
  reasons.push(`Statische controles: ${statics.length} (${failedStatic.length} mislukt).`);
  if (notRun.length) reasons.push(`Niet uitgevoerde controles: ${notRun.length} (zie testoverzicht).`);
  if (!generated.length) reasons.push('In de laatste ronde zijn geen bestanden herkend.');

  if (failedExec.length || failedStatic.length) {
    return { status: verdict === 'GOEDGEKEURD' ? STATUS.PARTIAL : STATUS.FAIL, reasons };
  }
  if (verdict === 'AFGEKEURD') {
    const critical = openIssues.some((i) => i.severity === 'kritiek');
    reasons.push(critical ? 'Er staan nog kritieke problemen open.' : 'Er staan nog problemen open, geen daarvan kritiek.');
    return { status: critical ? STATUS.FAIL : STATUS.PARTIAL, reasons };
  }
  if (verdict === 'GOEDGEKEURD') {
    if (executed.length) return { status: STATUS.OK, reasons };
    reasons.push('Het resultaat is alleen door AI beoordeeld en/of statisch gecontroleerd; er is geen uitvoerbare test gedraaid. Controleer het resultaat zelf.');
    return { status: STATUS.MANUAL, reasons };
  }
  return { status: STATUS.UNTESTED, reasons };
}
