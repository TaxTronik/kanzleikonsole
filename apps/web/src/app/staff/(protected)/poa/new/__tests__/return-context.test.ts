import { describe, expect, it } from 'vitest';
import {
  parsePoaCreateReturnContext,
  poaCreateResumeHref,
  poaCreateSuccessHref,
} from '../return-context';

const CLIENT_ID = '7e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e6f';
const POA_ID = '8d6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e7a';
const DOCUMENT_ID = '9e6f0d2c-9c1a-4f5b-8d3e-2a1b3c4d5e8b';

describe('Vollmachts-Anlage: enger Rückkehrkontext', () => {
  it('akzeptiert ausschließlich den bekannten Onboarding-Kontext', () => {
    expect(parsePoaCreateReturnContext('onboarding')).toBe('onboarding');
    expect(parsePoaCreateReturnContext('https://evil.example')).toBeUndefined();
    expect(parsePoaCreateReturnContext('/staff/admin')).toBeUndefined();
    expect(parsePoaCreateReturnContext(['onboarding'])).toBeUndefined();
    expect(parsePoaCreateReturnContext(undefined)).toBeUndefined();
  });

  it('führt nach Erfolg in genau den Mandanten-Onboarding-Schritt zurück', () => {
    expect(
      poaCreateSuccessHref({ clientId: CLIENT_ID, poaId: POA_ID, returnContext: 'onboarding' }),
    ).toBe(`/staff/clients/onboarding/${CLIENT_ID}?step=poa`);
  });

  it('behält ohne Onboarding-Kontext den normalen Detailpfad bei', () => {
    expect(poaCreateSuccessHref({ clientId: CLIENT_ID, poaId: POA_ID })).toBe(
      `/staff/poa/${POA_ID}`,
    );
  });

  it('bewahrt Mandant, Upload und Kontext im sicheren Retry-Link', () => {
    expect(
      poaCreateResumeHref({
        clientId: CLIENT_ID,
        pendingDocumentId: DOCUMENT_ID,
        returnContext: 'onboarding',
      }),
    ).toBe(`/staff/poa/new?clientId=${CLIENT_ID}&pendingDocumentId=${DOCUMENT_ID}&from=onboarding`);
  });
});
