// =============================================================================
// Autorisierungs-Guards der Subsumtions-Actions — GETEILT von actions.ts,
// research-actions.ts und norm-actions.ts. Bewusst OHNE 'use server': reine
// Helfer, keine Actions. Der AST-Guard (server-action-authz.test.ts) loest
// auth-tragende Helfer ueber relative Importe auf.
//
// EINE Tenant-Transaktion pro Guard: Ressource laden, Zugriff pruefen
// (canAccessClientTx), Rechtestufe laden und entscheiden — alles im selben
// withTenantContext. Vorher oeffnete jeder Schritt seine eigene Transaktion
// (Ressource / requireSubsumtionAccess / rightsFor), eine Write-Action kam so
// auf drei bis vier Transaktionen, die Ergebnis-Pruef-Actions auf fuenf.
// Jede Transaktion kostet BEGIN + set_config + COMMIT — reine Verwaltung.
// =============================================================================

import { ForbiddenError, requireStaffSession, canAccessClientTx } from '@/server/auth/rbac';
import type { ActionErrorResult } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import { withTenantContext, type TenantContext, type TxClient } from '@taxtronik/db';
import { readModules } from '@/server/settings/modules';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import {
  loadSubsumtionRights,
  decideSubsumtionAction,
  decideResultReview,
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

// Session + Tenant-Kontext OHNE per-Mandant-Prüfung — Basis aller Guards.
// `staffAuth` ist request-gecacht; Mehrfachaufrufe kosten nichts.
export async function sessionCtx(): Promise<{
  session: StaffSession;
  ctx: TenantContext;
  staffId: string;
}> {
  const session = await requireStaffSession();
  const { tenantId, staffId } = session.user;
  const ctx: TenantContext = { tenantId, actorId: staffId, actorType: 'STAFF' };
  await requireRiskModule(ctx);
  return { session, ctx, staffId };
}

/** Zugriff auf den Mandanten (OPEN-Default + Vertraulich-/RESTRICTED-Ventil). */
async function checkAccessTx(tx: TxClient, session: StaffSession, clientId: string): Promise<void> {
  if (!(await canAccessClientTx(tx, session, clientId))) {
    throw new ForbiddenError('Kein Zugriff auf diesen Mandanten.');
  }
}

/** Rechtestufe laden und `kind` durchsetzen — Fehlermeldungen wie gehabt. */
async function requireRightsTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
  analysisId: string | null,
  kind: SubsumtionActionKind,
  markingId?: string | null,
): Promise<SubsumtionRights> {
  const rights = await loadSubsumtionRights(tx, session, { clientId, analysisId });
  if (!decideSubsumtionAction(rights, kind, markingId)) {
    throw new ForbiddenError(
      kind === 'recherche'
        ? 'Recherche nur für die dir zugewiesene Markierung möglich.'
        : 'Nur Admin/Partner oder zuständige Berufsträger dürfen diese Subsumtion bearbeiten.',
    );
  }
  return rights;
}

// Gemeinsamer Guard: Zugang (Admin/Partner oder zuständig für DIESEN Mandanten) +
// aktives Modul. Nur für Aktionen, deren Subjekt der clientId selbst ist (z. B.
// „neue Analyse anlegen") — die clientId IST hier das autorisierte Ziel.
export async function guard(clientId: string): Promise<{ ctx: TenantContext; staffId: string }> {
  const { session, ctx, staffId } = await sessionCtx();
  await withTenantContext(ctx, (tx) => checkAccessTx(tx, session, clientId));
  return { ctx, staffId };
}

/** Wie `guard`, aber verlangt Schreibrecht am Mandanten — in derselben Tx. */
export async function guardWrite(
  clientId: string,
): Promise<{ ctx: TenantContext; staffId: string }> {
  const { session, ctx, staffId } = await sessionCtx();
  await withTenantContext(ctx, async (tx) => {
    await checkAccessTx(tx, session, clientId);
    await requireRightsTx(tx, session, clientId, null, 'schreiben');
  });
  return { ctx, staffId };
}

// Autorisiert über die ECHTE clientId der Analyse — nicht über einen vom Client
// gelieferten clientId. Verhindert IDOR (Zugriff auf fremde Mandanten desselben
// Tenants durch Spoofing der Payload-clientId).
async function analysisGuard(
  analysisId: string,
  kind: SubsumtionActionKind | null,
): Promise<GuardResult> {
  const { session, ctx, staffId } = await sessionCtx();
  const clientId = await withTenantContext(ctx, async (tx) => {
    const analysis = await tx.riskAnalysis.findUnique({
      where: { id: analysisId },
      select: { clientId: true, archivedAt: true },
    });
    if (!analysis?.clientId)
      throw new ForbiddenError('Analyse nicht gefunden oder ohne Mandantenbezug.');
    if (analysis.archivedAt)
      throw new ForbiddenError('Diese Subsumtion ist archiviert (schreibgeschützt).');
    await checkAccessTx(tx, session, analysis.clientId);
    if (kind) await requireRightsTx(tx, session, analysis.clientId, analysisId, kind);
    return analysis.clientId;
  });
  return { ctx, staffId, clientId };
}

