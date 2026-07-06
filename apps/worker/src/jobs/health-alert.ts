// =============================================================================
// health-alert-Worker — Betriebs-Alarm per E-Mail, wenn Infrastruktur ausfällt.
//
// Alle 5 Minuten: Postgres, Redis, Object-Store und ClamAV prüfen. Fällt ein
// Dienst in ZWEI aufeinanderfolgenden Läufen aus (~10 min, Flatter-Schutz),
// geht EINE Mail an OPS_ALERT_EMAIL; bei Erholung eine Entwarnung. Kein
// Mail-Sturm: alarmiert wird nur der Zustands-ÜBERGANG (State in Redis).
//
// Bewusst E-Mail statt In-App-Notification: wenn die App down ist, sieht
// niemand In-App-Hinweise. OPS_ALERT_EMAIL leer → Job ist ein No-Op.
//
// Systemgrenzen (dokumentiert, kein Bug):
//   - Fällt REDIS aus, läuft auch dieser Job nicht (BullMQ braucht Redis).
//     Der Redis-Check hier fängt den Fall „erreichbar, aber degradiert".
//   - Fällt der WORKER selbst aus, kann er sich nicht selbst alarmieren.
//     WICHTIG: Plain-Docker/Compose restartet einen `unhealthy` Container NICHT
//     automatisch (restart-Policy reagiert nur auf Prozess-EXIT). Für den
//     Neustart bei failing HEALTHCHECK braucht es einen externen Mechanismus
//     (autoheal-Sidecar oder Host-systemd-Timer) UND einen externen Uptime-
//     Check auf GET /api/health — siehe docs/operations/day-2-operations.md.
// =============================================================================

import { Socket } from 'node:net';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { Worker } from 'bullmq';
import { env } from '@taxtronik/config';
import { connection, type ChecksJob } from '../queues';
import { prismaOwner } from '../prisma-owner';
import { sendOpsMail } from '../mailer';
import { log } from '../logger';

export type ServiceName =
  | 'postgres' | 'redis' | 'objectStore' | 'clamav' | 'backup' | 'app' | 'n8n';

const SERVICE_LABEL: Record<ServiceName, string> = {
  postgres: 'Postgres (Datenbank)',
  redis: 'Redis (Queues/Sessions)',
  objectStore: 'Object-Store (SeaweedFS/S3)',
  clamav: 'ClamAV (Virenscanner)',
  backup: 'Backup (letzte Sicherung veraltet)',
  app: 'Web-App (Next.js)',
  n8n: 'n8n (Automations/Outbox)',
};

/** Max. Alter der letzten erfolgreichen Sicherung, bevor Alarm ausgelöst wird. */
export const BACKUP_MAX_AGE_MS = 26 * 60 * 60 * 1000;

export interface ServiceState {
  /** Aufeinanderfolgende Fehlläufe. */
  failures: number;
  /** Down-Alarm wurde verschickt und ist noch nicht entwarnt. */
  alerted: boolean;
}
export type HealthState = Partial<Record<ServiceName, ServiceState>>;

/** Zwei Läufe à 5 min → Alarm frühestens nach ~10 min Dauerausfall. */
export const FAIL_THRESHOLD = 2;

const STATE_KEY = 'taxtronik:health-alert:state';
const CHECK_TIMEOUT_MS = 5_000;

/**
 * Pure Übergangs-Logik (exportiert für den Unit-Test): zählt Fehlläufe,
 * meldet `down` beim Erreichen der Schwelle genau EINMAL und `up` genau
 * einmal bei Erholung nach einem Alarm.
 */
export function evaluateTransitions(
  prev: HealthState,
  current: Record<ServiceName, boolean>,
): { next: HealthState; alerts: Array<{ service: ServiceName; kind: 'down' | 'up' }> } {
  const next: HealthState = {};
  const alerts: Array<{ service: ServiceName; kind: 'down' | 'up' }> = [];
  for (const service of Object.keys(current) as ServiceName[]) {
    const p = prev[service] ?? { failures: 0, alerted: false };
    if (current[service]) {
      if (p.alerted) alerts.push({ service, kind: 'up' });
      next[service] = { failures: 0, alerted: false };
    } else {
      const failures = p.failures + 1;
      const shouldAlert = !p.alerted && failures >= FAIL_THRESHOLD;
      if (shouldAlert) alerts.push({ service, kind: 'down' });
      next[service] = { failures, alerted: p.alerted || shouldAlert };
    }
  }
  return { next, alerts };
}

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}: Timeout nach ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
  forcePathStyle: true,
});

async function checkPostgres(): Promise<boolean> {
  try {
    await withTimeout(prismaOwner.$queryRawUnsafe('SELECT 1'), 'postgres');
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    return (await withTimeout(connection.ping(), 'redis')) === 'PONG';
  } catch {
    return false;
  }
}

async function checkObjectStore(): Promise<boolean> {
  try {
    await withTimeout(s3.send(new ListBucketsCommand({})), 's3');
    return true;
  } catch {
    return false;
  }
}

