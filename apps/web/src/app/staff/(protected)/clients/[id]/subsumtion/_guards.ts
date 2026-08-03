// =============================================================================
// Autorisierungs-Guards der Subsumtions-Actions — GETEILT von actions.ts,
// research-actions.ts und norm-actions.ts. Bewusst OHNE 'use server': reine
// Helfer, keine Actions. Der AST-Guard (server-action-authz.test.ts) loest
// auth-tragende Helfer ueber relative Importe auf.
// =============================================================================

import {
  requireSubsumtionAccess,
  requireStaffSession,
  ForbiddenError,
  type ActionErrorResult,
} from '@/server/auth/rbac';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import {
  loadSubsumtionRights,
  decideSubsumtionAction,
  type SubsumtionRights,
  type SubsumtionActionKind,
} from '@/server/risk/rights';
import type { ResearchScope } from '@/server/risk';

export type OkActionResult<T = unknown> = ({ ok: true } & T) | ActionErrorResult;

export interface GuardResult {
  ctx: TenantContext;
  staffId: string;
  /** Der tatsächliche Mandant der Ressource (NICHT der Payload-clientId). */
  clientId: string;
}

export async function requireRiskModule(ctx: TenantContext): Promise<void> {
  const modules = await readModules(ctx);
  if (!modules.risk)
    throw new ForbiddenError('Das Subsumtions-Modul ist für diese Kanzlei deaktiviert.');
}

// Gemeinsamer Guard: Zugang (Admin/Partner oder zuständig für DIESEN Mandanten) +
// aktives Modul. Nur für Aktionen, deren Subjekt der clientId selbst ist (z. B.
// „neue Analyse anlegen") — die clientId IST hier das autorisierte Ziel.
export async function guard(clientId: string): Promise<{ ctx: TenantContext; staffId: string }> {
  const session = await requireSubsumtionAccess(clientId);
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  await requireRiskModule(ctx);
  return { ctx, staffId };
}

// Session + Tenant-Kontext OHNE per-Mandant-Prüfung — Basis für die Ressourcen-
// Guards (die den Mandanten erst aus der Ressource ableiten).
export async function sessionCtx(): Promise<{ ctx: TenantContext; staffId: string }> {
  const session = await requireStaffSession();
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  await requireRiskModule(ctx);
  return { ctx, staffId };
}

// Autorisiert über die ECHTE clientId der Analyse — nicht über einen vom Client
// gelieferten clientId. Verhindert IDOR (Zugriff auf fremde Mandanten desselben
// Tenants durch Spoofing der Payload-clientId).
export async function guardAnalysis(analysisId: string): Promise<GuardResult> {
  const { ctx, staffId } = await sessionCtx();
  const analysis = await withTenantContext(ctx, (tx) =>
    tx.riskAnalysis.findUnique({
      where: { id: analysisId },
      select: { clientId: true, archivedAt: true },
    }),
  );
  if (!analysis?.clientId)
    throw new ForbiddenError('Analyse nicht gefunden oder ohne Mandantenbezug.');
  if (analysis.archivedAt)
    throw new ForbiddenError('Diese Subsumtion ist archiviert (schreibgeschützt).');
  await requireSubsumtionAccess(analysis.clientId);
  return { ctx, staffId, clientId: analysis.clientId };
}

// Wie guardAnalysis, aber ausgehend von einer Markierung (leitet Analyse +
// Mandant ab). Liefert auch die analysisId für revalidatePath.
export async function guardMarking(
  markingId: string,
): Promise<GuardResult & { analysisId: string }> {
  const { ctx, staffId } = await sessionCtx();
  const marking = await withTenantContext(ctx, (tx) =>
    tx.riskMarking.findUnique({
      where: { id: markingId },
      select: { analysis: { select: { id: true, clientId: true, archivedAt: true } } },
    }),
  );
  const clientId = marking?.analysis.clientId;
  if (!clientId) throw new ForbiddenError('Markierung nicht gefunden oder ohne Mandantenbezug.');
  if (marking!.analysis.archivedAt)
    throw new ForbiddenError('Diese Subsumtion ist archiviert (schreibgeschützt).');
  await requireSubsumtionAccess(clientId);
  return { ctx, staffId, clientId, analysisId: marking!.analysis.id };
}

