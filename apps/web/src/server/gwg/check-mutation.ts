// =============================================================================
// GwG-Prüfung: Bearbeitbarkeit und atomarer Status-Claim vor einer Änderung
// (Web-Adapter).
//
// K-01: Die Regeln liegen mit Tx-Signatur in @taxtronik/gwg (check-lifecycle).
// Dieses Modul übersetzt deren fachliche Ablehnungen (GwgCheckRuleError) in
// UI-taugliche ActionErrors mit unveränderter Meldung. Genutzt vom Prelude der
// GwG-Services (server/gwg/editable-check.ts) und der Strukturübernahme der
// Mandatserweiterung (server/mandate-expansion).
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import {
  assertGwgEditable as assertGwgEditableRule,
  claimCheckMutation as claimCheckMutationRule,
  confirmUnchangedCheck as confirmUnchangedCheckRule,
  GwgCheckRuleError,
  type EditableGwgStatus,
} from '@taxtronik/gwg/check-lifecycle';
import { ActionError } from '@/server/actions/action-error';

export type { EditableGwgStatus };

/** Fachliche Ablehnung des Pakets → ActionError (Meldung unverändert); alles andere unverändert. */
export function gwgCheckActionError(error: unknown): unknown {
  return error instanceof GwgCheckRuleError ? new ActionError(error.message) : error;
}

export function assertGwgEditable(status: string): asserts status is EditableGwgStatus {
  try {
    assertGwgEditableRule(status);
  } catch (error) {
    throw gwgCheckActionError(error);
  }
}

export async function claimCheckMutation(
  tx: TxClient,
  input: Parameters<typeof claimCheckMutationRule>[1],
): Promise<void> {
  try {
    await claimCheckMutationRule(tx, input);
  } catch (error) {
    throw gwgCheckActionError(error);
  }
}

/** CAS-Prüfung für echte No-op-Saves, ohne eine laufende Freigabe zurückzusetzen. */
export async function confirmUnchangedCheck(
  tx: TxClient,
  input: Parameters<typeof confirmUnchangedCheckRule>[1],
): Promise<void> {
  try {
    await confirmUnchangedCheckRule(tx, input);
  } catch (error) {
    throw gwgCheckActionError(error);
  }
}
