import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

function section(contents: string, start: string, end?: string): string {
  const startAt = contents.indexOf(start);
  expect(startAt, `Startmarker fehlt: ${start}`).toBeGreaterThanOrEqual(0);
  const endAt = end ? contents.indexOf(end, startAt + start.length) : contents.length;
  expect(endAt, `Endmarker fehlt: ${end ?? '<EOF>'}`).toBeGreaterThan(startAt);
  return contents.slice(startAt, endAt);
}

function expectOrdered(contents: string, ...needles: string[]): void {
  let cursor = -1;
  for (const needle of needles) {
    const next = contents.indexOf(needle, cursor + 1);
    expect(next, `Reihenfolge/Marker verletzt: ${needle}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe('GwG-Lifecycle-Lock – Aufrufer-Reihenfolge', () => {
  // K-03: Die Abläufe der Staff-Actions liegen als Services in server/gwg.
  const checkCycle = source('../check-cycle.ts');
  const checkDecisions = source('../check-decisions.ts');
  const editableCheck = source('../editable-check.ts');
  // K-01: Lifecycle-Lock und Prelude-Kern liegen in @taxtronik/gwg.
  const checkLifecycle = source('../../../../../../packages/gwg/src/check-lifecycle.ts');
  const lifecycle = source('../reverification.ts');

  it('nimmt im Prelude bearbeitender Operationen Zugriff, Lock und Snapshot in fester Reihenfolge', () => {
    expectOrdered(
      section(editableCheck, 'export async function withEditableGwgCheckTx'),
      'assertClientAccessTx(',
      'withLockedEditableGwgCheckTx(',
    );
    expectOrdered(
      section(checkLifecycle, 'export async function withLockedEditableGwgCheckTx'),
      'lockGwgCheckLifecycleTx(',
      'tx.gwgCheck.findFirst(',
      'beforeEditable?.(',
      'assertGwgEditable(',
      'claimCheckMutation(',
    );
  });

  it('serialisiert Create, Submit, Verify und Reject vor Snapshot-Entscheidungen', () => {
    expectOrdered(
      section(
        checkCycle,
        'export async function startGwgCheckCycleTx',
        'export interface GwgRiskAnswersInput',
      ),
      'lockGwgCheckLifecycleTx(',
      'tx.gwgCheck.findFirst(',
      'startFreshGwgReviewTx(',
    );
    expectOrdered(
      section(lifecycle, 'export async function startFreshGwgReviewTx'),
      'lockGwgCheckLifecycleTx(',
      'createFreshGwgDraftTx(',
      'tx.gwgCheck.updateMany(',
    );
    expectOrdered(
      section(lifecycle, 'async function createFreshGwgDraftTx', '/**\n * Beansprucht'),
      'nextGwgCheckCreatedAtTx(',
      'tx.gwgCheck.create(',
    );
    expectOrdered(
      section(
        checkDecisions,
        'export async function submitCheckForReviewTx',
        'export interface GwgVerificationInput',
      ),
      'lockGwgCheckLifecycleTx(',
      'tx.gwgCheck.findFirst(',
      'assertLatestCheckForDecision(',
      'tx.gwgCheck.updateMany(',
    );
    expectOrdered(
      section(
        checkDecisions,
        'export async function verifyCheckTx',
        'export interface GwgRejectionInput',
      ),
      'lockGwgCheckLifecycleTx(',
      'lockStaffGwgReviewerTx(',
      'tx.gwgCheck.findFirst(',
      'assertLatestCheckForDecision(',
      'tx.gwgCheck.updateMany(',
      'tx.client.update(',
    );
    expectOrdered(
      section(checkDecisions, 'export async function rejectCheckTx'),
      'lockGwgCheckLifecycleTx(',
      'lockStaffGwgReviewerTx(',
      'assertLatestCheckForDecision(',
      'tx.gwgCheck.updateMany(',
      'tx.client.updateMany(',
    );
  });

  it('nimmt den Lock vor jedem vorgelagerten GwG-relevanten Client-Update', () => {
    const editActions = source('../../../app/staff/(protected)/clients/[id]/edit/actions.ts');
    expectOrdered(
      section(editActions, 'export async function saveGwgFieldsAction', 'const RespSchema'),
      'lockGwgCheckLifecycleTx(',
      'tx.client.findUnique(',
      'tx.client.update(',
      'requireGwgReverificationTx(',
    );

    const changeRequestActions = source(
      '../../../app/staff/(protected)/clients/[id]/change-requests/actions.ts',
    );
    expectOrdered(
      section(changeRequestActions, 'if (approve) {'),
      'lockGwgCheckLifecycleTx(',
      'tx.client.findUnique(',
      'tx.client.update(',
      'requireGwgReverificationTx(',
    );

    const publicOnboardingTransaction = source('../../gwg-onboarding/submission-transaction.ts');
    expectOrdered(
      section(
        publicOnboardingTransaction,
        'export async function runOnboardingSubmissionTransactionTx',
      ),
      'claimCurrentGwgInviteSubmitTx(',
      'resolveSubmissionReviewTx(',
      'loadSubmissionClientTx(',
      'persistClientMasterPhaseTx(',
    );
    expectOrdered(
      section(
        publicOnboardingTransaction,
        'async function resolveSubmissionReviewTx',
        'async function loadSubmissionClientTx',
      ),
      'canStartUnboundGwgInviteTx(',
      'startFreshGwgReviewTx(',
    );

    const inviteLifecycle = source('../../gwg-onboarding/invite-lifecycle.ts');
    expectOrdered(
      section(inviteLifecycle, 'export async function claimCurrentGwgInviteSubmitTx'),
      'lockGwgCheckLifecycleTx(',
      'tx.gwgOnboardingInvite.findFirst(',
      'resolveCurrentGwgInviteRevisionTx(',
      'claimGwgOnboardingSubmitTx(',
      'tx.gwgOnboardingInvite.updateMany(',
    );
  });

  it('hält die Steuernummer vollständig aus dem GwG-Reverifikationspfad heraus', () => {
    const editActions = source('../../../app/staff/(protected)/clients/[id]/edit/actions.ts');
    const administrativeSection = section(
      editActions,
      'export async function saveAdminFieldsAction',
      'const GWG_KINDS',
    );
    const gwgSection = section(
      editActions,
      'export async function saveGwgFieldsAction',
      'const RespSchema',
    );

    expect(administrativeSection).not.toContain('steuernummer:');
    expect(administrativeSection).toContain('_gwgReverificationTriggered: false');
    expect(administrativeSection).not.toContain('requireGwgReverificationTx(');
    expect(gwgSection).not.toContain('steuernummer');
    expect(gwgSection).not.toContain('vatId');
  });
});
