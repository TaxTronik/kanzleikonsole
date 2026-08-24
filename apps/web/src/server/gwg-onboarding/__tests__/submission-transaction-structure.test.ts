import { readFileSync } from 'node:fs';

// Fachkatalog: GWG-SELF-ONBOARDING-001

import { describe, expect, it } from 'vitest';

const actions = readFileSync(
  new URL('../../../app/gwg-onboarding/actions.ts', import.meta.url),
  'utf8',
);
const transaction = readFileSync(new URL('../submission-transaction.ts', import.meta.url), 'utf8');

describe('GwG onboarding submission transaction structure', () => {
  it('keeps the server action as a boundary-only delegate', () => {
    expect(actions).toContain('runOnboardingSubmissionTransactionTx(tx, {');
    expect(actions).not.toContain('claimCurrentGwgInviteSubmitTx');
    expect(actions).not.toContain('persistOnboardingIdentitySetTx');
  });

  it('keeps claim first and consent finalization last in the phase script', () => {
    const script = transaction.slice(
      transaction.indexOf('export async function runOnboardingSubmissionTransactionTx'),
    );
    const calls = [
      'claimCurrentGwgInviteSubmitTx(tx,',
      'resolveSubmissionReviewTx(tx,',
      'persistClientMasterPhaseTx(tx,',
      'replaceSubmittedPeopleTx(tx,',
      'organizeSubmittedDocumentsTx(tx,',
      'persistSubmittedIdentitySetsTx(tx,',
      'persistSubmittedEntityEvidenceTx(tx,',
      'linkClaimedInviteToReviewTx(tx,',
      'recordSubmissionAuditTx(tx,',
      'notifySubmissionTx(tx,',
      'persistSubmissionConsentFinalizationTx(tx,',
    ];
    const positions = calls.map((call) => script.indexOf(call));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(script.indexOf('return { ok: true };')).toBeGreaterThan(positions.at(-1)!);
  });
});
