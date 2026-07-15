import { describe, expect, it } from 'vitest';
import { resolveInitialPoaClientId } from '../new/client-selection';

describe('Vollmacht-Mandantenvorauswahl', () => {
  const clients = [{ id: 'active-a' }, { id: 'onboarding-inactive' }];

  it('behaelt den expliziten Onboarding-Mandanten bei', () => {
    expect(resolveInitialPoaClientId(clients, 'onboarding-inactive')).toEqual({
      initialClientId: 'onboarding-inactive',
      requestedClientAvailable: true,
    });
  });

  it('faellt bei unbekannter expliziter ID niemals auf einen anderen Mandanten zurueck', () => {
    expect(resolveInitialPoaClientId(clients, 'missing')).toEqual({
      initialClientId: undefined,
      requestedClientAvailable: false,
    });
  });

  it('nutzt nur ohne expliziten Kontext den ersten verfuegbaren Mandanten', () => {
    expect(resolveInitialPoaClientId(clients, undefined)).toEqual({
      initialClientId: 'active-a',
      requestedClientAvailable: false,
    });
  });
});
