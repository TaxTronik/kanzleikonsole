// =============================================================================
// Gemeinsame Typen und Helfer der GwG-Actions dieser Route (actions.ts,
// owner-actions.ts, id-document-actions.ts). Bewusst OHNE 'use server'.
//
// Seit Review-Befund K-03 liegt die Fachlogik als Services mit Tx-Signatur in
// server/gwg (Prelude: editable-check.ts; Lebenszyklus: check-mutation.ts;
// Ausweissätze: identity-document-*.ts; Personen: persons.ts,
// beneficial-owners.ts). Dieses Modul hält die stabilen Importpfade der
// Form-Komponenten und Actions.
// =============================================================================

import { type ActionResult as BaseActionResult } from '@/server/actions/staff-action';

export { isPersonalIdType, PERSONAL_ID_TYPES } from '@/server/gwg/identity-document-validation';
export type { InvalidatedIdentitySet } from '@/server/gwg/invalidated-identity-sets';
export type { SavedBeneficialOwner } from '@/server/gwg/beneficial-owners';

// Einheitliches Action-Ergebnis aus der zentralen Quelle — der bestehende
// Import-Pfad './actions' bleibt für die Form-Komponenten stabil.
export type ActionResult = BaseActionResult;
