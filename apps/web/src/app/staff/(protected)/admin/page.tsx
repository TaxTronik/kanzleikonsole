import type { ComponentType, ReactNode } from 'react';
import type { BackupRecord } from '@prisma/client';

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
  UserX,
  Server,
  ScrollText,
  SlidersHorizontal,
  FileStack,
  Inbox,
  Mail,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  BACKUP_DRILL_RESULT_SETTING_KEY,
  type PersistedDrillResult,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';
import { checkForUpdates, type CheckResult } from '@/server/update/manifest';
import { getLicenseInfo } from '@/server/license/state';
import { getSetupStatus, type SetupStatus } from '@/server/setup/status';
import { findDueGwgDeletionDocs } from '@/server/gwg/retention';
import { findDueClientAnonymizations } from '@/server/dsgvo/client-retention';
import { LicenseCard } from './license-card';
import { BackupRunButton } from './backup-run-button';
import { CountUp } from '@/components/count-up';
import { fmtBytes, fmtDateTimeShort } from '@/lib/fmt';
import { dismissSetupChecklistAction, restoreSetupChecklistAction } from './setup-actions';

const APP_VERSION = process.env['APP_VERSION'] ?? 'dev';

interface StatusIssue {
  href: string;
  label: string;
}

interface QuickLink {
  href: string;
  icon: LucideIcon;
  label: string;
  desc: string;
  /** true = Route-Handler-Download, kein Client-Side-Routing (<a> statt <Link>). */
  external?: boolean;
  badge?: { count: number; label: string };
}

