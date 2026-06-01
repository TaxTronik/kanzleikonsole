// =============================================================================
// Worker-Eintritt
//
// Startet alle BullMQ-Worker und registriert die täglichen Schedules.
// Sauberes SIGTERM-Handling für Graceful Shutdown.
// =============================================================================

import { writeFileSync } from 'node:fs';
import { virusScanWorker } from './jobs/virus-scan';
import { evidenceSealWorker } from './jobs/evidence-seal';
import { gwgExpiryWorker } from './jobs/gwg-expiry-check';
import { invoiceOverdueWorker } from './jobs/invoice-overdue-check';
import { auditVerifyWorker } from './jobs/audit-verify-check';
import { taxDeadlineMaterializeWorker } from './jobs/tax-deadline-materialize';
import { auditRotateWorker } from './jobs/audit-rotate';
import { taxNewsFetchWorker } from './jobs/tax-news-fetch';
import { remindersDailyWorker } from './jobs/reminders-daily';
import { n8nDeliverWorker, n8nOutboxReconcileWorker } from './jobs/n8n-deliver';
import { magicLinkCleanupWorker } from './jobs/magic-link-cleanup';
import { dsgvoRetentionWorker } from './jobs/dsgvo-retention';
import { poaExpiryWorker } from './jobs/poa-expiry-check';
import { riskAnalyseLlmWorker } from './jobs/risk-analyse-llm';
import { setupSchedules } from './scheduler';
import { connection } from './queues';
import { log } from './logger';

// Q-9: Heartbeat-File für Docker-HEALTHCHECK. Worker schreibt alle 30 s einen
// Touch nach /tmp/worker-alive; das Dockerfile prüft per stat-mtime, dass die
// Datei nicht älter als 90 s ist. Erkennt Deadlock / Redis-Disconnect, ohne
// einen HTTP-Port zu öffnen (kleinere Angriffsfläche). /tmp ist im Worker-
// Container ein tmpfs (siehe docker-compose.app.yml + read_only: true).
const HEARTBEAT_PATH = '/tmp/worker-alive';
const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

function startHeartbeat(): void {
  const touch = () => {
    try {
      writeFileSync(HEARTBEAT_PATH, String(Date.now()), { mode: 0o600 });
    } catch (err) {
      // Heartbeat-Failures nicht fatal — nur loggen. Wenn das fehlschlägt,
      // wird die HEALTHCHECK sowieso bald failen und Docker restartet.
      log.warn({ err: (err as Error).message }, 'worker: heartbeat write failed');
    }
  };
  touch();
  heartbeatTimer = setInterval(touch, HEARTBEAT_INTERVAL_MS);
  // unref → Heartbeat-Timer hält den Event-Loop nicht offen
  heartbeatTimer.unref();
}

async function main() {
  log.info('worker: starting');
  startHeartbeat();
  await setupSchedules();
  log.info(
    {
      workers: [
        'virus-scan',
        'evidence-seal',
        'gwg-expiry-check',
        'invoice-overdue-check',
        'audit-verify-check',
        'tax-deadline-materialize',
        'audit-rotate',
        'tax-news-fetch',
        'reminders-daily',
        'n8n-deliver',
        'n8n-outbox-reconcile',
        'magic-link-cleanup',
        'dsgvo-retention',
        'poa-expiry-check',
        'risk-analyse-llm',
      ],
    },
    'worker: ready',
  );
}

async function shutdown(reason: string) {
  log.warn({ reason }, 'worker: shutting down');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try {
    await Promise.all([
      virusScanWorker.close(),
      evidenceSealWorker.close(),
      gwgExpiryWorker.close(),
      invoiceOverdueWorker.close(),
      auditVerifyWorker.close(),
      taxDeadlineMaterializeWorker.close(),
      auditRotateWorker.close(),
      taxNewsFetchWorker.close(),
      remindersDailyWorker.close(),
      n8nDeliverWorker.close(),
      n8nOutboxReconcileWorker.close(),
      magicLinkCleanupWorker.close(),
      dsgvoRetentionWorker.close(),
      poaExpiryWorker.close(),
      riskAnalyseLlmWorker.close(),
    ]);
    await connection.quit();
    log.info('worker: shutdown complete');
    process.exit(0);
  } catch (e) {
    log.error({ err: (e as Error).message }, 'worker: shutdown error');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// L-6: Nach uncaughtException/unhandledRejection ist der In-Memory-Zustand
// potenziell korrupt (z. B. nach Crypto-Fail in decryptSecret, halb-committeter
// Transaction etc.). Node 18+ würde per Default crashen — wir loggen strukturiert
// und beenden danach kontrolliert. Docker-Restart-Policy bringt den Worker
// frisch hoch. process.exit ohne Cleanup, weil shutdown() blockieren könnte
// (BullMQ-Worker hängt eventuell genau auf dem korrupten State).
process.on('uncaughtException', (err) => {
  log.error({ err: err.message, stack: err.stack }, 'worker: uncaught exception — exiting');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  log.error({ err: msg, stack }, 'worker: unhandled rejection — exiting');
  process.exit(1);
});

main().catch((err) => {
  log.error({ err: (err as Error).message }, 'worker: failed to start');
  process.exit(1);
});