/** HTTP-GET-Healthcheck (2xx = up). Für App- und n8n-Erreichbarkeit im
 *  internen Netz — deckt Crashloop/Hänger ab, die der Prozess-Restart nicht
 *  erkennt (der Prozess lebt, antwortet aber nicht). */
async function checkHttp(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
      return res.status >= 200 && res.status < 400;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return false;
  }
}

/** App-Healthcheck über das interne Netz (erkennt Crashloop trotz Restart).
 *  Service-Name `app` aus docker-compose.app.yml, Port 3000 (kein Host-Port). */
function checkApp(): Promise<boolean> {
  return checkHttp('http://app:3000/api/health');
}

/** n8n-Healthcheck (Outbox staut sich sonst still). */
function checkN8n(): Promise<boolean> {
  return checkHttp('http://n8n:5678/healthz');
}

/** zPING → PONG auf dem clamd-Socket (wie der App-Healthcheck). */
function checkClamAV(): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let answered = false;
    const done = (ok: boolean) => {
      if (!answered) {
        answered = true;
        sock.destroy();
        resolve(ok);
      }
    };
    sock.setTimeout(CHECK_TIMEOUT_MS, () => done(false));
    sock.on('error', () => done(false));
    sock.connect(env.CLAMAV_PORT, env.CLAMAV_HOST, () => {
      sock.write('zPING\0');
    });
    sock.on('data', (d) => done(d.toString('utf8').includes('PONG')));
  });
}

async function loadState(): Promise<HealthState> {
  try {
    const raw = await connection.get(STATE_KEY);
    return raw ? (JSON.parse(raw) as HealthState) : {};
  } catch {
    return {};
  }
}

async function saveState(state: HealthState): Promise<void> {
  // TTL 1 Tag: nach längerem Worker-Stillstand frisch starten statt mit
  // uraltem Zustand sofort zu entwarnen/alarmieren.
  await connection.set(STATE_KEY, JSON.stringify(state), 'EX', 24 * 60 * 60).catch(() => undefined);
}

function alertMail(service: ServiceName, kind: 'down' | 'up'): { subject: string; body: string } {
  const label = SERVICE_LABEL[service];
  const now = new Date().toISOString();
  if (kind === 'down') {
    return {
      subject: `[TaxTronik] ALARM: ${label} nicht erreichbar`,
      body:
        `${label} ist seit mindestens ${FAIL_THRESHOLD * 5} Minuten nicht erreichbar (Stand ${now}).\n\n` +
        `Nächste Schritte auf dem Server:\n` +
        `  ./dc ps\n` +
        `  ./dc logs ${service === 'objectStore' ? 'seaweedfs' : service} --tail 80\n\n` +
        `Diese Mail kommt vom TaxTronik-Worker (health-alert, alle 5 Minuten). ` +
        `Eine Entwarnung folgt automatisch, sobald der Dienst wieder antwortet.`,
    };
  }
  return {
    subject: `[TaxTronik] Entwarnung: ${label} wieder erreichbar`,
    body: `${label} antwortet wieder (Stand ${now}). Keine Aktion nötig.`,
  };
}

/**
 * Backup-Staleness: die letzte ERFOLGREICHE Sicherung darf nicht älter als
 * BACKUP_MAX_AGE_MS sein. Ohne diesen Check würde ein ausgefallener Backup-Lauf
 * (kein Scheduler / Host-Cron gestoppt) unbemerkt bleiben, während der
 * monatliche backup-drill nur die letzte — evtl. uralte — Sicherung validiert.
 */
async function checkBackupFresh(now: Date = new Date()): Promise<boolean> {
  const last = await prismaOwner.backupRecord.findFirst({
    where: { status: 'SUCCESS', finishedAt: { not: null } },
    orderBy: { finishedAt: 'desc' },
    select: { finishedAt: true },
  });
  if (!last?.finishedAt) return false; // noch nie erfolgreich gesichert → Alarm
  return now.getTime() - last.finishedAt.getTime() <= BACKUP_MAX_AGE_MS;
}

export async function runHealthAlert(): Promise<{ skipped?: boolean; down: ServiceName[] }> {
  if (!env.OPS_ALERT_EMAIL) return { skipped: true, down: [] };

  const [postgres, redis, objectStore, clamav, backup, app, n8n] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkObjectStore(),
    checkClamAV(),
    checkBackupFresh(),
    checkApp(),
    checkN8n(),
  ]);
  const current = { postgres, redis, objectStore, clamav, backup, app, n8n };

  const prev = await loadState();
  const { next, alerts } = evaluateTransitions(prev, current);
  await saveState(next);

  for (const a of alerts) {
    const { subject, body } = alertMail(a.service, a.kind);
    const sent = await sendOpsMail(subject, body);
    log.warn({ service: a.service, kind: a.kind, sent }, 'health-alert: transition');
  }

  const down = (Object.keys(current) as ServiceName[]).filter((s) => !current[s]);
  if (down.length > 0) log.warn({ down }, 'health-alert: services down');
  return { down };
}

export const healthAlertWorker = new Worker<ChecksJob>(
  'health-alert',
  async () => runHealthAlert(),
  { connection, concurrency: 1 },
);

healthAlertWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err: err.message }, 'health-alert: failed');
});
