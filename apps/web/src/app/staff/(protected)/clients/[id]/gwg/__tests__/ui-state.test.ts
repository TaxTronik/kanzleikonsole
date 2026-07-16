import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const gwgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolve(gwgRoot, file), 'utf8');

describe('lokaler GwG-Bearbeitungszustand', () => {
  it('behält die Ausweisprüfung nach dem Speichern aufgeklappt und setzt die Revision lokal fort', () => {
    const source = read('identity-document-review.tsx');

    expect(source).not.toContain('router.refresh()');
    expect(source).toContain('setExpanded(true);');
    expect(source).toContain('invalidatedRevision ??');
    expect(source).toContain(
      'acknowledgeIdentitySet(group.documentSetId, submittedInvalidationGeneration.current)',
    );
    expect(source).toContain('localState.confirmedRevision === localState.revision');
    expect(source).toContain('reconcileIdentityReviewServerState(');
    expect(source).toContain('key={group.documentSetId}');
    expect(source).toContain('if (state.reviewReset) markDraft()');
  });

  it('führt Vertreter als strukturierte Personen statt als Mehrzeilen-Freitext', () => {
    const source = read('legal-entity-details-form.tsx');

    expect(source).toContain('name="representativesJson"');
    expect(source).toContain('Bereits angelegte Person auswählen');
    expect(source).toContain('Neue Person anlegen');
    expect(source).not.toContain('name="representativeNamesText"');
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

    expect(decisionForms).toContain('if (submitState?.ok) markInReview();');
    expect(decisionForms).toContain("status === 'IN_REVIEW' && reviewSnapshotHash");
    expect(decisionForms).toContain('Die gebundene Prüfansicht wird aktualisiert');
  });
});
