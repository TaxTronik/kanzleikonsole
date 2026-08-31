// =============================================================================
// /staff/admin/audit — Audit-Log-Viewer
//
// Cursor-basierte Pagination (höchste id zuerst, älter via cursor).
// Filter: action-Pattern, actor-Type, resource-Type, von/bis-Datum.
// Zeigt Hash-Chain-Status oben (verifiziert oder gebrochen).
// =============================================================================

import Link from 'next/link';
import { ShieldCheck, ShieldAlert, ChevronLeft, ChevronRight, FileDown } from 'lucide-react';
import { requireStaffPage } from '@/server/auth/staff-page';

import { withTenantContext } from '@taxtronik/db';
import { readTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  AUDIT_ANCHOR_STATUS_SETTING_KEY,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  type PersistedAnchorStatus,
  type PersistedRecoveryCheckpoint,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';
import { env } from '@taxtronik/config';
import { createAuditRecoveryCheckpointAction, triggerAuditVerifyAction } from './actions';
import { AuditVerifyAutoRefresh } from './audit-verify-auto-refresh';
import { AuditAnchorAutoRefresh } from './audit-anchor-auto-refresh';
import { AuditNotificationAcknowledger } from './audit-notification-acknowledger';
import { signAuditToken, AUDIT_TOKEN_TTL_DAYS } from '@/server/audit-access/token';
import { CopyField } from '@/components/copy-field';
import { fmtDateTimeSeconds } from '@/lib/fmt';
import {
  AUDIT_CATEGORIES,
  AuditQuerySchema,
  auditCategory,
  auditPageWhere,
  auditQueryString,
  auditWhere,
} from '@/server/audit/query';
import { auditDisplayStatus } from '@/server/audit/status';

const PAGE_SIZE = 50;

const actorTypeLabels: Record<string, string> = {
  STAFF: 'Mitarbeiter',
  CLIENT_CONTACT: 'Mandant',
  SYSTEM: 'System',
};

interface SearchParams {
  cursor?: string;
  action?: string;
  actorType?: string;
  resourceType?: string;
  category?: string;
  sort?: string;
  from?: string;
  to?: string;
  verify?: string;
  requestId?: string;
  queuedAt?: string;
  checkpoint?: string;
}

interface AnchorSummary {
  last_anchored_audit_id: bigint | null;
  tsa_gen_time: Date | null;
  trust_anchored: boolean | null;
  pending_count: bigint;
  oldest_pending_at: Date | null;
}

function normalizeAnchorSummary(rows: AnchorSummary[]): AnchorSummary {
  return (
    rows[0] ?? {
      last_anchored_audit_id: null,
      tsa_gen_time: null,
      trust_anchored: null,
      pending_count: BigInt(0),
      oldest_pending_at: null,
    }
  );
}

function verifiedRollingAnchorCount(result: PersistedVerifyResult): number {
  return result.anchorsChecked ?? 0;
}

function brokenRollingAnchorCount(result: PersistedVerifyResult): number {
  return result.anchorBreaks ?? 0;
}

function RollingAnchorBreakSummary({ result }: { result: PersistedVerifyResult }) {
  const broken = brokenRollingAnchorCount(result);
  if (broken === 0) return null;
  return (
    <p className="text-xs text-red-700 mt-1 dark:text-red-200">
      {broken} externe Rolling-Verankerung(en) mit Integritätsproblem
    </p>
  );
}

function hasPendingAnchors(count: number): boolean {
  return count > 0;
}

function auditOkResultKey(result: PersistedVerifyResult | null): string | null {
  if (!result?.ok || result.error) return null;
  return `${result.checkedAt}:${result.requestId ?? ''}`;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await requireStaffPage({ admin: true });

  const sp = await searchParams;
  const { tenantId, staffId } = session.user;

  const parsed = AuditQuerySchema.safeParse(
    Object.fromEntries(Object.entries(sp).map(([key, value]) => [key, value || undefined])),
  );
  const query = parsed.success ? parsed.data : AuditQuerySchema.parse({});
  const where = parsed.success ? auditPageWhere(query, sp.cursor) : { id: 0n };

  // P-1: aktive Filter? Nur dann ist ein exakter COUNT vertretbar; bei leerem
  // Filter wäre das ein Scan über den GANZEN Log → reltuples-Schätzung.
  const hasFilter =
    !parsed.success ||
    Boolean(
      query.action ||
      query.actorType ||
      query.resourceType ||
      query.category ||
      query.from ||
      query.to,
    );

  const [
    entries,
    verifySetting,
    checkpointSetting,
    anchorStatusSetting,
    anchorSummaryRows,
    resourceTypeRows,
    totalCount,
  ] = await withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, async (tx) =>
    Promise.all([
      tx.auditLog.findMany({
        where,
        orderBy: { id: query.sort === 'oldest' ? 'asc' : 'desc' },
        take: PAGE_SIZE + 1,
      }),
      // P-1: Chain-Verifikation läuft NICHT mehr im Render-Pfad (SHA-256 über
      // den kompletten Log; Sekunden bei 200k, P2028 ab ~500k). Hier nur das
      // vom täglichen Worker-Job (audit-verify-check) persistierte Ergebnis.
      readTenantSettingValue(tx, tenantId, AUDIT_VERIFY_RESULT_SETTING_KEY),
      readTenantSettingValue(tx, tenantId, AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY),
      readTenantSettingValue(tx, tenantId, AUDIT_ANCHOR_STATUS_SETTING_KEY),
      tx.$queryRaw<AnchorSummary[]>`
          WITH latest_anchor AS (
            SELECT top_audit_id, tsa_gen_time, trust_anchored
            FROM audit_anchor
            WHERE tenant_id = ${tenantId}::uuid
            ORDER BY id DESC
            LIMIT 1
          )
          SELECT
            (SELECT top_audit_id FROM latest_anchor) AS last_anchored_audit_id,
            (SELECT tsa_gen_time FROM latest_anchor) AS tsa_gen_time,
            (SELECT trust_anchored FROM latest_anchor) AS trust_anchored,
            count(l.id)::bigint AS pending_count,
            min(l.occurred_at) AS oldest_pending_at
          FROM audit_log l
          WHERE l.tenant_id = ${tenantId}::uuid
            AND l.id > COALESCE((SELECT top_audit_id FROM latest_anchor), 0)
        `,
      // P-1: groupBy statt distinct — Prisma dedupliziert `distinct` ohne
      // nativeDistinct IN-MEMORY und überträgt dafür JEDE Zeile.
      tx.auditLog.groupBy({
        by: ['resourceType'],
        orderBy: { resourceType: 'asc' },
      }),
      hasFilter
        ? tx.auditLog.count({ where: parsed.success ? auditWhere(query) : { id: 0n } })
        : // pg_class-reltuples-Schätzung statt COUNT(*) über den ganzen Log.
          tx.$queryRaw<{ estimate: bigint }[]>`
              SELECT reltuples::bigint AS estimate
              FROM pg_class
              WHERE oid = to_regclass('audit_log')
            `.then((rows) => {
            const est = Number(rows[0]?.estimate ?? -1);
            // -1 = Tabelle noch nie analysiert (frische DB) → exakter Count ok.
            return est >= 0 ? est : tx.auditLog.count();
          }),
    ]),
  );

  const verifyResult = (verifySetting ?? null) as PersistedVerifyResult | null;
  const checkpoint = (checkpointSetting ?? null) as PersistedRecoveryCheckpoint | null;
  const anchorStatus = (anchorStatusSetting ?? null) as PersistedAnchorStatus | null;
  const anchorSummary = normalizeAnchorSummary(anchorSummaryRows);
  const pendingAnchorCount = Number(anchorSummary.pending_count);
  const pendingVerify = sp.verify === 'queued';
  // „Fertig", wenn das persistierte Ergebnis exakt den angestoßenen Lauf trägt
  // ODER (robust gegen Überschreiben durch nächtlichen/parallelen Lauf) neuer
  // als der Trigger-Zeitpunkt ist. Solange nicht fertig, wird gepollt.
  const queuedAtMs = sp.queuedAt ? Date.parse(sp.queuedAt) : NaN;
  const checkedAtMs = verifyResult?.checkedAt ? Date.parse(verifyResult.checkedAt) : NaN;
  const verifyDone =
    !!verifyResult &&
    ((!!sp.requestId && verifyResult.requestId === sp.requestId) ||
      (!Number.isNaN(queuedAtMs) && !Number.isNaN(checkedAtMs) && checkedAtMs > queuedAtMs));
  const pollVerify = pendingVerify && !!sp.requestId && !verifyDone;
  // P-1/M-6: Die Recovery-Teilketten-Verifikation läuft NICHT mehr im
  // Render-Pfad (SHA-256-Walk ab Checkpoint, wuchs unbegrenzt). Der `recovered`-
  // Status stammt allein aus dem persistierten Worker-Ergebnis + gesetztem
  // Checkpoint. Der Worker berechnet die Teilkette bewusst nicht (als
  // fehleranfällig verworfen); der Checkpoint ist die Admin-Abgrenzung.

  const chainStatus = auditDisplayStatus(verifyResult, checkpoint);
  const recoveryIntact = chainStatus === 'amber';

  const hasNext = entries.length > PAGE_SIZE;
  const visibleEntries = entries.slice(0, PAGE_SIZE);
  const nextCursor = hasNext ? String(visibleEntries[visibleEntries.length - 1]!.id) : null;
  const auditLinkExpiresAt = (() => {
    const now = new Date();
    return (
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) +
      AUDIT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
    );
  })();

  // Filter-Query-String für Pagination-Links
  const baseQs = auditQueryString(query);
  const nextQs = new URLSearchParams(baseQs);
  if (nextCursor) nextQs.set('cursor', nextCursor);

  return (
    <div className="p-8">
      <AuditNotificationAcknowledger resultKey={auditOkResultKey(verifyResult)} />
      <AuditAnchorAutoRefresh active={hasPendingAnchors(pendingAnchorCount)} />
      {pollVerify && <AuditVerifyAutoRefresh requestId={sp.requestId} queuedAt={sp.queuedAt} />}
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Audit-Log</h1>
          <p className="text-muted text-sm">
            Hash-verkettete Aufzeichnung aller compliance-relevanten Operationen.
          </p>
        </div>
        <a
          href={parsed.success ? `/api/staff/admin/audit/export?${baseQs.toString()}` : undefined}
          aria-disabled={!parsed.success}
          className="btn-secondary"
        >
          <FileDown className="h-4 w-4" />
          CSV exportieren
        </a>
      </div>

      <RollingAnchorCard
        summary={anchorSummary}
        status={anchorStatus}
        pendingCount={pendingAnchorCount}
      />

      {/* Prüfer-Self-Service: zeitlich begrenzter read-only Verifikations-Link */}
      <div className="card p-4 mb-6">
        <h2 className="text-sm font-medium text-primary mb-1">Prüfer-Link (read-only)</h2>
        <p className="text-xs text-muted mb-3">
          Geben Sie diesen Link an einen Wirtschaftsprüfer weiter — er rechnet die Hash-Chain und
          die TSA-Versiegelungen nach, OHNE Zugriff auf Mandantendaten. Gültig{' '}
          {AUDIT_TOKEN_TTL_DAYS} Tage.
        </p>
        <CopyField
          value={`${env.NEXTAUTH_URL.replace(/\/$/, '')}/audit-verify/${signAuditToken(
            tenantId,
            auditLinkExpiresAt,
          )}`}
        />
      </div>

      {/* Hash-Chain-Status — letztes persistiertes Ergebnis des täglichen
          Prüf-Jobs (audit-verify-check); „Jetzt prüfen" stößt einen neuen
          Lauf im Hintergrund an. */}
      <div
        className={
          chainStatus === 'none'
            ? 'rounded-md border border-default bg-gray-50 p-4 mb-6 dark:bg-gray-900/60'
            : chainStatus === 'ok'
              ? 'rounded-md border border-green-200 bg-green-50 p-4 mb-6 dark:border-green-800 dark:bg-green-950/50'
              : chainStatus === 'amber'
                ? 'rounded-md border border-yellow-200 bg-yellow-50 p-4 mb-6 dark:border-yellow-800 dark:bg-yellow-950/50'
                : 'rounded-md border border-red-200 bg-red-50 p-4 mb-6 dark:border-red-800 dark:bg-red-950/50'
        }
      >
        <div className="flex items-start gap-3">
          {chainStatus === 'ok' ? (
            <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
          ) : chainStatus === 'amber' ? (
            <ShieldAlert className="h-5 w-5 text-yellow-600 mt-0.5" />
          ) : (
            <ShieldAlert
              className={
                chainStatus === 'none'
                  ? 'h-5 w-5 text-disabled mt-0.5'
                  : 'h-5 w-5 text-red-600 mt-0.5'
              }
            />
          )}
          <div className="flex-1">
            {!verifyResult ? (
              <p className="text-sm text-secondary">
                Noch kein Prüfergebnis — der tägliche Integritäts-Job ist noch nicht gelaufen.
                „Jetzt prüfen" stößt eine Verifikation an.
              </p>
            ) : chainStatus === 'ok' ? (
              <>
                <p className="text-sm font-medium text-green-900 dark:text-green-100">
                  Hash-Chain intakt — {verifyResult.checked.toLocaleString('de-DE')} Einträge
                  geprüft
                </p>
                <p className="text-xs text-green-700 mt-1 dark:text-green-200">
                  {verifyResult.sealsChecked} Tagesversiegelungen geprüft
                  {' · '}
                  {verifiedRollingAnchorCount(verifyResult)} Rolling-Anker geprüft
                  {' · '}zuletzt geprüft {fmtDateTimeSeconds(new Date(verifyResult.checkedAt))}
                </p>
                {verifyResult.tsaMode === 'local' && (
                  <p className="text-xs text-amber-700 mt-1 dark:text-amber-200">
                    ⚠ Zeitstempel-Modus: lokal — keine externe TSA. Der Seal-Check ist
                    gegenstandslos; nur die SHA-256-Kette trägt. Für revisionssichere externe
                    Verankerung eine RFC-3161-TSA konfigurieren.
                  </p>
                )}
                {verifyResult.tsaMode === 'rfc3161' && (
                  <p
                    className={
                      'text-xs mt-1 ' +
                      (verifyResult.sealsChecked > 0 &&
                      (verifyResult.sealsTrustAnchored ?? 0) < verifyResult.sealsChecked
                        ? 'text-amber-700 dark:text-amber-200'
                        : 'text-green-700 dark:text-green-200')
                    }
                  >
                    Zeitstempel-Modus: externe TSA (RFC 3161).
                    {verifyResult.sealsChecked > 0 && (
                      <>
                        {' '}
                        Trust-verankert: {verifyResult.sealsTrustAnchored ?? 0}/
                        {verifyResult.sealsChecked}.
                        {(verifyResult.sealsTrustAnchored ?? 0) < verifyResult.sealsChecked && (
                          <> Übrige ungültig — passenden Produktiv-TSA-Root hinterlegen.</>
                        )}
                      </>
                    )}
                  </p>
                )}
              </>
            ) : recoveryIntact ? (
              <>
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-100">
                  Historischer Chain-Befund — Recovery-Checkpoint dokumentiert
                </p>
                {verifyResult.firstBreak && (
                  <p className="text-xs text-yellow-800 mt-1 font-mono dark:text-yellow-100">
                    Befund bei Audit-ID {verifyResult.firstBreak.auditId} (
                    {fmtDateTimeSeconds(new Date(verifyResult.firstBreak.occurredAt))}) —
                    historisch, durch Checkpoint abgegrenzt.
                  </p>
                )}
                {checkpoint && (
                  <p className="text-xs text-yellow-800 mt-1 dark:text-yellow-100">
                    Recovery-Checkpoint ab Audit-ID {checkpoint.auditId} gesetzt — der historische
                    Bruch bleibt abgegrenzt.
                  </p>
                )}
                <p className="text-xs text-yellow-700 mt-1 dark:text-yellow-200">
                  Zuletzt geprüft {fmtDateTimeSeconds(new Date(verifyResult.checkedAt))}
                </p>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-red-900 dark:text-red-100">
                  {verifyResult.error ? 'Verifikation fehlgeschlagen.' : '⚠ Hash-Chain gebrochen!'}
                </p>
                {verifyResult.firstBreak && (
                  <p className="text-xs text-red-700 mt-1 font-mono dark:text-red-200">
                    Erster Bruch bei Audit-ID {verifyResult.firstBreak.auditId} (
                    {fmtDateTimeSeconds(new Date(verifyResult.firstBreak.occurredAt))})
                  </p>
                )}
                {verifyResult.sealBreaks > 0 && (
                  <p className="text-xs text-red-700 mt-1 dark:text-red-200">
                    {verifyResult.sealBreaks} Tagesversiegelung(en) mit TSA-Problem
                  </p>
                )}
                <RollingAnchorBreakSummary result={verifyResult} />
                {(verifyResult.policyBreaks ?? []).map((b) => (
                  <p key={b} className="text-xs text-red-700 mt-1 dark:text-red-200">
                    {b}
                  </p>
                ))}
                {verifyResult.error && (
                  <p className="text-xs text-red-700 mt-1 dark:text-red-200">
                    Fehler: {verifyResult.error}
                  </p>
                )}
                <p className="text-xs text-red-700 mt-1 dark:text-red-200">
                  Geprüft {fmtDateTimeSeconds(new Date(verifyResult.checkedAt))}
                </p>
                <form
                  action={createAuditRecoveryCheckpointAction}
                  className="mt-3 rounded-md border border-red-300 bg-white/70 p-3 dark:border-red-800 dark:bg-red-950/60"
                >
                  <p className="text-xs font-medium text-red-900 dark:text-red-100">
                    Wiederaufnahme markieren
                  </p>
                  <p className="text-xs text-red-700 mt-1 dark:text-red-200">
                    Legt einen Recovery-Checkpoint an: das historische Rot wird damit bernstein
                    abgegrenzt und die Break-Benachrichtigung verstummt.
                  </p>
                  <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                    <input
                      name="reason"
                      className="input text-xs sm:flex-1"
                      maxLength={500}
                      placeholder="Begründung, z. B. TSA-Fehlkonfiguration behoben"
                    />
                    <button
                      type="submit"
                      className="btn-primary !bg-red-600 text-xs hover:!bg-red-700"
                    >
                      Recovery-Checkpoint anlegen
                    </button>
                  </div>
                </form>
              </>
            )}
            {pollVerify && (
              <p className="text-xs text-primary mt-2">
                Prüfung angestoßen — das Ergebnis erscheint hier, sobald der Hintergrund-Job
                abgeschlossen ist.
              </p>
            )}
            {sp.checkpoint === 'created' && (
              <p className="text-xs text-secondary mt-2">Recovery-Checkpoint angelegt.</p>
            )}
          </div>
          <form action={triggerAuditVerifyAction}>
            <button type="submit" className="btn-secondary text-xs shrink-0">
              Jetzt prüfen
            </button>
          </form>
        </div>
      </div>

      {/* Filter */}
      {!parsed.success && (
        <p role="alert" className="alert-error-sm mb-4">
          Ungültige Filter: {parsed.error.issues.map((issue) => issue.message).join(' ')}
        </p>
      )}
      <p className="text-xs text-muted mb-3">
        Filter betreffen nur die Anzeige und den CSV-Auszug. Der Prüfstatus gilt für die
        vollständige Kanzlei-Kette; ein gefilterter Auszug ist kein lückenloses Kettenarchiv.
      </p>
      <form
        action="/staff/admin/audit"
        method="get"
        className="card p-4 mb-6 grid grid-cols-2 md:grid-cols-5 gap-3"
      >
        <div>
          <label className="label" htmlFor="category">
            Bereich
          </label>
          <select
            id="category"
            name="category"
            className="input text-xs"
            defaultValue={sp.category ?? ''}
          >
            <option value="">Alle Bereiche</option>
            {Object.entries(AUDIT_CATEGORIES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="sort">
            Kettenfolge
          </label>
          <select id="sort" name="sort" className="input text-xs" defaultValue={query.sort}>
            <option value="newest">Neueste zuerst</option>
            <option value="oldest">Älteste zuerst</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="action">
            Action
          </label>
          <input
            id="action"
            name="action"
            type="text"
            className="input text-xs"
            placeholder="z. B. document.upload"
            defaultValue={sp.action ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="actorType">
            Akteur
          </label>
          <select
            id="actorType"
            name="actorType"
            className="input text-xs"
            defaultValue={sp.actorType ?? ''}
          >
            <option value="">Alle</option>
            <option value="STAFF">Mitarbeiter</option>
            <option value="CLIENT_CONTACT">Mandant</option>
            <option value="SYSTEM">System</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="resourceType">
            Ressource
          </label>
          <select
            id="resourceType"
            name="resourceType"
            className="input text-xs"
            defaultValue={sp.resourceType ?? ''}
          >
            <option value="">Alle</option>
            {resourceTypeRows.map((r) => (
              <option key={r.resourceType} value={r.resourceType}>
                {r.resourceType}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="from">
            Von
          </label>
          <input
            id="from"
            name="from"
            type="date"
            className="input text-xs"
            defaultValue={sp.from ?? ''}
          />
        </div>
        <div>
          <label className="label" htmlFor="to">
            Bis
          </label>
          <input
            id="to"
            name="to"
            type="date"
            className="input text-xs"
            defaultValue={sp.to ?? ''}
          />
        </div>
        <div className="col-span-2 md:col-span-5 flex gap-2">
          <button type="submit" className="btn-primary text-xs">
            Filtern
          </button>
          <Link href="/staff/admin/audit" className="btn-secondary text-xs">
            Zurücksetzen
          </Link>
        </div>
      </form>

      {/* Tabelle */}
      <div className="card overflow-hidden">
        <div className="px-6 py-3 border-b border-default flex items-center justify-between text-xs text-muted">
          <span>
            {hasFilter
              ? `${totalCount.toLocaleString('de-DE')} Treffer · zeige ${visibleEntries.length}`
              : // reltuples-Schätzung (gerundet) — exakter Count würde den ganzen Log scannen.
                `~${(totalCount >= 1000
                  ? Math.round(totalCount / 100) * 100
                  : totalCount
                ).toLocaleString('de-DE')} Einträge gesamt · zeige ${visibleEntries.length}`}
          </span>
        </div>
        {visibleEntries.length === 0 ? (
          <p className="px-6 py-16 text-sm text-disabled text-center">Keine Einträge.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-50 border-b border-default">
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                  ID
                </th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                  Zeit
                </th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                  Akteur
                </th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                  Action
                </th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                  Ressource
                </th>
                <th className="text-left px-6 py-2 text-xs font-medium text-muted uppercase tracking-wide">
                  Hash
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {visibleEntries.map((e) => (
                <tr key={String(e.id)} className="hover:bg-gray-50">
                  <td className="px-6 py-2 font-mono text-muted">
                    <Link
                      href={`/staff/admin/audit/${e.id}`}
                      className="hover:underline text-brand-700"
                    >
                      {String(e.id)}
                    </Link>
                  </td>
                  <td className="px-6 py-2 text-secondary whitespace-nowrap">
                    {fmtDateTimeSeconds(e.occurredAt)}
                  </td>
                  <td className="px-6 py-2 text-secondary whitespace-nowrap">
                    {actorTypeLabels[e.actorType] ?? e.actorType}
                  </td>
                  <td className="px-6 py-2 text-primary">
                    <span className="block font-mono whitespace-nowrap">{e.action}</span>
                    <span className="text-muted">{AUDIT_CATEGORIES[auditCategory(e.action)]}</span>
                  </td>
                  <td className="px-6 py-2 text-secondary font-mono whitespace-nowrap">
                    {e.resourceType}
                    {e.resourceId && (
                      <span className="text-disabled">:{e.resourceId.slice(0, 8)}</span>
                    )}
                  </td>
                  <td className="px-6 py-2 text-disabled font-mono break-all">
                    {Buffer.from(e.thisHash).toString('hex')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Pagination-Footer */}
        <div className="card-footer">
          {sp.cursor ? (
            <Link
              href={`/staff/admin/audit${baseQs.toString() ? '?' + baseQs.toString() : ''}`}
              className="text-brand-700 hover:underline flex items-center gap-1"
            >
              <ChevronLeft className="h-3 w-3" />
              Zur ersten Seite
            </Link>
          ) : (
            <span />
          )}
          {nextCursor ? (
            <Link
              href={`/staff/admin/audit?${nextQs.toString()}`}
              className="text-brand-700 hover:underline flex items-center gap-1"
            >
              {query.sort === 'oldest' ? 'Neuere Einträge' : 'Ältere Einträge'}
              <ChevronRight className="h-3 w-3" />
            </Link>
          ) : (
            <span className="text-disabled">Ende der Liste</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Dual-stamping status; kept separate from the already large log page. */
function RollingAnchorCard({
  summary,
  status,
  pendingCount,
}: {
  summary: AnchorSummary;
  status: PersistedAnchorStatus | null;
  pendingCount: number;
}) {
  const delayed = status?.state === 'DELAYED' || status?.state === 'LOCAL_ONLY';
  const cardClass = delayed
    ? 'rounded-md border border-yellow-300 bg-yellow-50 p-4 mb-6 dark:border-yellow-800 dark:bg-yellow-950/50'
    : pendingCount > 0
      ? 'rounded-md border border-blue-200 bg-blue-50 p-4 mb-6 dark:border-blue-800 dark:bg-blue-950/50'
      : 'rounded-md border border-green-200 bg-green-50 p-4 mb-6 dark:border-green-800 dark:bg-green-950/50';
  return (
    <div className={cardClass}>
      <div className="flex items-start gap-3">
        {pendingCount === 0 && summary.last_anchored_audit_id ? (
          <ShieldCheck className="h-5 w-5 text-green-600 mt-0.5" />
        ) : (
          <ShieldAlert className="h-5 w-5 text-yellow-600 mt-0.5" />
        )}
        <div>
          <p className="text-sm font-medium text-primary">Externe Rolling-Verankerung</p>
          {summary.last_anchored_audit_id ? (
            <p className="text-xs text-secondary mt-1">
              RFC-3161-verankert bis Audit-ID {String(summary.last_anchored_audit_id)}
              {summary.tsa_gen_time && <> · TSA-Zeit {fmtDateTimeSeconds(summary.tsa_gen_time)}</>}
              {' · '}
              {summary.trust_anchored ? 'Trust-verankert' : 'Trust-Anchor fehlt'}
            </p>
          ) : (
            <p className="text-xs text-secondary mt-1">
              Noch kein externer Rolling-Anker vorhanden.
            </p>
          )}
          {pendingCount > 0 ? (
            <p className="text-xs text-blue-800 mt-1 dark:text-blue-100">
              {pendingCount} lokal verkettete{' '}
              {pendingCount === 1 ? 'Änderung wartet' : 'Änderungen warten'} auf den nächsten
              TSA-Checkpoint. Neue Einträge bleiben währenddessen möglich.
              {summary.oldest_pending_at && (
                <> Ältester offener Eintrag: {fmtDateTimeSeconds(summary.oldest_pending_at)}.</>
              )}
            </p>
          ) : (
            <p className="text-xs text-green-700 mt-1 dark:text-green-200">
              Kein unverankerter lokaler Restbestand.
            </p>
          )}
          {status?.error && (
            <p className="text-xs text-yellow-800 mt-1 dark:text-yellow-100">
              Letzter TSA-Versuch verzögert: {status.error}
              {status.nextRetryAt && (
                <> · nächster Versuch {fmtDateTimeSeconds(new Date(status.nextRetryAt))}</>
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
