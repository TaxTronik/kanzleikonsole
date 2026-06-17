import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  ShieldCheck,
  Database,
  Package,
  Shield,
  Users,
  Building2,
  AlertTriangle,
  CheckCircle2,
  Circle,
  ArrowRight,
  Download,
} from 'lucide-react';
import { staffAuth } from '@/server/auth/staff';
import { isStaffAdmin } from '@/server/auth/rbac';
import { withTenantContext } from '@taxtronik/db';
import {
  BACKUP_DRILL_RESULT_SETTING_KEY,
  type PersistedDrillResult,
} from '@taxtronik/evidence';
import { evidenceService } from '@/server/container';
import { checkForUpdates, type CheckResult } from '@/server/update/manifest';
import { getLicenseInfo } from '@/server/license/state';
import { getSetupStatus } from '@/server/setup/status';
import { findDueGwgDeletionDocs } from '@/server/gwg/retention';
import { findDueClientAnonymizations } from '@/server/dsgvo/client-retention';
import { LicenseCard } from './license-card';
import { BackupRunButton } from './backup-run-button';
import { fmtDateTimeShort } from '@/lib/fmt';

const APP_VERSION = process.env['APP_VERSION'] ?? 'dev';

export default async function AdminPage() {
  const session = await staffAuth();
  if (!session?.user) redirect('/staff/login');
  if (!isStaffAdmin(session)) {
    redirect('/staff/dashboard');
  }

  const { tenantId, staffId } = session.user;

  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  const [chainResult, lastBackup, drillSetting, openDsgvoCount, providerCount, contactCount, gwgDueCount, anonDueCount] =
    await withTenantContext(
      ctx,
      async (tx) =>
        Promise.all([
          evidenceService.verifyChain(tx, tenantId).catch(() => null),
          tx.backupRecord.findFirst({
            orderBy: { startedAt: 'desc' },
          }),
          // Letztes Restore-Drill-Ergebnis (monatlicher Worker-Job — Art. 32
          // DSGVO Wirksamkeitsnachweis). Nur lesen, nie hier rechnen.
          tx.tenantSetting.findUnique({
            where: { tenantId_key: { tenantId, key: BACKUP_DRILL_RESULT_SETTING_KEY } },
          }),
          tx.dsgvoRequest.count({ where: { status: { in: ['RECEIVED', 'IN_PROGRESS'] } } }),
          tx.serviceProvider.count(),
          tx.clientContact.count({ where: { active: true } }),
          findDueGwgDeletionDocs(tx).then((d) => d.length),
          findDueClientAnonymizations(tx).then((d) => d.length),
        ]),
    );

  const drill = (drillSetting?.value ?? null) as PersistedDrillResult | null;

  const setup = await getSetupStatus(ctx);

  // Update-Check (best effort, blockt nicht)
  const updateCheck = await checkForUpdates(APP_VERSION).catch(
    (): CheckResult => ({ ok: false, error: 'Update-Server nicht erreichbar.' }),
  );

  const license = await getLicenseInfo();

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Administration</h1>
        <p className="text-muted text-sm">
          Compliance-Status, Backup, Updates, DSGVO, Lizenz.
        </p>
      </div>

      {/* Lizenz-Banner ganz oben — sichtbar auch ohne Scrollen */}
      <LicenseCard info={license} />

      {/* Setup-Checkliste — bleibt sichtbar bis komplett erledigt */}
      {!setup.allDone && (
        <div className="card p-5 mb-6 border-l-4 border-l-yellow-500 dark:border-l-yellow-400">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-primary">
              Erste Schritte zur Inbetriebnahme
            </h2>
            <span className="text-xs text-muted">
              {setup.doneCount} / {setup.totalCount} erledigt
            </span>
          </div>
          <div className="mb-3 h-1.5 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full bg-yellow-500 dark:bg-yellow-400 transition-all"
              style={{ width: `${(setup.doneCount / setup.totalCount) * 100}%` }}
            />
          </div>
          <ul className="space-y-1.5">
            {setup.items.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  className="flex items-start gap-2 px-2 py-1.5 -mx-2 rounded hover:bg-gray-50 group"
                >
                  {item.done ? (
                    <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-600 shrink-0" />
                  ) : (
                    <Circle className="h-4 w-4 mt-0.5 text-disabled dark:text-secondary shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          item.done
                            ? 'text-sm text-muted line-through'
                            : 'text-sm font-medium text-primary'
                        }
                      >
                        {item.label}
                      </span>
                      {!item.done && <ArrowRight className="h-3.5 w-3.5 text-disabled group-hover:text-muted" />}
                    </div>
                    {!item.done && item.hint && (
                      <p className="text-xs text-muted">{item.hint}</p>
                    )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        {/* Audit-Chain */}
        <div className="card p-6">
          <div className="flex items-start gap-3 mb-3">
            <ShieldCheck className={chainResult?.ok ? 'h-5 w-5 text-green-600' : 'h-5 w-5 text-red-600'} />
            <div className="flex-1">
              <h2 className="text-sm font-medium text-primary">Audit-Hash-Chain</h2>
              {chainResult ? (
                chainResult.ok ? (
                  <>
                    <p className="text-xs text-green-700 mt-1">
                      Intakt — {chainResult.checked} Einträge geprüft
                    </p>
                    <p className="text-xs text-muted mt-1">
                      {chainResult.sealsChecked} Tagesversiegelungen geprüft
                      {chainResult.sealBreaks.length > 0 ? `, ${chainResult.sealBreaks.length} mit TSA-Problem` : ''}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-red-700 mt-1">⚠ Hash-Chain gebrochen!</p>
                    {chainResult.firstBreak && (
                      <p className="text-xs text-muted mt-1">
                        Bei Audit-ID {String(chainResult.firstBreak.auditId)}
                      </p>
                    )}
                  </>
                )
              ) : (
                <p className="text-xs text-muted mt-1">Verifikation fehlgeschlagen.</p>
              )}
            </div>
          </div>
          <p className="text-xs text-disabled">
            CLI: <code className="text-secondary">pnpm verify:chain</code>
          </p>
        </div>

        {/* Backup */}
        <div className="card p-6">
          <div className="flex items-start gap-3 mb-3">
            <Database
              className={
                lastBackup?.status === 'SUCCESS'
                  ? 'h-5 w-5 text-green-600'
                  : lastBackup?.status === 'FAILED'
                  ? 'h-5 w-5 text-red-600'
                  : 'h-5 w-5 text-disabled'
              }
            />
            <div className="flex-1">
              <h2 className="text-sm font-medium text-primary">Letztes Backup</h2>
              {lastBackup ? (
                <>
                  <p className="text-xs text-secondary mt-1">
                    {fmtDateTimeShort(lastBackup.startedAt,)}{' '}
                    — {lastBackup.status}
                  </p>
                  {lastBackup.sizeBytes && (
                    <p className="text-xs text-muted mt-1">
                      {fmtBytes(Number(lastBackup.sizeBytes))} → {lastBackup.bucket}
                    </p>
                  )}
                  {lastBackup.errorMsg && (
                    <p className="text-xs text-red-700 mt-1 truncate">{lastBackup.errorMsg}</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-yellow-700 mt-1 flex items-center gap-1">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Noch nie gesichert
                </p>
              )}
              {/* Restore-Drill: beweisbarer Wiederherstellungstest (monatlich) */}
              {drill ? (
                drill.ok ? (
                  <p className="text-xs text-green-700 mt-1">
                    Restore-Test {fmtDateTimeShort(new Date(drill.checkedAt))}: erfolgreich
                    {drill.auditChecked > 0 ? ` (${drill.auditChecked} Audit-Einträge verifiziert)` : ''}
                  </p>
                ) : (
                  <p className="text-xs text-red-700 mt-1">
                    ⚠ Restore-Test {fmtDateTimeShort(new Date(drill.checkedAt))} fehlgeschlagen
                    {drill.error ? ` — ${drill.error}` : ''}
                  </p>
                )
              ) : (
                <p className="text-xs text-muted mt-1">
                  Restore-Test: noch kein Lauf (monatlich am 1., 05:00 UTC)
                </p>
              )}
              <div className="mt-3 flex flex-wrap items-start gap-2">
                <BackupRunButton />
                {lastBackup?.status === 'SUCCESS' && lastBackup.key && (
                  <Link
                    href={`/api/staff/admin/backups/${lastBackup.id}/download`}
                    className="btn-secondary text-xs py-1.5 inline-flex items-center gap-1.5"
                  >
                    <Download className="h-3.5 w-3.5" />
                    Backup herunterladen
                  </Link>
                )}
              </div>
            </div>
          </div>
          <p className="text-xs text-disabled">
            CLI: <code className="text-secondary">pnpm --filter @taxtronik/web backup:run</code>
          </p>
          <p className="text-xs text-disabled mt-1">
            Lokale Kopie: <code className="text-secondary">backups/</code>
          </p>
        </div>

        {/* Updates */}
        <div className="card p-6">
          <div className="flex items-start gap-3 mb-3">
            <Package
              className={
                updateCheck.ok && 'hasUpdate' in updateCheck && updateCheck.hasUpdate
                  ? 'h-5 w-5 text-yellow-600'
                  : 'h-5 w-5 text-green-600'
              }
            />
            <div className="flex-1">
              <h2 className="text-sm font-medium text-primary">Versionen / Updates</h2>
              <p className="text-xs text-secondary mt-1">
                Installiert: <strong>{APP_VERSION}</strong>
              </p>
              {updateCheck.ok ? (
                'hasUpdate' in updateCheck && updateCheck.hasUpdate ? (
                  <p className="text-xs text-yellow-700 mt-1">
                    {updateCheck.newer?.length} neuere Version{updateCheck.newer && updateCheck.newer.length === 1 ? '' : 'en'} verfügbar
                  </p>
                ) : (
                  <p className="text-xs text-green-700 mt-1">Aktuell auf dem neuesten Stand.</p>
                )
              ) : (
                <p className="text-xs text-muted mt-1">
                  {updateCheck.warning ?? updateCheck.error ?? 'Update-Server nicht konfiguriert.'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* DSGVO */}
        <div className="card p-6">
          <div className="flex items-start gap-3 mb-3">
            <Shield className={openDsgvoCount > 0 ? 'h-5 w-5 text-yellow-600' : 'h-5 w-5 text-green-600'} />
            <div className="flex-1">
              <h2 className="text-sm font-medium text-primary">Offene DSGVO-Anfragen</h2>
              <p className="text-xs text-secondary mt-1">{openDsgvoCount} Anfragen in Bearbeitung</p>
              <Link
                href="/staff/admin/dsgvo"
                className="inline-block mt-2 text-xs text-brand-700 hover:underline"
              >
                Anfragen verwalten →
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Sekundäre KPIs */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <SmallKpi icon={Users} label="Aktive Portal-Kontakte" value={contactCount} />
        <SmallKpi icon={Building2} label="Dienstleister erfasst" value={providerCount} />
        <SmallKpi
          icon={CheckCircle2}
          label="Audit-Einträge"
          value={chainResult?.checked ?? 0}
          subtitle="hash-versiegelt"
        />
      </div>

      <div className="card p-6">
        <h2 className="text-sm font-medium text-primary mb-3">Quick-Links</h2>
        <ul className="space-y-2 text-sm">
          <li>
            <Link href="/staff/admin/settings" className="text-brand-700 hover:underline">
              → Einstellungen (Erscheinungsbild, Module, E-Mail, Integrationen)
            </Link>
          </li>
          <li>
            <Link href="/staff/admin/dsgvo" className="text-brand-700 hover:underline">
              → DSGVO-Anfragen
            </Link>
          </li>
          <li>
            {/* Route-Handler-Download (kein <Link> — kein Client-Side-Routing) */}
            <a href="/api/staff/admin/verfahrensdoku" className="text-brand-700 hover:underline">
              → Verfahrensdokumentation (GoBD) aus dem IST-Zustand erzeugen
            </a>
          </li>
          <li>
            <Link href="/staff/admin/gwg-retention" className="text-brand-700 hover:underline">
              → GwG-Pflichtlöschung (§ 8 Abs. 4)
            </Link>
            {gwgDueCount > 0 && (
              <span className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                {gwgDueCount} löschreif
              </span>
            )}
          </li>
          <li>
            <Link href="/staff/admin/dsgvo-retention" className="text-brand-700 hover:underline">
              → DSGVO-Anonymisierung Mandanten (Art. 17)
            </Link>
            {anonDueCount > 0 && (
              <span className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                {anonDueCount} fällig
              </span>
            )}
          </li>
          <li>
            <Link href="/staff/service-providers" className="text-brand-700 hover:underline">
              → Dienstleisterverzeichnis (DSGVO Art. 28 / GwG § 11)
            </Link>
          </li>
          <li>
            <Link href="/staff/poa" className="text-brand-700 hover:underline">
              → Vollmachten (eIDAS AES)
            </Link>
          </li>
          <li>
            <Link href="/staff/admin/custom-fields" className="text-brand-700 hover:underline">
              → Mandanten-Custom-Felder
            </Link>
          </li>
          <li>
            <Link href="/staff/admin/document-types" className="text-brand-700 hover:underline">
              → Datei-Typen &amp; Schutzstufen
            </Link>
          </li>
          <li>
            <Link href="/staff/admin/state-machines" className="text-brand-700 hover:underline">
              → Status-Maschinen
            </Link>
          </li>
          <li>
            <Link href="/staff/admin/request-templates" className="text-brand-700 hover:underline">
              → Anforderungs-Vorlagen
            </Link>
          </li>
          <li>
            <Link href="/staff/admin/email-templates" className="text-brand-700 hover:underline">
              → E-Mail-Vorlagen
            </Link>
          </li>
        </ul>
      </div>
    </div>
  );
}

function SmallKpi({
  icon: Icon,
  label,
  value,
  subtitle,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  subtitle?: string;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="h-4 w-4 text-disabled" />
        <p className="text-xs font-medium text-muted uppercase tracking-wide">{label}</p>
      </div>
      <p className="text-2xl font-bold text-primary">{value}</p>
      {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
    </div>
  );
}

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
