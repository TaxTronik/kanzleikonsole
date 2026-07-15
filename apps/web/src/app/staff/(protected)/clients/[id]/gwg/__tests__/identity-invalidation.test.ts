import { describe, expect, it } from 'vitest';
import { acknowledgeIdentityInvalidation } from '../identity-invalidation';

describe('GwG-Ausweis-Invalidationen', () => {
  const state = {
    'set-1': { revision: 'newer-revision', generation: 2 },
  };

  it('laesst eine neuere Personenmutation bei einer aelteren Save-Antwort bestehen', () => {
    expect(acknowledgeIdentityInvalidation(state, 'set-1', 1)).toBe(state);
  });

  it('entfernt nur die beim Submit tatsaechlich konsumierte Generation', () => {
    expect(acknowledgeIdentityInvalidation(state, 'set-1', 2)).toEqual({});
  });
});
