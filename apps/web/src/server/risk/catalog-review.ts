// =============================================================================
// Katalog-Review: Freigabe-Lebenszyklus des geteilten Festwissens (§4, Engine
// 1.1.0). Ein geteilter Berater-Eintrag wird erst mit `freigegeben` kanonisch;
// der Übergang (entwurf → geprüft → freigegeben, nur vorwärts) läuft IMMER über
// `POST /v1/katalog/review` — die Engine auditiert nicht, deshalb nennt ihre
// Antwort den vollständigen Übergang, den TaxTronik hier in der Audit-Chain
// verankert.
//
// Reihenfolge wie catalog-norms.ts: Engine-Call (außerhalb jeder Tx) → erst bei
// Erfolg Audit (Tx). Lehnt die Engine ab (Rückwärts-Übergang, unbekannte oder
// nicht-geteilte id), wird NICHT auditiert.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import {
  RiskLayerClient,
  RiskLayerHttpError,
  type KatalogReviewStatus,
} from '@taxtronik/risk-layer';
import { evidenceService } from '@/server/container';

/** Minimaler Client-Vertrag für DI/Tests. */
export type ReviewCapableClient = Pick<RiskLayerClient, 'katalogReview'>;

export class CatalogReviewFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogReviewFailedError';
  }
}

export interface KatalogReviewInput {
  /** Engine-ID des GETEILTEN Berater-Eintrags (Katalog-Begriff). */
  begriffId: string;
  /** Zielstatus — die Engine erzwingt Nur-vorwärts. */
  status: KatalogReviewStatus;
}

export interface KatalogReviewResult {
  alterStatus: string;
  neuerStatus: string;
}

/** Zieht `fehler` aus dem 400-Body der Engine (`{ok:false, fehler}`). */
function fehlerAusBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const fehler = (parsed as { fehler?: unknown }).fehler;
    if (typeof fehler === 'string' && fehler) return fehler;
  } catch {
    // kein JSON → Rohtext unten
  }
  return body.slice(0, 200) || 'Die Engine hat den Review-Übergang abgelehnt.';
}

/**
 * Schaltet den Review-Status eines geteilten Berater-Eintrags vorwärts und
 * verankert den Übergang in der Hash-Chain. `pruefer` ist der handelnde
 * StaffUser (ctx.actorId) — die Engine spiegelt ihn in der Antwort zurück.
 *
 * Vier-Augen-Prinzip (TCMS): der AUTOR eines Begriffs darf den eigenen
 * Eintrag nicht selbst weiterschalten. Die Engine kennt den Autor nur als
 * Freitext-Tag — beweissicher steht er in UNSERER Audit-Chain
 * (`risk.catalog.defined`, after.begriffId). Begriffe ohne solchen Eintrag
 * (direkt in der Engine kuratiert) haben keinen bekannten Autor → keine
 * Sperre möglich, der Lebenszyklus bleibt nutzbar.
 */
export async function setKatalogReviewStatus(
  ctx: TenantContext,
  input: KatalogReviewInput,
  client?: ReviewCapableClient,
): Promise<KatalogReviewResult> {
  const defined = await withTenantContext(ctx, (tx) =>
    tx.auditLog.findFirst({
      where: {
        tenantId: ctx.tenantId,
        action: 'risk.catalog.defined',
        after: { path: ['begriffId'], equals: input.begriffId },
      },
      orderBy: { occurredAt: 'asc' },
      select: { actorId: true },
    }),
  );
  if (defined?.actorId && defined.actorId === ctx.actorId) {
    throw new CatalogReviewFailedError(
      'Vier-Augen-Prinzip: Sie haben diesen Begriff selbst definiert — der Review-Übergang muss von einer zweiten Person erfolgen.',
    );
  }

  const c = client ?? new RiskLayerClient();
  let res;
  try {
    res = await c.katalogReview({
      id: input.begriffId,
      status: input.status,
      pruefer: ctx.actorId ?? undefined,
    });
  } catch (e) {
    // Lebenszyklus-Ablehnung kommt als HTTP 400 mit {ok:false, fehler} → als
    // Domänenfehler weiterreichen (UI-tauglicher Text statt Transportfehler).
    if (e instanceof RiskLayerHttpError && e.status === 400) {
      throw new CatalogReviewFailedError(fehlerAusBody(e.body));
    }
    throw e;
  }
  if (!res.ok) {
    throw new CatalogReviewFailedError(
      res.fehler || 'Die Engine hat den Review-Übergang abgelehnt.',
    );
  }

  const alterStatus = res.alter_status ?? 'unbekannt';
  const neuerStatus = res.neuer_status ?? input.status;
  await withTenantContext(ctx, (tx) =>
    evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.catalog.reviewed',
      resourceType: 'risk_catalog',
      resourceId: input.begriffId,
      before: { reviewStatus: alterStatus },
      after: { reviewStatus: neuerStatus, pruefer: res.pruefer ?? ctx.actorId },
    }),
  );
  return { alterStatus, neuerStatus };
}
