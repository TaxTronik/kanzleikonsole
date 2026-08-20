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
import {
  AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY,
  AUDIT_VERIFY_RESULT_SETTING_KEY,
  type PersistedRecoveryCheckpoint,
  type PersistedVerifyResult,
} from '@taxtronik/evidence';
import { env } from '@taxtronik/config';
import { createAuditRecoveryCheckpointAction, triggerAuditVerifyAction } from './actions';
import { AuditVerifyAutoRefresh } from './audit-verify-auto-refresh';
import { AuditNotificationAcknowledger } from './audit-notification-acknowledger';
import { signAuditToken, AUDIT_TOKEN_TTL_DAYS } from '@/server/audit-access/token';
import { CopyField } from '@/components/copy-field';
import type { Prisma } from '@prisma/client';
import { fmtDateTimeSeconds, berlinDayStartUtc, berlinDayEndUtc } from '@/lib/fmt';

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
  from?: string;
  to?: string;
  verify?: string;
  requestId?: string;
  queuedAt?: string;
  checkpoint?: string;
}

function auditOkResultKey(result: PersistedVerifyResult | null): string | null {
  if (!result?.ok) return null;
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

  const where: Prisma.AuditLogWhereInput = {};
  if (sp.action) where.action = { contains: sp.action, mode: 'insensitive' };
  if (sp.actorType && ['STAFF', 'CLIENT_CONTACT', 'SYSTEM'].includes(sp.actorType)) {
    where.actorType = sp.actorType as 'STAFF' | 'CLIENT_CONTACT' | 'SYSTEM';
  }
  if (sp.resourceType) where.resourceType = sp.resourceType;
  if (sp.from || sp.to) {
    where.occurredAt = {};
    // Tagesgrenzen in Europe/Berlin (nicht UTC/server-lokal), passend zur
    // Anzeige — sonst erscheinen Einträge von 00:00–02:00 Berlin im Vortag.
    const gte = sp.from ? berlinDayStartUtc(sp.from) : null;
    const lte = sp.to ? berlinDayEndUtc(sp.to) : null;
    if (gte) where.occurredAt.gte = gte;
    if (lte) where.occurredAt.lte = lte;
  }
  if (sp.cursor) {
    try {
      where.id = { lt: BigInt(sp.cursor) };
    } catch {
      // ignore
    }
  }

  // P-1: aktive Filter? Nur dann ist ein exakter COUNT vertretbar; bei leerem
  // Filter wäre das ein Scan über den GANZEN Log → reltuples-Schätzung.
  const hasFilter = Boolean(sp.action || sp.actorType || sp.resourceType || sp.from || sp.to);

  const [entries, verifyRow, checkpointRow, resourceTypeRows, totalCount] = await withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) =>
      Promise.all([
        tx.auditLog.findMany({
          where,
          orderBy: { id: 'desc' },
          take: PAGE_SIZE + 1,
        }),
        // P-1: Chain-Verifikation läuft NICHT mehr im Render-Pfad (SHA-256 über
        // den kompletten Log; Sekunden bei 200k, P2028 ab ~500k). Hier nur das
        // vom täglichen Worker-Job (audit-verify-check) persistierte Ergebnis.
        tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId, key: AUDIT_VERIFY_RESULT_SETTING_KEY } },
        }),
        tx.tenantSetting.findUnique({
          where: { tenantId_key: { tenantId, key: AUDIT_RECOVERY_CHECKPOINT_SETTING_KEY } },
        }),
        // P-1: groupBy statt distinct — Prisma dedupliziert `distinct` ohne
        // nativeDistinct IN-MEMORY und überträgt dafür JEDE Zeile.
        tx.auditLog.groupBy({
          by: ['resourceType'],
          orderBy: { resourceType: 'asc' },
        }),
        hasFilter
          ? tx.auditLog.count({ where })
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

  const verifyResult = (verifyRow?.value ?? null) as PersistedVerifyResult | null;
  const checkpoint = (checkpointRow?.value ?? null) as PersistedRecoveryCheckpoint | null;
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

  // Headline-Schweregrad: ein gesetzter Recovery-Checkpoint ist das harte
  // Kill-Signal für den Break-Alarm — sobald gesetzt, zeigt die Seite bernstein
  // („historisch, abgegrenzt") statt rot. Reines Rot nur ohne Checkpoint. Der
  // Worker feuert in diesem Fall ebenfalls keine SYSTEM_AUDIT_BREAK-Notification
  // mehr und persists recovered=true.
  const recoveryIntact = !!checkpoint;
  const chainStatus: 'none' | 'ok' | 'amber' | 'red' = !verifyResult
    ? 'none'
    : verifyResult.ok
      ? 'ok'
      : recoveryIntact
        ? 'amber'
        : 'red';

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
  const baseQs = new URLSearchParams();
  if (sp.action) baseQs.set('action', sp.action);
  if (sp.actorType) baseQs.set('actorType', sp.actorType);
  if (sp.resourceType) baseQs.set('resourceType', sp.resourceType);
  if (sp.from) baseQs.set('from', sp.from);
  if (sp.to) baseQs.set('to', sp.to);
  const nextQs = new URLSearchParams(baseQs);
  if (nextCursor) nextQs.set('cursor', nextCursor);

  return (
    <div className="p-8">
      <AuditNotificationAcknowledger resultKey={auditOkResultKey(verifyResult)} />
      {pollVerify && <AuditVerifyAutoRefresh requestId={sp.requestId} queuedAt={sp.queuedAt} />}
      <div className="flex items-end justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-primary mb-1">Audit-Log</h1>
          <p className="text-muted text-sm">
            Hash-verkettete Aufzeichnung aller compliance-relevanten Operationen.
          </p>
        </div>
        <a
          href={`/api/staff/admin/audit/export${baseQs.toString() ? '?' + baseQs.toString() : ''}`}
          className="btn-secondary"
        >
          <FileDown className="h-4 w-4" />
          CSV exportieren
        </a>
      </div>

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
            ) : verifyResult.ok ? (
              <>
                <p className="text-sm font-medium text-green-900 dark:text-green-100">
                  Hash-Chain intakt — {verifyResult.checked.toLocaleString('de-DE')} Einträge
                  geprüft
                </p>
                <p className="text-xs text-green-700 mt-1 dark:text-green-200">
                  {verifyResult.sealsChecked} Tagesversiegelungen geprüft
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
                          <>
                            {' '}
                            Übrige nur kryptografisch (cryptoOk) — Produktiv-TSA-Root hinterlegen.
                          </>
                        )}
                      </>
                    )}
                  </p>
                )}
              </>
            ) : recoveryIntact ? (
              <>
                <p className="text-sm font-medium text-yellow-900 dark:text-yellow-100">
                  Historischer Chain-Befund — ab Recovery-Checkpoint fortlaufend geprüft
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
      <form
        action="/staff/admin/audit"
        method="get"
        className="card p-4 mb-6 grid grid-cols-2 md:grid-cols-5 gap-3"
      >
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
                  <td className="px-6 py-2 font-mono text-primary whitespace-nowrap">{e.action}</td>
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
              Ältere Einträge
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
