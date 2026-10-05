// =============================================================================
// Worker-Eintritt
//
// Startet alle BullMQ-Worker und registriert die täglichen Schedules.
// Sauberes SIGTERM-Handling für Graceful Shutdown.
// =============================================================================

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupSchedules } from './scheduler';
import { connection } from './queues';
import { prismaOwner } from './prisma-owner';
import { log } from './logger';
// Eine Quelle für Ready-Log UND Shutdown: früher waren die Worker-Namen in
// drei Listen dupliziert (Ready-Log, Shutdown, queue-status im Web) und driften
// auseinander (backup-run fehlte zeitweise im Ready-Log). R-13: die Registry
// leitet sich aus JOB_QUEUES ab; `.name` ist der Queue-Name.
import { ALL_WORKERS } from './worker-registry';
import { trimReminderDoneJobHistory, trimRiskAnalyseJobHistory } from './job-retention';

// Q-9: Heartbeat-File für Docker-HEALTHCHECK. Worker schreibt alle 30 s ins
// plattformgerechte Temp-Verzeichnis; im Container bleibt das /tmp, lokal unter
// Windows dagegen %TEMP%. Erkennt Deadlock / Redis-Disconnect, ohne einen
// HTTP-Port zu öffnen (kleinere Angriffsfläche). /tmp ist im Worker-Container
// ein tmpfs (siehe docker-compose.app.yml + read_only: true).
const HEARTBEAT_PATH = join(tmpdir(), 'worker-alive');
const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: NodeJS.Timeout | null = null;

function startHeartbeat(): void {
  const touch = () => {
    // P3-4: Der Heartbeat darf nur „lebendig" melden, wenn auch die BullMQ-
    // Redis-Verbindung steht. Ein Worker mit dauerhaft getrennter Verbindung
    // verarbeitet nichts — würde er weiter touchen, bliebe er fälschlich
    // „healthy". `status === 'ready'` = verbunden und einsatzbereit.
    if (connection.status !== 'ready') {
      log.warn({ redisStatus: connection.status }, 'worker: heartbeat skipped — Redis nicht ready');
      return;
    }
    try {
      writeFileSync(HEARTBEAT_PATH, String(Date.now()), { mode: 0o600 });
    } catch (err) {
      // Heartbeat-Failures nicht fatal — nur loggen. Bleibt die Datei zu alt,
      // schlägt der HEALTHCHECK an (der Ops-Restart-Pfad ist extern, siehe
      // day-2-operations.md — Plain-Docker restartet unhealthy NICHT selbst).
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
  // S-06: nicht fatal — die Altersgrenzen greifen ohnehin bei jedem weiteren Job.
  await trimRiskAnalyseJobHistory().catch((err: unknown) =>
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'worker: risk-analyse-llm-Historie nicht bereinigt',
    ),
  );
  await trimReminderDoneJobHistory().catch((err: unknown) =>
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'worker: reminder-done-notify-Historie nicht bereinigt',
    ),
  );
  log.info({ workers: ALL_WORKERS.map((w) => w.name) }, 'worker: ready');
}

async function shutdown(reason: string) {
  log.warn({ reason }, 'worker: shutting down');
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  try {
    await Promise.all(ALL_WORKERS.map((w) => w.close()));
    // RF-13: auch den Prisma-Pool sauber schließen — vorher blieben offene
    // Postgres-Connections bis zum Prozess-Ende stehen.
    await prismaOwner.$disconnect();
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
