// =============================================================================
// GwG-Prüfung: gemeinsames Prelude aller ändernden Staff-Operationen an einer
// bearbeitbaren Prüfung (Review-Befund K-03; Web-Adapter seit K-01).
//
// Vorher in zwölf Server-Actions ausgeschrieben. Die Reihenfolge ist unverändert
// und für die Sperrordnung maßgeblich: Mandantenzugriff (hier) → Lifecycle-Lock
// des Mandanten → Prüfung laden (an den autorisierten Mandanten gebunden) →
// optionale fachliche Vorbedingung → Bearbeitbarkeit (§ 8 GwG) → Operation.
// Alles nach der Zugriffsprüfung liegt mit Tx-Signatur in @taxtronik/gwg
// (withLockedEditableGwgCheckTx); dessen fachliche Ablehnungen werden hier in
// UI-taugliche ActionErrors mit unveränderter Meldung übersetzt.
//
// Den Status-Claim (Rücknahme einer laufenden Freigabe) bzw. die No-op-CAS-
// Prüfung ruft die Operation über `mutation` selbst auf, weil zwischen
// Bearbeitbarkeit und Claim fachliche Prüfungen liegen, deren Meldungen
// Vorrang vor einem parallelen Statuswechsel haben.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import {
  withLockedEditableGwgCheckTx,
  type EditableGwgCheck,
  type EditableGwgCheckMutation,
  type GwgCheckSelectWithStatus,
  type LoadedGwgCheck,
} from '@taxtronik/gwg/check-lifecycle';
import { assertClientAccessTx } from '@/server/auth/rbac';
import type { StaffSession } from '@/server/auth/staff';
import { gwgCheckActionError } from './check-mutation';

export type {
  EditableGwgCheck,
  EditableGwgCheckMutation,
  GwgCheckSelectWithStatus,
  LoadedGwgCheck,
};

/** Handelnde Person einer Staff-Operation (entspricht dem withStaff-Kontext). */
export interface GwgStaffActor {
  tenantId: string;
  staffId: string;
  session: StaffSession;
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
  try {
    return await withLockedEditableGwgCheckTx(
      tx,
      { ...input, tenantId: actor.tenantId },
      operation,
    );
  } catch (error) {
    throw gwgCheckActionError(error);
  }
}
