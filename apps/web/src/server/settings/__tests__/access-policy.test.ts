import { describe, it, expect } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { decideClientAccess, readAccessPolicyTx, DEFAULT_ACCESS_POLICY } from '../access-policy';

describe('decideClientAccess (Zugriffs-Policy, Wahrheitstabelle)', () => {
  it('Admin/Partner hat immer Zugriff — auch bei vertraulich/RESTRICTED', () => {
    expect(
      decideClientAccess({
        isAdmin: true,
        mode: 'RESTRICTED',
        vertraulich: true,
        isResponsible: false,
      }),
    ).toBe(true);
  });

  it('OPEN + nicht vertraulich → jeder Mitarbeiter (kanzleiweite Zusammenarbeit)', () => {
    expect(
      decideClientAccess({
        isAdmin: false,
        mode: 'OPEN',
        vertraulich: false,
        isResponsible: false,
      }),
    ).toBe(true);
  });

  it('OPEN + vertraulich → nur Zugeordnete', () => {
    expect(
      decideClientAccess({ isAdmin: false, mode: 'OPEN', vertraulich: true, isResponsible: false }),
    ).toBe(false);
    expect(
      decideClientAccess({ isAdmin: false, mode: 'OPEN', vertraulich: true, isResponsible: true }),
    ).toBe(true);
  });

  it('RESTRICTED → nur Zugeordnete (Vertraulich-Flag irrelevant)', () => {
    expect(
      decideClientAccess({
        isAdmin: false,
        mode: 'RESTRICTED',
        vertraulich: false,
        isResponsible: false,
      }),
    ).toBe(false);
    expect(
      decideClientAccess({
        isAdmin: false,
        mode: 'RESTRICTED',
        vertraulich: false,
        isResponsible: true,
      }),
    ).toBe(true);
  });
});

describe('readAccessPolicyTx (Parsing)', () => {
  const fakeTx = (value: unknown) =>
    ({
      tenantSetting: { findUnique: async () => (value === undefined ? null : { value }) },
    }) as unknown as TxClient;

  it('kein Setting → Default OPEN', async () => {
    expect(await readAccessPolicyTx(fakeTx(undefined), 't1')).toEqual(DEFAULT_ACCESS_POLICY);
  });

  it('RESTRICTED wird übernommen', async () => {
    expect(await readAccessPolicyTx(fakeTx({ clientAccessMode: 'RESTRICTED' }), 't1')).toEqual({
      clientAccessMode: 'RESTRICTED',
    });
  });

  it('kaputter/fehlender Wert → fail-open OPEN (Mitarbeiter nicht aussperren)', async () => {
    expect(await readAccessPolicyTx(fakeTx({ clientAccessMode: 'GARBAGE' }), 't1')).toEqual({
      clientAccessMode: 'OPEN',
    });
    expect(await readAccessPolicyTx(fakeTx({}), 't1')).toEqual({ clientAccessMode: 'OPEN' });
  });
});