export default async function AdminPage() {
  const session = await requireStaffPage({ admin: true });

  const { tenantId, staffId } = session.user;

  const ctx = { tenantId, actorId: staffId, actorType: 'STAFF' as const };

  const [
    verifySetting,
    lastBackup,
    drillSetting,
    openDsgvoCount,
    providerCount,
    contactCount,
    gwgDueCount,
    anonDueCount,
    legacyStorageVersionCount,
  ] = await withTenantContext(ctx, async (tx) =>
    Promise.all([
      // P-1: Chain-Verifikation läuft NICHT im Render-Pfad (SHA-256 über den
      // ganzen Log; Sekunden bei 200k, P2028 ab ~500k). Nur das vom täglichen
      // Worker-Job (audit-verify-check) persistierte Ergebnis lesen — wie die
      // Audit-Seite (admin/audit/page.tsx).
      readTenantSettingValue(tx, tenantId, AUDIT_VERIFY_RESULT_SETTING_KEY),
      tx.backupRecord.findFirst({
        orderBy: { startedAt: 'desc' },
      }),
      // Letztes Restore-Drill-Ergebnis (monatlicher Worker-Job — Art. 32
      // DSGVO Wirksamkeitsnachweis). Nur lesen, nie hier rechnen.
      readTenantSettingValue(tx, tenantId, BACKUP_DRILL_RESULT_SETTING_KEY),
      tx.dsgvoRequest.count({ where: { status: { in: ['RECEIVED', 'IN_PROGRESS'] } } }),
      tx.serviceProvider.count(),
      tx.clientContact.count({ where: { active: true } }),
      findDueGwgDeletionDocs(tx).then((d) => d.length),
      findDueClientAnonymizations(tx).then((d) => d.length),
      tx.documentVersion.count({
        where: { immutable: true, storageVersionId: null },
      }),
    ]),
  );

  const drill = (drillSetting ?? null) as PersistedDrillResult | null;
  const verifyResult = (verifySetting ?? null) as PersistedVerifyResult | null;

  const setup = await getSetupStatus(ctx);

  // Update-Check (best effort, blockt nicht)
  const updateCheck = await checkForUpdates(APP_VERSION).catch(
    (): CheckResult => ({ ok: false, error: 'Update-Server nicht erreichbar.' }),
  );

  const license = await getLicenseInfo();

  // --- Systemstatus-Aggregation (nur Darstellung der bereits geladenen Daten) ---
  const issues: StatusIssue[] = [];
  if (verifyResult && !verifyResult.ok && !verifyResult.error && !verifyResult.recovered) {
    issues.push({ href: '#audit', label: 'Audit-Hash-Chain gebrochen' });
  }
  if (verifyResult?.recovered) {
    issues.push({ href: '#audit', label: 'Historischer Chain-Bruch (Recovery gesetzt)' });
  }
  if (verifyResult?.error) {
    issues.push({ href: '#audit', label: 'Audit-Verifikationslauf fehlgeschlagen' });
  }
  if (!lastBackup) {
    issues.push({ href: '#backup', label: 'Noch kein Backup erstellt' });
  } else if (lastBackup.status === 'FAILED') {
    issues.push({ href: '#backup', label: 'Letztes Backup fehlgeschlagen' });
  }
  if (drill && !drill.ok) {
    issues.push({ href: '#backup', label: 'Restore-Test fehlgeschlagen' });
  }
  if (updateCheck.ok && 'hasUpdate' in updateCheck && updateCheck.hasUpdate) {
    issues.push({
      href: '#updates',
      label: `${updateCheck.newer?.length ?? 1} neuere Version${(updateCheck.newer?.length ?? 0) === 1 ? '' : 'en'} verfügbar`,
    });
  }
  if (openDsgvoCount > 0) {
    issues.push({
      href: '#dsgvo',
      label: `${openDsgvoCount} offene DSGVO-Anfrage${openDsgvoCount === 1 ? '' : 'n'}`,
    });
  }
  if (gwgDueCount > 0) {
    issues.push({ href: '#quicklinks', label: `${gwgDueCount} GwG-Pflichtlöschung löschreif` });
  }
  if (anonDueCount > 0) {
    issues.push({ href: '#quicklinks', label: `${anonDueCount} DSGVO-Anonymisierung fällig` });
  }
  if (legacyStorageVersionCount > 0) {
    issues.push({ href: '#storage', label: 'Storage-Inventur erforderlich' });
  }

  const quickLinks: QuickLink[] = [
    {
      href: '/staff/admin/settings',
      icon: Settings,
      label: 'Einstellungen',
      desc: 'Erscheinungsbild, Module, E-Mail, Integrationen',
    },
    {
      href: '/staff/admin/dsgvo',
      icon: Shield,
      label: 'DSGVO-Anfragen',
      desc: 'Auskunft, Berichtigung, Löschung',
      badge: openDsgvoCount > 0 ? { count: openDsgvoCount, label: 'offen' } : undefined,
    },
    {
      href: '/api/staff/admin/verfahrensdoku',
      icon: Download,
      label: 'Verfahrensdokumentation',
      desc: 'GoBD-Doku aus dem IST-Zustand erzeugen',
      external: true,
    },
    {
      href: '/staff/admin/gwg-retention',
      icon: UserX,
      label: 'GwG-Pflichtlöschung',
      desc: 'Löschkonzept § 8 Abs. 4 GwG',
      badge: gwgDueCount > 0 ? { count: gwgDueCount, label: 'löschreif' } : undefined,
    },
    {
      href: '/staff/admin/dsgvo-retention',
      icon: UserX,
      label: 'DSGVO-Anonymisierung',
      desc: 'Mandanten nach Art. 17 DSGVO',
      badge: anonDueCount > 0 ? { count: anonDueCount, label: 'fällig' } : undefined,
    },
    {
      href: '/staff/admin/jobs',
      icon: Server,
      label: 'System → Jobs',
      desc: 'Hintergrund-Verarbeitung',
    },
    {
      href: '/staff/service-providers',
      icon: Building2,
      label: 'Dienstleisterverzeichnis',
      desc: 'DSGVO Art. 28 / GwG § 11',
    },
    {
      href: '/staff/poa',
      icon: ScrollText,
      label: 'Vollmachten',
      desc: 'Elektronischer Bestätigungsnachweis',
    },
    {
      href: '/staff/admin/custom-fields',
      icon: SlidersHorizontal,
      label: 'Mandanten-Custom-Felder',
      desc: 'Eigene Felder definieren',
    },
    {
      href: '/staff/admin/document-types',
      icon: FileStack,
      label: 'Datei-Typen & Schutzstufen',
      desc: 'Ablage- und Schutzregeln',
    },
    {
      href: '/staff/admin/request-templates',
      icon: Inbox,
      label: 'Anforderungs-Vorlagen',
      desc: 'Standard-Anfragen pflegen',
    },
    {
      href: '/staff/admin/email-templates',
      icon: Mail,
      label: 'E-Mail-Vorlagen',
      desc: 'Textbausteine pflegen',
    },
  ];

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-primary mb-1">Administration</h1>
        <p className="text-muted text-sm">Compliance-Status, Backup, Updates, DSGVO, Lizenz.</p>
      </div>

      {/* Lizenz-Banner ganz oben — sichtbar auch ohne Scrollen */}
      <LicenseCard info={license} />

      {legacyStorageVersionCount > 0 && (
        <div id="storage" className="card p-4 mb-6 border-l-4 border-l-yellow-500">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-yellow-600 mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-semibold text-primary">
                Storage-Inventur für {legacyStorageVersionCount} geschützte Bestandsversion
                {legacyStorageVersionCount === 1 ? '' : 'en'} erforderlich
              </p>
              <p className="text-xs text-muted mt-1">
                Diese vor der Versions-ID-Härtung angelegten Dateien bleiben sicher gesperrt, können
                aber erst nach Zuordnung ihrer konkreten S3-Version nachweisbar vernichtet werden.
                Bitte vor dem nächsten GwG-Löschlauf durch den Betreiber inventarisieren.
              </p>
            </div>
          </div>
        </div>
      )}

      <SetupChecklist setup={setup} />

      {/* Systemstatus-Hero: aggregiert alle bereits geladenen Prüfpunkte */}
      <StatusHero issues={issues} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <AuditStatusCard verifyResult={verifyResult} />
        <BackupStatusCard lastBackup={lastBackup} drill={drill} />

        <UpdateStatusCard updateCheck={updateCheck} />

        {/* DSGVO */}
        <div id="dsgvo" className="card p-6 scroll-mt-6">
          <div className="flex items-start gap-3 mb-2">
            <span className={`kpi-chip ${openDsgvoCount > 0 ? 'chip-amber' : 'chip-green'}`}>
              <Shield className="h-4 w-4" />
            </span>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-primary">Offene DSGVO-Anfragen</h2>
              <StatusLine tone={openDsgvoCount > 0 ? 'amber' : 'green'}>
                {openDsgvoCount === 0
                  ? 'Keine offenen Anfragen.'
                  : `${openDsgvoCount} Anfrage${openDsgvoCount === 1 ? '' : 'n'} in Bearbeitung`}
              </StatusLine>
              <Link
                href="/staff/admin/dsgvo"
                className="inline-block mt-2 text-xs font-medium text-brand-700 hover:underline dark:text-brand-300"
              >
                Anfragen verwalten →
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Sekundäre KPIs */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <SmallKpi icon={Users} label="Aktive Portal-Kontakte" value={contactCount} tone="brand" />
        <SmallKpi
          icon={Building2}
          label="Dienstleister erfasst"
          value={providerCount}
          tone="brand"
        />
        <SmallKpi
          icon={CheckCircle2}
          label="Audit-Einträge"
          value={verifyResult?.checked ?? 0}
          subtitle="hash-versiegelt"
          tone="green"
        />
      </div>

      {/* Quick-Links als Icon-Grid */}
      <div id="quicklinks" className="card p-6 scroll-mt-6">
        <QuickLinksHeader setup={setup} />
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {quickLinks.map((l) => {
            const Icon = l.icon;
            const content = (
              <>
                <span className="kpi-chip chip-gray">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-primary">
                    {l.label}
                    {l.badge && (
                      <span className="badge badge-red">
                        {l.badge.count} {l.badge.label}
                      </span>
                    )}
                  </span>
                  <span className="block text-xs text-muted mt-0.5">{l.desc}</span>
                </span>
                <ArrowRight className="h-3.5 w-3.5 mt-1 text-disabled transition-colors group-hover:text-muted" />
              </>
            );
            const cls =
              'group flex items-start gap-3 rounded-[10px] border border-default bg-surface-raised p-3.5 transition-colors hover:bg-surface-sunken hover:border-strong';
            return l.external ? (
              <a key={l.href} href={l.href} className={cls}>
                {content}
              </a>
            ) : (
              <Link key={l.href} href={l.href} className={cls}>
                {content}
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function UpdateStatusCard({ updateCheck }: { updateCheck: CheckResult }) {
  return (
    <div id="updates" className="card p-6 scroll-mt-6">
      <div className="flex items-start gap-3 mb-2">
        <span
          className={`kpi-chip ${
            updateCheck.ok && 'hasUpdate' in updateCheck && updateCheck.hasUpdate
              ? 'chip-amber'
              : 'chip-green'
          }`}
        >
          <Package className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-primary">Versionen / Updates</h2>
          <StatusLine tone="gray">
            Installiert: <strong>{APP_VERSION}</strong>
          </StatusLine>
          {updateCheck.ok ? (
            'hasUpdate' in updateCheck && updateCheck.hasUpdate ? (
              <StatusLine tone="amber">
                {updateCheck.newer?.length} neuere Version
                {updateCheck.newer && updateCheck.newer.length === 1 ? '' : 'en'} verfügbar
              </StatusLine>
            ) : (
              <StatusLine tone="green">Aktuell auf dem neuesten Stand.</StatusLine>
            )
          ) : (
            <StatusLine tone="gray">
              {updateCheck.warning ?? updateCheck.error ?? 'Update-Server nicht konfiguriert.'}
            </StatusLine>
          )}
        </div>
      </div>
    </div>
  );
}

/** AUDIT-VERIFY-ALERT-001: only render the persisted result; never run verification here. */
function AuditStatusCard({ verifyResult }: { verifyResult: PersistedVerifyResult | null }) {
  return (
    <div id="audit" className="card p-6 scroll-mt-6">
      <div className="flex items-start gap-3 mb-2">
        <span
          className={`kpi-chip ${
            verifyResult?.ok
              ? 'chip-green'
              : verifyResult?.recovered
                ? 'chip-amber'
                : verifyResult
                  ? 'chip-red'
                  : 'chip-gray'
          }`}
        >
          <ShieldCheck className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-primary">Audit-Hash-Chain</h2>
          {verifyResult ? (
            verifyResult.ok ? (
              <>
                <StatusLine tone="green">
                  Intakt — {verifyResult.checked} Einträge geprüft
                </StatusLine>
                <StatusLine tone="gray">
                  {verifyResult.sealsChecked} Tagesversiegelungen geprüft
                  {verifyResult.sealBreaks > 0
                    ? `, ${verifyResult.sealBreaks} mit TSA-Problem`
                    : ''}
                </StatusLine>
                <StatusLine tone="gray">
                  Zuletzt geprüft: {fmtDateTimeShort(new Date(verifyResult.checkedAt))}
                </StatusLine>
              </>
            ) : verifyResult.error ? (
              <>
                <StatusLine tone="red">Verifikationslauf fehlgeschlagen</StatusLine>
                <StatusLine tone="gray">{verifyResult.error}</StatusLine>
              </>
            ) : (
              <>
                <StatusLine tone={verifyResult.recovered ? 'amber' : 'red'}>
                  {verifyResult.recovered
                    ? 'Historischer Bruch — Recovery-Checkpoint gesetzt'
                    : 'Hash-Chain gebrochen!'}
                </StatusLine>
                {verifyResult.firstBreak && (
                  <StatusLine tone="gray">
                    Bei Audit-ID {String(verifyResult.firstBreak.auditId)}
                  </StatusLine>
                )}
              </>
            )
          ) : (
            <StatusLine tone="gray">
              Noch keine Verifikation — der tägliche Prüf-Job hat noch nicht gelaufen.
            </StatusLine>
          )}
        </div>
      </div>
      <p className="text-xs text-disabled">
        CLI: <code className="text-secondary">pnpm verify:chain</code>
      </p>
    </div>
  );
}

function BackupStatusCard({
  lastBackup,
  drill,
}: {
  lastBackup: BackupRecord | null;
  drill: PersistedDrillResult | null;
}) {
  return (
    <div id="backup" className="card p-6 scroll-mt-6">
      <div className="flex items-start gap-3 mb-2">
        <span
          className={`kpi-chip ${
            lastBackup?.status === 'SUCCESS'
              ? 'chip-green'
              : lastBackup?.status === 'FAILED'
                ? 'chip-red'
                : 'chip-gray'
          }`}
        >
          <Database className="h-4 w-4" />
        </span>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-primary">Letztes Backup</h2>
          {lastBackup ? (
            <>
              <StatusLine tone={lastBackup.status === 'SUCCESS' ? 'green' : 'red'}>
                {fmtDateTimeShort(lastBackup.startedAt)} — {lastBackup.status}
              </StatusLine>
              {lastBackup.sizeBytes && (
                <StatusLine tone="gray">
                  {fmtBytes(Number(lastBackup.sizeBytes))} → {lastBackup.bucket}
                </StatusLine>
              )}
              {lastBackup.errorMsg && <StatusLine tone="red">{lastBackup.errorMsg}</StatusLine>}
            </>
          ) : (
            <StatusLine tone="amber">Noch nie gesichert</StatusLine>
          )}
          {/* Restore-Drill: beweisbarer Wiederherstellungstest (monatlich) */}
          {drill ? (
            drill.ok ? (
              <StatusLine tone="green">
                Restore-Test {fmtDateTimeShort(new Date(drill.checkedAt))}: erfolgreich
                {drill.auditChecked > 0
                  ? ` (${drill.auditChecked} Audit-Einträge verifiziert)`
                  : ''}
              </StatusLine>
            ) : (
              <StatusLine tone="red">
                Restore-Test {fmtDateTimeShort(new Date(drill.checkedAt))} fehlgeschlagen
                {drill.error ? ` — ${drill.error}` : ''}
              </StatusLine>
            )
          ) : (
            <StatusLine tone="gray">
              Restore-Test: noch kein Lauf (monatlich am 1., 05:00 UTC)
            </StatusLine>
          )}
          <div className="mt-3 flex flex-wrap items-start gap-2">
            <BackupRunButton />
            {lastBackup?.status === 'SUCCESS' && lastBackup.key && (
              <p className="basis-full text-xs text-yellow-700">
                Vollständige Datenbank-Backups enthalten globale Sicherheitsdaten und sind deshalb
                nur über den Betreiber-Host beziehungsweise den Backup-Storage abrufbar.
              </p>
            )}
          </div>
        </div>
      </div>
      <p className="text-xs text-disabled">
        CLI: <code className="text-secondary">./taxtronik backup</code>
      </p>
      <p className="text-xs text-disabled mt-1">
        Lokale Kopie: <code className="text-secondary">backups/</code>
      </p>
    </div>
  );
}

function StatusHero({ issues }: { issues: StatusIssue[] }) {
  const ok = issues.length === 0;
  return (
    <div
      className={`card p-5 mb-6 border-l-4 ${ok ? 'border-l-emerald-500' : 'border-l-amber-500'}`}
    >
      <div className="flex items-start gap-3">
        <span className={`kpi-chip ${ok ? 'chip-green' : 'chip-amber'}`}>
          {ok ? <ShieldCheck className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        </span>
        <div className="flex-1">
          <p className="text-sm font-semibold text-primary">
            {ok
              ? 'Systemstatus: Alles in Ordnung'
              : `Systemstatus: ${issues.length} ${issues.length === 1 ? 'Punkt braucht' : 'Punkte brauchen'} Aufmerksamkeit`}
          </p>
          {ok ? (
            <p className="text-xs text-muted mt-0.5">
              Audit-Chain, Backup, Updates und Pflichtaufgaben ohne Befund.
            </p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
              {issues.map((i) => (
                <li key={i.href + i.label}>
                  <a
                    href={i.href}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:underline dark:text-amber-300"
                  >
                    <span className="status-dot dot-amber" aria-hidden />
                    {i.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusLine({
  tone,
  children,
}: {
  tone: 'green' | 'amber' | 'red' | 'gray';
  children: ReactNode;
}) {
  return (
    <p className="flex items-center gap-2 text-xs text-secondary mt-1.5">
      <span className={`status-dot dot-${tone}`} aria-hidden />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function SetupChecklist({ setup }: { setup: SetupStatus }) {
  if (setup.allDone || setup.dismissed) return null;
  return (
    <div className="card p-5 mb-6 border-l-4 border-l-yellow-500 dark:border-l-yellow-400">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-primary">Erste Schritte zur Inbetriebnahme</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">
            {setup.doneCount} / {setup.totalCount} erledigt
          </span>
          <form action={dismissSetupChecklistAction}>
            <button type="submit" className="text-xs text-muted hover:text-primary underline">
              Einführung überspringen
            </button>
          </form>
        </div>
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
                  {!item.done && (
                    <ArrowRight className="h-3.5 w-3.5 text-disabled group-hover:text-muted" />
                  )}
                </div>
                {!item.done && item.hint && <p className="text-xs text-muted">{item.hint}</p>}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QuickLinksHeader({ setup }: { setup: SetupStatus }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <h2 className="text-sm font-semibold text-primary">Quick-Links</h2>
      {setup.dismissed && !setup.allDone && (
        <form action={restoreSetupChecklistAction}>
          <button type="submit" className="text-xs text-brand-700 hover:underline">
            Einführung wieder anzeigen
          </button>
        </form>
      )}
    </div>
  );
}

function SmallKpi({
  icon: Icon,
  label,
  value,
  subtitle,
  tone = 'brand',
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: number;
  subtitle?: string;
  tone?: 'brand' | 'green';
}) {
  return (
    <div className="card p-4 flex items-center gap-3">
      <span className={`kpi-chip ${tone === 'green' ? 'chip-green' : 'chip-brand'}`}>
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted uppercase tracking-wide truncate">{label}</p>
        <p className="text-2xl font-bold text-primary tabular-nums leading-tight">
          <CountUp value={value} />
        </p>
        {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
      </div>
    </div>
  );
}
