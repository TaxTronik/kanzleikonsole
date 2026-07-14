// =============================================================================
// Markierungs-Mutationen (tenant-scoped, RLS).
//
// Berater-Bearbeitung der vom Engine erkannten Stellen: Governance-Matrix,
// Status, Notiz, Verantwortlichkeit setzen; eigene (BERATER-)Markierungen
// anlegen; Markierungen löschen.
//
// Jede Mutation wird im SELBEN Tx in der TaxTronik-Hash-Chain (audit_log)
// verankert — die Bewertung schuldet der Berufsträger höchstpersönlich, also
// muss sie manipulationsevident protokolliert sein. Die Engine führt KEIN Audit.
// =============================================================================

import { withTenantContext, type TenantContext } from '@taxtronik/db';
import type { GovernanceTyp, RiskStufe, RiskWk } from '@taxtronik/risk-layer';
import { evidenceService } from '@/server/container';

export type RiskStatus = 'OFFEN' | 'IN_PRUEFUNG' | 'KONTROLLIERT' | 'AKZEPTIERT';

/** Berater-editierbare Felder einer Markierung. `undefined` = unverändert. */
export interface UpdateMarkingInput {
  governanceTyp?: GovernanceTyp | null;
  schadensintensitaet?: RiskStufe | null;
  wahrscheinlichkeit?: RiskWk | null;
  kaskadenreichweite?: number | null;
  kontrolle?: string | null;
  status?: RiskStatus;
  notiz?: string | null;
  verantwortlichId?: string | null;
  farbe?: string | null;
  label?: string | null;
}

const DECISION_SELECT = {
  analysisId: true,
  begriff: true,
  governanceTyp: true,
  schadensintensitaet: true,
  wahrscheinlichkeit: true,
  kaskadenreichweite: true,
  kontrolle: true,
  status: true,
  notiz: true,
  verantwortlichId: true,
  farbe: true,
  label: true,
} as const;

export async function updateMarking(
  ctx: TenantContext,
  markingId: string,
  fields: UpdateMarkingInput,
): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    const before = await tx.riskMarking.findUnique({
      where: { id: markingId },
      select: DECISION_SELECT,
    });
    if (!before) throw new Error('Markierung nicht gefunden.');
    // Verantwortliche:r muss aktiver Mitarbeiter DIESES Tenants sein (keine
    // hängende Zuweisung an fremde/ungültige Staff-IDs).
    if (fields.verantwortlichId) {
      const ok = await tx.staffUser.findFirst({
        where: { id: fields.verantwortlichId, tenantId: ctx.tenantId, active: true },
        select: { id: true },
      });
      if (!ok) throw new Error('Verantwortliche:r nicht gefunden oder inaktiv.');
    }
    await tx.riskMarking.update({ where: { id: markingId }, data: fields });
    // undefined = unverändert → für den after-Snapshot herausfiltern.
    const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.marking.decided',
      resourceType: 'risk_marking',
      resourceId: markingId,
      before,
      after: { ...before, ...changed },
    });
  });
}

export interface AddManualMarkingInput {
  analysisId: string;
  start: number;
  end: number;
  begriff: string;
  normAnker?: string[];
  farbe?: string | null;
  label?: string | null;
  notiz?: string | null;
}

export class InvalidMarkingRangeError extends Error {
  constructor() {
    super('Die Markierung liegt außerhalb des Sachverhalts.');
    this.name = 'InvalidMarkingRangeError';
  }
}

/** Legt eine berater-gesetzte Markierung an (Herkunft BERATER). */
export async function addManualMarking(
  ctx: TenantContext,
  input: AddManualMarkingInput,
): Promise<{ markingId: string }> {
  const marking = await withTenantContext(ctx, async (tx) => {
    // matchedText + Offsets NICHT vom Client übernehmen, sondern aus dem
    // gespeicherten Sachverhalt ableiten — die Markierung muss den analysierten
    // Text 1:1 abbilden (TCMS-/Audit-Treue), und die Offsets müssen im Text liegen.
    const analysis = await tx.riskAnalysis.findUnique({
      where: { id: input.analysisId },
      select: { sourceText: true },
    });
    if (!analysis) throw new Error('Analyse nicht gefunden.');
    const len = analysis.sourceText.length;
    if (!Number.isInteger(input.start) || !Number.isInteger(input.end))
      throw new InvalidMarkingRangeError();
    if (input.start < 0 || input.end > len || input.end <= input.start)
      throw new InvalidMarkingRangeError();
    const matchedText = analysis.sourceText.slice(input.start, input.end);

    const created = await tx.riskMarking.create({
      data: {
        tenantId: ctx.tenantId,
        analysisId: input.analysisId,
        start: input.start,
        end: input.end,
        matchedText,
        herkunft: 'BERATER',
        engineStatus: 'berater',
        begriff: input.begriff,
        normAnker: input.normAnker ?? [],
        farbe: input.farbe ?? null,
        label: input.label ?? null,
        notiz: input.notiz ?? null,
        status: 'OFFEN',
      },
      select: { id: true },
    });

    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.marking.created',
      resourceType: 'risk_marking',
      resourceId: created.id,
      after: {
        analysisId: input.analysisId,
        herkunft: 'BERATER',
        begriff: input.begriff,
        matchedText,
        start: input.start,
        end: input.end,
        normAnker: input.normAnker ?? [],
      },
    });
    return created;
  });
  return { markingId: marking.id };
}

export async function deleteMarking(ctx: TenantContext, markingId: string): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    const before = await tx.riskMarking.findUnique({
      where: { id: markingId },
      select: { analysisId: true, herkunft: true, begriff: true, start: true, end: true },
    });
    if (!before) throw new Error('Markierung nicht gefunden.');
    await tx.riskMarking.delete({ where: { id: markingId } });
    await evidenceService.record(tx, {
      tenantId: ctx.tenantId,
      actorType: 'STAFF',
      actorId: ctx.actorId,
      action: 'risk.marking.deleted',
      resourceType: 'risk_marking',
      resourceId: markingId,
      before,
    });
  });
}