// Ausgehend von einem Rechercheergebnis (über Request bzw. Markierung → Analyse).
// `resultMarkingId` ist die Markierung, an der das Ergebnis HÄNGT (null =
// unzugeordnet) — die Prüf-Actions binden ihre Entscheidung daran.
export async function guardResult(
  resultId: string,
): Promise<GuardResult & { analysisId: string | null; resultMarkingId: string | null }> {
  const { ctx, staffId } = await sessionCtx();
  const result = await withTenantContext(ctx, (tx) =>
    tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: {
        markingId: true,
        request: { select: { analysis: { select: { id: true, clientId: true } } } },
        marking: { select: { analysis: { select: { id: true, clientId: true } } } },
      },
    }),
  );
  const analysis = result?.request?.analysis ?? result?.marking?.analysis ?? null;
  if (!analysis?.clientId)
    throw new ForbiddenError('Ergebnis nicht gefunden oder ohne Mandantenbezug.');
  await requireSubsumtionAccess(analysis.clientId);
  return {
    ctx,
    staffId,
    clientId: analysis.clientId,
    analysisId: analysis.id,
    resultMarkingId: result?.markingId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Schreib- und Recherche-Guards
//
// Die Guards oben klaeren nur „darf den Mandanten sehen". Wer hereinkam, durfte
// bislang ALLES: Markierungen anlegen, bewerten, loeschen, Kataloge kuratieren,
// den ganzen Fall an die KI schicken. Fuer eine Person, der lediglich ein
// Begriff zugewiesen wurde, ist das viel zu weit.
//
// Durchsetzung ausschliesslich hier: Server Actions sind direkte POSTs und
// laufen an jeder UI-Ausblendung vorbei.
// ---------------------------------------------------------------------------

export async function rightsFor(
  ctx: TenantContext,
  clientId: string,
  analysisId: string | null,
): Promise<SubsumtionRights> {
  const session = await requireStaffSession();
  return withTenantContext(ctx, (tx) =>
    loadSubsumtionRights(tx, session, { clientId, analysisId }),
  );
}

export async function assertMay(
  ctx: TenantContext,
  clientId: string,
  analysisId: string | null,
  kind: SubsumtionActionKind,
  markingId?: string | null,
): Promise<SubsumtionRights> {
  const rights = await rightsFor(ctx, clientId, analysisId);
  if (!decideSubsumtionAction(rights, kind, markingId)) {
    throw new ForbiddenError(
      kind === 'recherche'
        ? 'Recherche nur für die dir zugewiesene Markierung möglich.'
        : 'Nur Admin/Partner oder zuständige Berufsträger dürfen diese Subsumtion bearbeiten.',
    );
  }
  return rights;
}

/** Wie `guard`, aber verlangt Schreibrecht am Mandanten. */
export async function guardWrite(
  clientId: string,
): Promise<{ ctx: TenantContext; staffId: string }> {
  const base = await guard(clientId);
  await assertMay(base.ctx, clientId, null, 'schreiben');
  return base;
}

/** Wie `guardAnalysis`, aber verlangt Schreibrecht. */
export async function guardAnalysisWrite(analysisId: string): Promise<GuardResult> {
  const base = await guardAnalysis(analysisId);
  await assertMay(base.ctx, base.clientId, analysisId, 'schreiben');
  return base;
}

/** Wie `guardMarking`, aber verlangt Schreibrecht. */
export async function guardMarkingWrite(
  markingId: string,
): Promise<GuardResult & { analysisId: string }> {
  const base = await guardMarking(markingId);
  await assertMay(base.ctx, base.clientId, base.analysisId, 'schreiben');
  return base;
}

/** Wie `guardResult`, aber verlangt Schreibrecht. */
export async function guardResultWrite(
  resultId: string,
): Promise<GuardResult & { analysisId: string | null }> {
  const base = await guardResult(resultId);
  await assertMay(base.ctx, base.clientId, base.analysisId, 'schreiben');
  return base;
}

/**
 * Recherche-Auftrag (Vorschau wie Versand).
 *
 * Volle Stufe darf alles — auch den ganzen Sachverhalt an die KI geben. Wer
 * lediglich eine Markierung zugewiesen bekam, darf ausschliesslich zu DIESER
 * Markierung recherchieren und NICHT mit `sachverhalt: 'full'`: damit ginge der
 * komplette Fall inklusive aller fremden Markierungen nach draussen — genau die
 * Vollmacht, die hier eingeschraenkt wird.
 */
export async function guardResearch(input: {
  analysisId: string;
  markingId?: string | null;
  sachverhalt: 'custom' | 'excerpt' | 'full';
}): Promise<GuardResult & { scope: ResearchScope }> {
  const base = await guardAnalysis(input.analysisId);
  const rights = await rightsFor(base.ctx, base.clientId, input.analysisId);
  // Die Rechtelage geht als `scope` mit in den Auftragsbau — sie entscheidet
  // dort, wie viel Sachverhalt der Auszug tragen darf. Sie stammt aus dem
  // Guard, nie aus dem Client-Payload.
  const scope: ResearchScope = { volleAkteneinsicht: rights.canWrite };
  if (rights.canWrite) return { ...base, scope };

  if (!decideSubsumtionAction(rights, 'recherche', input.markingId)) {
    throw new ForbiddenError('Recherche nur für die dir zugewiesene Markierung möglich.');
  }
  if (input.sachverhalt === 'full') {
    throw new ForbiddenError(
      'Der gesamte Sachverhalt darf nur von zuständigen Berufsträgern an die KI gegeben werden.',
    );
  }
  return { ...base, scope };
}

export function requireEngine(): void {
  if (!isRiskLayerConfigured()) {
    throw new Error('Die Risk-Engine ist nicht konfiguriert — Analyse derzeit nicht möglich.');
  }
}
