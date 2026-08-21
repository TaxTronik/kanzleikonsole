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

import { createHash } from 'node:crypto';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import {
  RiskLayerClient,
  RiskLayerHttpError,
  type KatalogReviewStatus,
} from '@taxtronik/risk-layer';
import { evidenceService } from '@/server/container';
import { ActionError } from '@/server/actions/action-error';

/** Minimaler Client-Vertrag für DI/Tests. */
export type ReviewCapableClient = Pick<RiskLayerClient, 'katalogReview'>;

export class CatalogReviewFailedError extends ActionError {
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

export interface CatalogMarkingRef {
  id: string;
  begriffId: string | null;
}

interface CatalogDefinitionAuditRow {
  resourceId: string | null;
  after: unknown;
}

/**
 * Ordnet nur solche Markierungen dem Review-Lebenszyklus zu, fuer die
 * TaxTronik nachweislich einen GETEILTEN Berater-Eintrag angelegt hat.
 * Eine normale Engine-Katalog-ID ist bereits kanonisch und nicht reviewbar.
 */
export function reviewableCatalogMarkingIds(
  markings: CatalogMarkingRef[],
  definitions: CatalogDefinitionAuditRow[],
): Set<string> {
  const currentCatalogId = new Map(markings.map((marking) => [marking.id, marking.begriffId]));
  const result = new Set<string>();
  for (const definition of definitions) {
    if (!definition.resourceId) continue;
    const after = definition.after;
    if (!after || typeof after !== 'object' || Array.isArray(after)) continue;
    const payload = after as { begriffId?: unknown; scope?: unknown };
    if (
      payload.scope === 'geteilt' &&
      typeof payload.begriffId === 'string' &&
      currentCatalogId.get(definition.resourceId) === payload.begriffId
    ) {
      result.add(definition.resourceId);
    }
  }
  return result;
}

export async function loadReviewableCatalogMarkingIds(
  ctx: TenantContext,
  markings: CatalogMarkingRef[],
): Promise<Set<string>> {
  if (markings.length === 0) return new Set();
  const definitions = await withTenantContext(ctx, (tx) =>
    tx.auditLog.findMany({
      where: {
        tenantId: ctx.tenantId,
        action: 'risk.catalog.defined',
        resourceType: 'risk_marking',
        resourceId: { in: markings.map((marking) => marking.id) },
      },
      select: { resourceId: true, after: true },
    }),
  );
  return reviewableCatalogMarkingIds(markings, definitions);
}

/** Zieht einen fachlichen Fehler aus 400/422-Antworten der Engine. */
function fehlerAusBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const response = parsed as { fehler?: unknown; error?: unknown };
    const fehler = response.fehler ?? response.error;
    if (typeof fehler === 'string' && fehler) return fehler;
  } catch {
    // kein JSON → Rohtext unten
  }
  return body.slice(0, 200) || 'Die Engine hat den Review-Übergang abgelehnt.';
}

/**
 * Stabiles, mandantengebundenes Actor-Tag fuer die Signal-Auditspur.
 *
 * Signal darf wegen § 203 weder die Staff-UUID noch einen Namen persistieren.
 * Die lokale TaxTronik-Chain behaelt den echten actorId; nach aussen geht nur
 * ein nicht umkehrbares Tag. Die Hex-Ziffern werden auf Buchstaben abgebildet,
 * damit ein rein numerischer Hash-Ausschnitt nicht als Telefon-/Steuernummer
 * fehlklassifiziert werden kann.
 */
export function riskReviewActorTag(tenantId: string, actorId: string): string {
  const digest = createHash('sha256')
    .update('risk-review-actor:v1\0')
    .update(tenantId)
    .update('\0')
    .update(actorId)
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9]/g, (digit) => String.fromCharCode('g'.charCodeAt(0) + Number(digit)));
  return `tt_staff_${digest}`;
}

/**
 * Schaltet den Review-Status eines geteilten Berater-Eintrags vorwärts und
 * verankert den Übergang in der Hash-Chain. Signal erhaelt fuer `pruefer` nur
 * ein stabiles Pseudonym; die lokale Chain kennt weiterhin ctx.actorId.
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
        AND: [
          { after: { path: ['begriffId'], equals: input.begriffId } },
          { after: { path: ['scope'], equals: 'geteilt' } },
        ],
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
  const prueferTag = ctx.actorId ? riskReviewActorTag(ctx.tenantId, ctx.actorId) : undefined;
  let res;
  try {
    res = await c.katalogReview({
      id: input.begriffId,
      status: input.status,
      pruefer: prueferTag,
    });
  } catch (e) {
    // Lebenszyklus-Ablehnung (400) und Geheimnisschutz-/Formfehler (422) als
    // sichere Domänenfehler weiterreichen statt sie im UI zu verschleiern.
    if (e instanceof RiskLayerHttpError && (e.status === 400 || e.status === 422)) {
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
      // Die lokale Chain darf den echten Actor referenzieren. Signal selbst
      // persistiert ausschliesslich das oben erzeugte Pseudonym.
      after: { reviewStatus: neuerStatus, pruefer: ctx.actorId },
    }),
  );
  return { alterStatus, neuerStatus };
}
