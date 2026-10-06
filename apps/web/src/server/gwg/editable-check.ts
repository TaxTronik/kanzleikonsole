// =============================================================================
// GwG-Prüfung: gemeinsames Prelude aller ändernden Staff-Operationen an einer
// bearbeitbaren Prüfung (Review-Befund K-03).
//
// Vorher in zwölf Server-Actions ausgeschrieben. Die Reihenfolge ist unverändert
// und für die Sperrordnung maßgeblich: Mandantenzugriff → Lifecycle-Lock des
// Mandanten → Prüfung laden (an den autorisierten Mandanten gebunden) →
// optionale fachliche Vorbedingung → Bearbeitbarkeit (§ 8 GwG) → Operation.
//
// Den Status-Claim (Rücknahme einer laufenden Freigabe) bzw. die No-op-CAS-
// Prüfung ruft die Operation über `mutation` selbst auf, weil zwischen
// Bearbeitbarkeit und Claim fachliche Prüfungen liegen, deren Meldungen
// Vorrang vor einem parallelen Statuswechsel haben.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import { ActionError } from '@/server/actions/action-error';
import { assertClientAccessTx } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import {
  assertGwgEditable,
  claimCheckMutation,
  confirmUnchangedCheck,
  type EditableGwgStatus,
} from './check-mutation';
import { lockGwgCheckLifecycleTx } from './reverification';

/** Handelnde Person einer Staff-Operation (entspricht dem withStaff-Kontext). */
export interface GwgStaffActor {
  tenantId: string;
  staffId: string;
  session: StaffSession;
}

export type GwgCheckSelectWithStatus = Prisma.GwgCheckSelect & { status: true };

export type LoadedGwgCheck<S extends GwgCheckSelectWithStatus> = Prisma.GwgCheckGetPayload<{
  select: S;
}> & { status: string };

export type EditableGwgCheck<S extends GwgCheckSelectWithStatus> = LoadedGwgCheck<S> & {
  status: EditableGwgStatus;
};

export interface EditableGwgCheckMutation {
  /** Status zum Zeitpunkt der Bearbeitbarkeitsprüfung (CAS-Erwartung). */
  readonly expectedStatus: EditableGwgStatus;
  /** Status-CAS vor der ersten Fachänderung; setzt eine laufende Freigabe auf DRAFT zurück. */
  claim(options?: { invalidateRisk?: boolean }): Promise<void>;
  /** CAS-Prüfung für echte No-op-Saves, ohne eine laufende Freigabe zurückzusetzen. */
  confirmUnchanged(): Promise<void>;
}

export interface EditableGwgCheckInput<S extends GwgCheckSelectWithStatus> {
  clientId: string;
  checkId: string;
  select: S;
  /**
   * Fachliche Vorbedingung, deren Meldung bisher vor der Bearbeitbarkeit kam
   * (z. B. Rechtsform des Mandanten). Bestehende Fehlerreihenfolge bleibt so erhalten.
   */
  beforeEditable?: (check: LoadedGwgCheck<S>) => void;
}

export async function withEditableGwgCheckTx<S extends GwgCheckSelectWithStatus, R>(
  tx: TxClient,
  actor: Pick<GwgStaffActor, 'tenantId' | 'session'>,
  input: EditableGwgCheckInput<S>,
  operation: (check: EditableGwgCheck<S>, mutation: EditableGwgCheckMutation) => Promise<R>,
): Promise<R> {
  await assertClientAccessTx(tx, actor.session, input.clientId);
  await lockGwgCheckLifecycleTx(tx, { tenantId: actor.tenantId, clientId: input.clientId });
  // Bindet checkId an den autorisierten Mandanten.
  const check = (await tx.gwgCheck.findFirst({
    where: { id: input.checkId, clientId: input.clientId },
    select: input.select,
  })) as LoadedGwgCheck<S> | null;
  if (!check) throw new ActionError('GwG-Check nicht gefunden.');
  input.beforeEditable?.(check);
  assertGwgEditable(check.status);
  const scope = {
    checkId: input.checkId,
    clientId: input.clientId,
    expectedStatus: check.status,
  };
  return operation(check as EditableGwgCheck<S>, {
    expectedStatus: check.status,
    claim: (options = {}) => claimCheckMutation(tx, { ...scope, ...options }),
    confirmUnchanged: () => confirmUnchangedCheck(tx, scope),
  });
}
