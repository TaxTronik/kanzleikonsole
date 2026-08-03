// =============================================================================
// Beschafft die Fakten fuer die Subsumtions-Rechte.
//
// Die Entscheidungsregel selbst steht DB-frei in `lib/subsumtion-rights.ts`
// und wird von dort re-exportiert, damit Aufrufer nur einen Importpfad kennen.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { canWriteClientTx } from '@/server/auth/rbac';
import type { SubsumtionRights } from '@/lib/subsumtion-rights';

export {
  decideSubsumtionAction,
  decideResultReview,
  type SubsumtionRights,
  type SubsumtionActionKind,
} from '@/lib/subsumtion-rights';

/** Beschafft die beiden Fakten fuer `decideSubsumtionAction`. */
export async function loadSubsumtionRights(
  tx: TxClient,
  session: StaffSession,
  input: { clientId: string; analysisId?: string | null },
): Promise<SubsumtionRights> {
  const canWrite = await canWriteClientTx(tx, session, input.clientId);
  if (canWrite || !input.analysisId) {
    return { canWrite, assignedMarkingIds: [] };
  }
  const zugewiesen = await tx.riskMarking.findMany({
    where: { analysisId: input.analysisId, verantwortlichId: session.user.staffId },
    select: { id: true },
  });
  return { canWrite: false, assignedMarkingIds: zugewiesen.map((m) => m.id) };
}
