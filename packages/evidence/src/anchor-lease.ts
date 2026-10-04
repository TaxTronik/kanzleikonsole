// =============================================================================
// P-05: Tenant-Lease des Rolling-Anchor-Workers.
//
// Zwei Läufe dürfen für dieselbe Kettenspitze nie gleichzeitig ein RFC-3161-
// Token anfordern. Statt einer während des TSA-HTTP-Aufrufs offenen
// Owner-Transaktion (hielt eine Pool-Verbindung, langsame TSAs blockierten so
// andere Jobs) beansprucht der Worker einen kurz committeten Lease mit
// Ablaufzeit (`audit_anchor_lease`):
//
// 1. claim   — eigene Zeile anlegen oder eine abgelaufene übernehmen;
// 2. confirm — unmittelbar vor der TSA-Anfrage prüfen und verlängern;
// 3. TSA-Anfrage ohne gehaltene Transaktion oder Verbindung (Timeout 10 s);
// 4. confirm — nach der Antwort erneut; ist der Lease abgelaufen oder
//    übernommen, wird das Token verworfen;
// 5. bedingtes Insert, nur solange der Lease noch gilt;
// 6. Status speichern (settle), dann release.
//
// Ein anderer Lauf kann den Lease erst nach Freigabe oder nach Ablauf der
// Lease-Dauer übernehmen. Die Dauer (30 s) liegt über dem Timeout der
// TSA-Anfrage; ein abgestürzter Halter blockiert die Verankerung des Tenants,
// auch für Rechnungs- und GwG-Einträge, höchstens so lange. Dauert eine Anfrage
// dennoch länger, verwerfen Schritt 4 und 5 ihr Token: Es wird nie unter einem
// abgelaufenen Lease gespeichert.
// =============================================================================

import { randomUUID } from 'node:crypto';
import {
  TsaAnchorError,
  type AnchorLatestResult,
  type EvidenceService,
  type EvidenceTx,
} from './service';

/** Lease-Dauer: 10-s-Timeout der TSA-Anfrage plus Reserve. */
export const ANCHOR_LEASE_TTL_MS = 30_000;

export interface AnchorLease {
  readonly tenantId: string;
  readonly holder: string;
  /** Prüft und verlängert den Lease; false = abgelaufen oder übernommen. */
  confirm(): Promise<boolean>;
  /** Gibt den eigenen Lease frei (sonst läuft er ab). */
  release(): Promise<void>;
}

/**
 * Beansprucht den Lease des Tenants in einer eigenen, sofort committeten
 * Anweisung. null = ein anderer Lauf hält einen noch gültigen Lease.
 */
export async function claimAnchorLease(
  db: EvidenceTx,
  tenantId: string,
  ttlMs: number = ANCHOR_LEASE_TTL_MS,
): Promise<AnchorLease | null> {
  const holder = randomUUID();
  const rows = await db.$queryRaw<Array<{ holder: string }>>`
    INSERT INTO audit_anchor_lease (tenant_id, holder, acquired_at, expires_at)
    VALUES (
      ${tenantId}::uuid, ${holder}::uuid, clock_timestamp(),
      clock_timestamp() + ${ttlMs}::int * interval '1 millisecond'
    )
    ON CONFLICT (tenant_id) DO UPDATE
      SET holder = EXCLUDED.holder,
          acquired_at = EXCLUDED.acquired_at,
          expires_at = EXCLUDED.expires_at
      WHERE audit_anchor_lease.expires_at <= clock_timestamp()
    RETURNING holder::text AS holder
  `;
  if (rows[0]?.holder !== holder) return null;
  return {
    tenantId,
    holder,
    confirm: async () =>
      (await db.$executeRaw`
        UPDATE audit_anchor_lease
        SET expires_at = clock_timestamp() + ${ttlMs}::int * interval '1 millisecond'
        WHERE tenant_id = ${tenantId}::uuid
          AND holder = ${holder}::uuid
          AND expires_at > clock_timestamp()
      `) === 1,
    release: async () => {
      await db.$executeRaw`
        DELETE FROM audit_anchor_lease
        WHERE tenant_id = ${tenantId}::uuid AND holder = ${holder}::uuid
      `;
    },
  };
}

/** Ausgang eines Verankerungsversuchs. */
export type AnchorAttempt =
  /** Ein anderer Lauf hält den Lease: keine TSA-Anfrage. */
  | { status: 'locked' }
  | { status: 'done'; result: AnchorLatestResult }
  /** TSA-Anfrage oder Token-Prüfung gescheitert: zählt für den Backoff. */
  | { status: 'tsa-failed'; error: TsaAnchorError }
  /** Datenbank-, Pool- oder sonstiger Fehler: kein TSA-Backoff. */
  | { status: 'failed'; error: unknown };

export type SettledAnchorAttempt = Exclude<AnchorAttempt, { status: 'locked' }>;

/**
 * Verankert die aktuelle Kettenspitze unter dem Tenant-Lease. `settle` läuft
 * noch unter dem Lease (Statusspeicherung ohne Überschreiben durch einen
 * parallelen Lauf); erst danach wird der Lease freigegeben.
 */
export async function anchorLatestWithLease(
  service: EvidenceService,
  db: EvidenceTx,
  tenantId: string,
  opts: { requireTrustAnchor?: boolean; leaseTtlMs?: number } = {},
  settle?: (attempt: SettledAnchorAttempt) => Promise<void>,
): Promise<AnchorAttempt> {
  const anchorOpts = { requireTrustAnchor: opts.requireTrustAnchor };
  if (service.tsaMode !== 'rfc3161') {
    // Lokaler Adapter: keine TSA-Anfrage, also kein Lease nötig.
    const attempt = await attemptAnchor(() => service.anchorLatest(db, tenantId, anchorOpts));
    await settle?.(attempt);
    return attempt;
  }
  let lease: AnchorLease | null;
  try {
    lease = await claimAnchorLease(db, tenantId, opts.leaseTtlMs);
  } catch (error) {
    return { status: 'failed', error };
  }
  if (!lease) return { status: 'locked' };
  const held = lease;
  try {
    const attempt = await attemptAnchor(() =>
      service.anchorLatest(db, tenantId, { ...anchorOpts, lease: held }),
    );
    await settle?.(attempt);
    return attempt;
  } finally {
    // Scheitert die Freigabe, läuft der Lease nach seiner Dauer ab.
    await held.release().catch(() => undefined);
  }
}

async function attemptAnchor(
  run: () => Promise<AnchorLatestResult>,
): Promise<SettledAnchorAttempt> {
  try {
    return { status: 'done', result: await run() };
  } catch (error) {
    return error instanceof TsaAnchorError
      ? { status: 'tsa-failed', error }
      : { status: 'failed', error };
  }
}
