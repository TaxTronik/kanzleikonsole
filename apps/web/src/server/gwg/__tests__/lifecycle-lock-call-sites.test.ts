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
  const staffActions = source('../../../app/staff/(protected)/clients/[id]/gwg/actions.ts');
  const lifecycle = source('../reverification.ts');

  it('serialisiert Create, Submit, Verify und Reject vor Snapshot-Entscheidungen', () => {
    expectOrdered(
      section(staffActions, 'async function startCheckCycle', 'const AnswersSchema'),
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
      section(lifecycle, 'async function createFreshGwgDraftTx', '/**\n * Serialisiert'),
      'nextGwgCheckCreatedAtTx(',
      'tx.gwgCheck.create(',
    );
    expectOrdered(
      section(
        staffActions,
        'export async function submitCheckForReviewAction',
        'export async function verifyCheckAction',
      ),
      'lockGwgCheckLifecycleTx(',
      'tx.gwgCheck.findFirst(',
      'assertLatestCheckForDecision(',
      'tx.gwgCheck.updateMany(',
    );
    expectOrdered(
      section(staffActions, 'export async function verifyCheckAction', 'const RejectSchema'),
      'lockGwgCheckLifecycleTx(',
      'lockStaffGwgReviewerTx(',
      'tx.gwgCheck.findFirst(',
      'assertLatestCheckForDecision(',
      'tx.gwgCheck.updateMany(',
      'tx.client.update(',
    );
    expectOrdered(
      section(staffActions, 'export async function rejectCheckAction'),
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
