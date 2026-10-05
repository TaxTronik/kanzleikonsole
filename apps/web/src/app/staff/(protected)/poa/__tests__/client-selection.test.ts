import { describe, expect, it } from 'vitest';
import { resolveInitialPoaClientId } from '../new/client-selection';

describe('Vollmacht-Mandantenvorauswahl', () => {
  it('behaelt den expliziten (auch noch inaktiven) Onboarding-Mandanten bei', () => {
    const requested = { id: 'onboarding-inactive', name: 'Onboarding GmbH', contacts: [] };
    expect(resolveInitialPoaClientId(requested, 'onboarding-inactive')).toEqual({
      initialClientId: 'onboarding-inactive',
      initialClient: requested,
      requestedClientAvailable: true,
    });
  });

  it('faellt bei unbekannter oder unzugaenglicher ID niemals auf einen anderen Mandanten zurueck', () => {
    expect(resolveInitialPoaClientId(null, 'missing')).toEqual({
      initialClientId: undefined,
      requestedClientAvailable: false,
    });
    expect(resolveInitialPoaClientId({ id: 'other' }, 'missing')).toEqual({
      initialClientId: undefined,
      requestedClientAvailable: false,
    });
  });

  it('waehlt ohne expliziten Kontext keinen Mandanten still vor', () => {
    expect(resolveInitialPoaClientId(null, undefined)).toEqual({
      initialClientId: undefined,
      requestedClientAvailable: false,
    });
  });
});
