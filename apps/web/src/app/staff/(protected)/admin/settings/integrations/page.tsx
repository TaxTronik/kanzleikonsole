import { redirect } from 'next/navigation';
import {
  Database,
  HardDrive,
  Zap,
  ShieldCheck,
  Workflow,
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { env } from '@taxtronik/config';
import { getSmtpStatus } from '@/server/settings/smtp';
import {
  checkPostgres,
  checkRedis,
  checkObjectStore,
  checkClamAV,
  checkN8nForTenant,
  checkTsaForTenant,
  type ServiceStatus,
} from '@/server/health/checks';
import { SectionCard } from '../section-card';

interface Row {
  icon: typeof Database;
  label: string;
  endpoint: string;
  status: ServiceStatus | { skipped: true; reason: string };
  hint?: string;
}

function mask(value: string | undefined | null, keep = 4): string {
  if (!value) return '—';
  if (value.length <= keep) return value;
  return value.slice(0, keep) + '…' + value.slice(-2);
}

export default async function IntegrationsSettingsPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  const { tenantId, staffId } = session.user;

  const [pg, redis, objectStore, clamav, n8n, tsa, smtp] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkObjectStore(),
    checkClamAV(),
    checkN8nForTenant(tenantId),
    checkTsaForTenant(tenantId),
    getSmtpStatus({ tenantId, actorId: staffId, actorType: 'STAFF' }),
  ]);

  // S3-Endpoint hostname-only zur Anzeige
  const s3Host = (() => {
    try { return new URL(env.S3_ENDPOINT).host; } catch { return env.S3_ENDPOINT; }
  })();
  const redisHost = (() => {
    try {
      const u = new URL(env.REDIS_URL);
      return `${u.hostname}:${u.port || 6379}`;
    } catch { return env.REDIS_URL; }
  })();

  const rows: Row[] = [
    {
      icon: Database,
      label: 'PostgreSQL',
      endpoint: 'DB-Server (über DATABASE_URL)',
      status: pg,
      hint: 'Quelldatenbank, hash-versiegelter Audit-Log, RLS-Backstop.',
    },
    {
      icon: HardDrive,
      label: 'Object-Store (SeaweedFS)',
      endpoint: s3Host,
      status: objectStore,
      hint: 'S3-kompatibler Speicher mit Object-Lock COMPLIANCE für GoBD-Dokumente (10-Jahres-Aufbewahrung).',
    },
    {
      icon: Zap,
      label: 'Redis',
      endpoint: redisHost,
      status: redis,
      hint: 'BullMQ-Queue für Worker-Jobs (Scan, BWA, Versiegelung).',
    },
    {
      icon: ShieldCheck,
      label: 'ClamAV',
      endpoint: `${env.CLAMAV_HOST}:${env.CLAMAV_PORT}`,
      status: clamav,
      hint: 'Virenscan vor Object-Lock-Commit eines Uploads.',
    },
    {
      icon: Workflow,
      label: 'n8n',
      endpoint: n8n.url ?? '— nicht gesetzt —',
      status: n8n.source === 'none'
        ? { skipped: true, reason: 'Keine n8n-Webhook-URL — in den Einstellungen pflegen' }
        : (n8n as ServiceStatus),
      hint: n8n.source === 'tenant'
        ? 'Konfiguriert in den Einstellungen → n8n-Bridge.'
        : n8n.source === 'env'
          ? 'Aus ENV-Vorgabe — kann in den Einstellungen → n8n-Bridge überschrieben werden.'
          : 'Workflow-Engine für Reminder-Mails, Eskalationen, externe Webhooks.',
    },
    {
      icon: Clock,
      label: 'Zeitstempel-Behörde (TSA)',
      endpoint: tsa.url ?? '— lokaler Self-Timestamp —',
      status: tsa.source === 'none'
        ? { skipped: true, reason: 'Kein externer TSA gewählt — Self-Timestamp aktiv. In den Einstellungen auswählbar.' }
        : (tsa as ServiceStatus),
      hint: tsa.source === 'tenant'
        ? 'Konfiguriert in den Einstellungen → Zeitstempel (TSA). Versiegelt täglich den Tagesspitzen-Hash der Audit-Chain.'
        : tsa.source === 'env'
          ? 'Aus ENV-Vorgabe — kann in den Einstellungen → Zeitstempel pro Kanzlei überschrieben werden.'
          : 'RFC-3161 für die Audit-Hash-Chain. Für Produktivbetrieb wird ein externer Stempel (z. B. D-Trust) empfohlen.',
    },
  ];

  return (
    <div className="space-y-6">
      <SectionCard
        title="Integrationen"
        description="Status der externen Dienste. Diese Werte sind ENV-gepflegt (docker-compose.yml / .env) und können hier nur eingesehen werden."
      >
        <ul className="divide-y divide-border-subtle">
          {rows.map((r) => {
            const Icon = r.icon;
            const skipped = 'skipped' in r.status;
            const ok = !skipped && (r.status as ServiceStatus).ok;
            return (
              <li key={r.label} className="py-3 flex items-start gap-3">
                <Icon className={ok ? 'h-5 w-5 mt-0.5 text-emerald-600' : skipped ? 'h-5 w-5 mt-0.5 text-disabled' : 'h-5 w-5 mt-0.5 text-red-600'} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-primary">{r.label}</p>
                    {ok ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        Erreichbar
                        {(r.status as ServiceStatus).latencyMs != null && (
                          <span className="text-disabled ml-1">({(r.status as ServiceStatus).latencyMs} ms)</span>
                        )}
                      </span>
                    ) : skipped ? (
                      <span className="inline-flex items-center gap-1 text-xs text-disabled">
                        <Loader2 className="h-3.5 w-3.5" />
                        Nicht konfiguriert
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-red-700 dark:text-red-400">
                        <AlertCircle className="h-3.5 w-3.5" />
                        Fehler
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted font-mono mt-0.5 truncate">
                    {r.endpoint}
                  </p>
                  {r.hint && (
                    <p className="text-xs text-muted mt-0.5">{r.hint}</p>
                  )}
                  {!ok && !skipped && (r.status as ServiceStatus).error && (
                    <p className="text-xs text-red-700 dark:text-red-400 mt-0.5">
                      {(r.status as ServiceStatus).error}
                    </p>
                  )}
                  {skipped && (
                    <p className="text-xs text-muted mt-0.5">
                      {(r.status as { skipped: true; reason: string }).reason}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard
        title="Authentifizierung & Lizenz"
        description="Werte aus der Server-Umgebung, die das System beim Start liest."
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <KvRow label="NEXTAUTH_URL" value={env.NEXTAUTH_URL} mono />
          <KvRow label="AUTH_SECRET" value={mask(env.AUTH_SECRET)} mono />
          <KvRow label="LICENSE_KEY" value={env.LICENSE_KEY ? 'gesetzt' : '— nicht gesetzt —'} />
          <KvRow label="STAFF_COOKIE_DOMAIN" value={env.STAFF_COOKIE_DOMAIN ?? '— host-only —'} mono />
          <KvRow label="PORTAL_COOKIE_DOMAIN" value={env.PORTAL_COOKIE_DOMAIN ?? '— host-only —'} mono />
          <KvRow label="SMTP-Quelle" value={smtp.fromDb ? 'Kanzlei-Konfiguration (UI)' : 'ENV-Vorgabe'} />
        </dl>
      </SectionCard>
    </div>
  );
}

function KvRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className={mono ? 'font-mono text-xs text-primary break-all' : 'text-primary'}>
        {value}
      </dd>
    </>
  );
}

// Erfordert ein Server-Side-Render bei jedem Request, damit die Statuswerte
// nicht zwischengespeichert werden.
export const dynamic = 'force-dynamic';
