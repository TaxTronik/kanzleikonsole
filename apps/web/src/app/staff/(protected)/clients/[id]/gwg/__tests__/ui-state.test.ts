import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const gwgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolve(gwgRoot, file), 'utf8');

describe('lokaler GwG-Bearbeitungszustand', () => {
  it('behält die Ausweisprüfung nach dem Speichern aufgeklappt und setzt die Revision lokal fort', () => {
    const source = read('identity-document-review.tsx');
    const stateHook = read('use-identity-review-state.ts');

    // Das SPEICHERN der Ausweisangaben (updateIdDocumentsAction) gleicht den
    // Zustand weiterhin lokal über den Reducer ab (kein Refresh im Save-Pfad).
    // Der Refresh existiert nur im Erweitern-Effekt (extendIdentityDocument-
    // SetAction), dessen Action die aktuelle Route bewusst nicht mehr
    // revalidiert — sonst hing die Form-Transition bis zum nächsten Klick.
    expect(source).toContain('setExpanded(true);');
    expect(source).toContain('invalidatedRevision ??');
    expect(source).toContain('useIdentityReviewState({');
    expect(source).toContain('markSubmitted(');
    expect(source).toContain('localState.confirmedRevision === localState.revision');
    expect(source).toContain('key={group.documentSetId}');
    expect(stateHook).toContain('identityReviewStateReducer');
    expect(stateHook).toContain('reconcileIdentityReviewServerState(');
    expect(stateHook).toContain('onAcknowledgeInvalidation(');
    expect(stateHook).toContain('if (actionState.reviewReset) onReviewReset()');
  });

  it('führt Vertreter als strukturierte Personen statt als Mehrzeilen-Freitext', () => {
    const legalDetails = read('legal-entity-details-form.tsx');
    const roles = read('person-roles-panel.tsx');
    const newPerson = read('new-gwg-person-form.tsx');
    const addOwnerRole = read('add-beneficial-owner-role-form.tsx');

    expect(legalDetails).toContain('name="representativesJson"');
    expect(roles).toContain('name="representativesJson"');
    expect(roles).toContain('können hier nicht frei eingegeben werden');
    expect(roles).toContain('<Pencil className="h-3.5 w-3.5" /> Bearbeiten');
    expect(roles).toContain('defaultOpen');
    expect(roles).toContain('setAddOwnerRole(event.target.checked)');
    expect(addOwnerRole).toContain('addBeneficialOwnerRoleAction');
    expect(addOwnerRole).toContain('Doppelrolle speichern');
    expect(roles).not.toContain('name="fullName"');
    expect(newPerson).toContain('name="fullName"');
    expect(newPerson).toContain('Neue Person erfassen');
    expect(legalDetails).not.toContain('name="representativeNamesText"');
    expect(roles).not.toContain('name="representativeNamesText"');
  });

  it('aktualisiert Kopfstatus und Owner-Zusammenfassung ohne Seitenreload', () => {
    const page = read('page.tsx');
    const editState = read('edit-state-context.tsx');
    const owner = read('beneficial-owner-form.tsx');

    expect(page).toContain("initialStatus={check?.status ?? 'DRAFT'}");
    expect(page).toContain('<GwgLiveStatusBadge />');
    expect(editState).toContain("const markDraft = useCallback(() => setStatus('DRAFT')");
    expect(editState).toContain('if (lastServerStatus.current === initialStatus) return;');
    expect(editState).toContain("const markInReview = useCallback(() => setStatus('IN_REVIEW')");
    expect(owner).toContain('setDisplayValue(state.saved)');
    expect(owner).toContain('{displayValue.fullName}');
  });

  it('wechselt nach erfolgreicher Einreichung sofort live auf IN_REVIEW', () => {
    const decisionForms = read('decision-forms.tsx');

    expect(decisionForms).toContain('if (!submitState?.ok) return;');
    expect(decisionForms).toContain('markInReview();');
    // Frischer reviewSnapshotHash kommt über router.refresh() außerhalb der
    // Form-Transition (Action revalidiert die aktuelle Route nicht mehr).
    expect(decisionForms).toContain('router.refresh();');
    expect(decisionForms).toContain("status === 'IN_REVIEW' && reviewSnapshotHash");
    expect(decisionForms).toContain('Die gebundene Prüfansicht wird aktualisiert');
  });

  it('aktualisiert die Notification-Glocke nach einer GwG-Entscheidung sofort', () => {
    const decisionForms = read('decision-forms.tsx');

    expect(decisionForms).toContain(
      "import { emitNotificationsChanged } from '@/lib/live-events';",
    );
    expect(decisionForms.match(/emitNotificationsChanged\(\);/g)).toHaveLength(2);
  });
});