export async function guardAnalysis(analysisId: string): Promise<GuardResult> {
  return analysisGuard(analysisId, null);
}

/** Wie `guardAnalysis`, aber verlangt Schreibrecht. */
export async function guardAnalysisWrite(analysisId: string): Promise<GuardResult> {
  return analysisGuard(analysisId, 'schreiben');
}

// Wie guardAnalysis, aber ausgehend von einer Markierung (leitet Analyse +
// Mandant ab). Liefert auch die analysisId für revalidatePath.
async function markingGuard(
  markingId: string,
  kind: SubsumtionActionKind | null,
): Promise<GuardResult & { analysisId: string }> {
  const { session, ctx, staffId } = await sessionCtx();
  const res = await withTenantContext(ctx, async (tx) => {
    const marking = await tx.riskMarking.findUnique({
      where: { id: markingId },
      select: { analysis: { select: { id: true, clientId: true, archivedAt: true } } },
    });
    const clientId = marking?.analysis.clientId;
    if (!clientId) throw new ForbiddenError('Markierung nicht gefunden oder ohne Mandantenbezug.');
    if (marking!.analysis.archivedAt)
      throw new ForbiddenError('Diese Subsumtion ist archiviert (schreibgeschützt).');
    await checkAccessTx(tx, session, clientId);
    if (kind) await requireRightsTx(tx, session, clientId, marking!.analysis.id, kind);
    return { clientId, analysisId: marking!.analysis.id };
  });
  return { ctx, staffId, ...res };
}

export async function guardMarking(
  markingId: string,
): Promise<GuardResult & { analysisId: string }> {
  return markingGuard(markingId, null);
}

/** Wie `guardMarking`, aber verlangt Schreibrecht. */
export async function guardMarkingWrite(
  markingId: string,
): Promise<GuardResult & { analysisId: string }> {
  return markingGuard(markingId, 'schreiben');
}

// Ausgehend von einem Rechercheergebnis (über Request bzw. Markierung → Analyse).
// `resultMarkingId` ist die Markierung, an der das Ergebnis HÄNGT (null =
// unzugeordnet) — die Prüf-Actions binden ihre Entscheidung daran.
interface ResultGuardResult extends GuardResult {
  analysisId: string | null;
  resultMarkingId: string | null;
}

async function resultGuard(
  resultId: string,
  kind: SubsumtionActionKind | null,
): Promise<ResultGuardResult> {
  const { session, ctx, staffId } = await sessionCtx();
  const res = await withTenantContext(ctx, async (tx) => {
    const result = await tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: {
        markingId: true,
        request: { select: { analysis: { select: { id: true, clientId: true } } } },
        marking: { select: { analysis: { select: { id: true, clientId: true } } } },
      },
    });
    const analysis = result?.request?.analysis ?? result?.marking?.analysis ?? null;
    if (!analysis?.clientId)
      throw new ForbiddenError('Ergebnis nicht gefunden oder ohne Mandantenbezug.');
    await checkAccessTx(tx, session, analysis.clientId);
    if (kind) await requireRightsTx(tx, session, analysis.clientId, analysis.id, kind);
    return {
      clientId: analysis.clientId,
      analysisId: analysis.id,
      resultMarkingId: result?.markingId ?? null,
    };
  });
  return { ctx, staffId, ...res };
}

export async function guardResult(resultId: string): Promise<ResultGuardResult> {
  return resultGuard(resultId, null);
}

/** Wie `guardResult`, aber verlangt Schreibrecht. */
export async function guardResultWrite(resultId: string): Promise<ResultGuardResult> {
  return resultGuard(resultId, 'schreiben');
}

/**
 * Prüfentscheidung an einem Rechercheergebnis (übernehmen/verwerfen) — die
 * komplette Kette in EINER Tx: Ergebnis laden, Mandantenzugriff, Recherche-
 * Recht an der mitgeschickten Markierung, Bindung ans ERGEBNIS
 * (`decideResultReview`) und der Ziel-Check „Markierung gehört zur selben
 * Analyse". Vorher verteilten die beiden Actions das auf vier Transaktionen —
 * und duplizierten die Bindungslogik.
 */
export async function guardResultReview(
  resultId: string,
  markingId: string,
  kind: 'uebernehmen' | 'verwerfen',
): Promise<GuardResult & { analysisId: string | null }> {
  const { session, ctx, staffId } = await sessionCtx();
  const res = await withTenantContext(ctx, async (tx) => {
    const result = await tx.riskResearchResult.findUnique({
      where: { id: resultId },
      select: {
        markingId: true,
        request: { select: { analysis: { select: { id: true, clientId: true } } } },
        marking: { select: { analysis: { select: { id: true, clientId: true } } } },
      },
    });
    const analysis = result?.request?.analysis ?? result?.marking?.analysis ?? null;
    if (!analysis?.clientId)
      throw new ForbiddenError('Ergebnis nicht gefunden oder ohne Mandantenbezug.');
    await checkAccessTx(tx, session, analysis.clientId);
    const rights = await requireRightsTx(
      tx,
      session,
      analysis.clientId,
      analysis.id,
      'recherche',
      markingId,
    );
    // Entscheidung ans ERGEBNIS binden, nicht nur an die mitgeschickte
    // markingId: sonst liesse sich mit der eigenen Markierung als Feigenblatt
    // das Ergebnis einer fremden Markierung derselben Analyse pruefen.
    if (!decideResultReview(rights, kind, result?.markingId ?? null, markingId)) {
      throw new ForbiddenError('Das Ergebnis gehört nicht zu deiner Markierung.');
    }
    // Ziel-Markierung muss zur SELBEN Analyse gehören — sonst liesse sich ein
    // Ergebnis quer auf eine fremde Markierung verlinken.
    const target = await tx.riskMarking.findUnique({
      where: { id: markingId },
      select: { analysisId: true },
    });
    if (!target || target.analysisId !== analysis.id) {
      throw new ForbiddenError('Markierung gehört nicht zu dieser Analyse.');
    }
    return { clientId: analysis.clientId, analysisId: analysis.id };
  });
  return { ctx, staffId, ...res };
}

/**
 * Vertraulichkeit setzen/aufheben — bewusst OHNE Archiv-Sperre (Zugriffs-,
 * keine Inhaltsentscheidung), sonst identisch zu `guardAnalysisWrite`.
 * Liefert den Ist-Zustand mit, damit die Action idempotent schreiben kann.
 */
export async function guardAnalysisVertraulich(
  analysisId: string,
): Promise<GuardResult & { vertraulich: boolean }> {
  const { session, ctx, staffId } = await sessionCtx();
  const res = await withTenantContext(ctx, async (tx) => {
    const analysis = await tx.riskAnalysis.findUnique({
      where: { id: analysisId },
      select: { clientId: true, vertraulich: true },
    });
    if (!analysis?.clientId)
      throw new ForbiddenError('Analyse nicht gefunden oder ohne Mandantenbezug.');
    await checkAccessTx(tx, session, analysis.clientId);
    await requireRightsTx(tx, session, analysis.clientId, analysisId, 'schreiben');
    return { clientId: analysis.clientId, vertraulich: analysis.vertraulich };
  });
  return { ctx, staffId, ...res };
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
  const { session, ctx, staffId } = await sessionCtx();
  const res = await withTenantContext(ctx, async (tx) => {
    const analysis = await tx.riskAnalysis.findUnique({
      where: { id: input.analysisId },
      select: { clientId: true, archivedAt: true },
    });
    if (!analysis?.clientId)
      throw new ForbiddenError('Analyse nicht gefunden oder ohne Mandantenbezug.');
    if (analysis.archivedAt)
      throw new ForbiddenError('Diese Subsumtion ist archiviert (schreibgeschützt).');
    await checkAccessTx(tx, session, analysis.clientId);

    const rights = await loadSubsumtionRights(tx, session, {
      clientId: analysis.clientId,
      analysisId: input.analysisId,
    });
    // Die Rechtelage geht als `scope` mit in den Auftragsbau — sie entscheidet
    // dort, wie viel Sachverhalt der Auszug tragen darf. Sie stammt aus dem
    // Guard, nie aus dem Client-Payload.
    const scope: ResearchScope = { volleAkteneinsicht: rights.canWrite };
    if (rights.canWrite) return { clientId: analysis.clientId, scope };

    if (!decideSubsumtionAction(rights, 'recherche', input.markingId)) {
      throw new ForbiddenError('Recherche nur für die dir zugewiesene Markierung möglich.');
    }
    if (input.sachverhalt === 'full') {
      throw new ForbiddenError(
        'Der gesamte Sachverhalt darf nur von zuständigen Berufsträgern an die KI gegeben werden.',
      );
    }
    return { clientId: analysis.clientId, scope };
  });
  return { ctx, staffId, ...res };
}

export function requireEngine(): void {
  if (!isRiskLayerConfigured()) {
    throw new Error('Die Risk-Engine ist nicht konfiguriert — Analyse derzeit nicht möglich.');
  }
}
