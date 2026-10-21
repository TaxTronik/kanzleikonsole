// Fachkatalog: TCMS-NACHWEIS-001, GWG-RETENTION-DESTRUCTION-001
// RT3D-K-01 (kk-tcms-fix5): Object-Lock einer Objektversion nur verlängern, nie
// verkürzen, Modus behalten, nachlesen. Speicherschicht-Attrappe (s3.send); ein
// echter Object Store mit Object Lock (SeaweedFS/MinIO) läuft hier nicht – siehe
// docs/operations/day-2-operations.md (Abschnitt Object-Lock der GwG-Belege).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectRetentionCommand, PutObjectRetentionCommand } from '@aws-sdk/client-s3';

const h = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../client', () => ({ s3: { send: h.send } }));

import {
  extendObjectLockRetention,
  ObjectLockExtensionError,
  readObjectLock,
} from '../object-lock-extension';

const REF = { bucket: 'gwg', key: 'tenants/t/none/d.pdf', versionId: 'v-1' };
const ZIEL = new Date('2031-01-01T00:00:00Z');

/** Attrappe eines versionierten Buckets mit Object Lock für genau eine Version. */
function speicher(start: { Mode?: string; RetainUntilDate?: Date } | 'ohne Lock') {
  let lock = start === 'ohne Lock' ? null : { ...start };
  const puts: Array<Record<string, unknown>> = [];
  h.send.mockImplementation(async (command: unknown) => {
    if (command instanceof GetObjectRetentionCommand) {
      expect(command.input).toEqual({ Bucket: 'gwg', Key: REF.key, VersionId: 'v-1' });
      if (!lock) {
        throw Object.assign(new Error('no lock'), { name: 'NoSuchObjectLockConfiguration' });
      }
      return { Retention: { ...lock } };
    }
    if (command instanceof PutObjectRetentionCommand) {
      puts.push(command.input as unknown as Record<string, unknown>);
      const ziel = command.input.Retention!;
      // Wie S3 ohne Bypass: nur verlängern; COMPLIANCE nie umstellen.
      if (lock?.RetainUntilDate && ziel.RetainUntilDate! < lock.RetainUntilDate) {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
      }
      lock = { Mode: ziel.Mode, RetainUntilDate: ziel.RetainUntilDate };
      return {};
    }
    throw new Error(`unerwarteter Befehl ${String(command)}`);
  });
  return { puts, stand: () => lock };
}

beforeEach(() => {
  h.send.mockReset();
});

describe('extendObjectLockRetention (RT3D-K-01)', () => {
  it('verlängert einen kürzeren GOVERNANCE-Lock der exakten Version bis zum Ziel, ohne Bypass, und liest nach', async () => {
    const s = speicher({ Mode: 'GOVERNANCE', RetainUntilDate: new Date('2026-01-01T00:00:00Z') });
    await expect(extendObjectLockRetention(REF, ZIEL)).resolves.toEqual({
      status: 'VERLAENGERT',
      mode: 'GOVERNANCE',
      retainUntil: ZIEL,
    });
    expect(s.puts).toEqual([
      {
        Bucket: 'gwg',
        Key: REF.key,
        VersionId: 'v-1',
        Retention: { Mode: 'GOVERNANCE', RetainUntilDate: ZIEL },
      },
    ]);
    expect(s.puts[0]).not.toHaveProperty('BypassGovernanceRetention');
    // Get – Put – Get: nachgelesen.
    expect(h.send.mock.calls.map(([c]) => (c as object).constructor.name)).toEqual([
      'GetObjectRetentionCommand',
      'PutObjectRetentionCommand',
      'GetObjectRetentionCommand',
    ]);
  });

  it('verkürzt nie: ein Ende auf oder hinter dem Ziel bleibt unberührt (idempotent)', async () => {
    for (const ende of [ZIEL, new Date('2040-01-01T00:00:00Z')]) {
      const s = speicher({ Mode: 'GOVERNANCE', RetainUntilDate: ende });
      await expect(extendObjectLockRetention(REF, ZIEL)).resolves.toEqual({
        status: 'UNVERAENDERT',
        mode: 'GOVERNANCE',
        retainUntil: ende,
      });
      expect(s.puts).toEqual([]);
    }
    // Zweiter Aufruf nach dem Verlängern: nichts mehr zu tun.
    const s = speicher({ Mode: 'GOVERNANCE', RetainUntilDate: new Date('2026-01-01T00:00:00Z') });
    await extendObjectLockRetention(REF, ZIEL);
    await expect(extendObjectLockRetention(REF, ZIEL)).resolves.toMatchObject({
      status: 'UNVERAENDERT',
    });
    expect(s.puts).toHaveLength(1);
  });

  it('behält den Modus COMPLIANCE und setzt einer Version ohne Lock GOVERNANCE', async () => {
    const compliance = speicher({
      Mode: 'COMPLIANCE',
      RetainUntilDate: new Date('2026-01-01T00:00:00Z'),
    });
    await expect(extendObjectLockRetention(REF, ZIEL)).resolves.toMatchObject({
      mode: 'COMPLIANCE',
    });
    expect(compliance.puts[0]).toMatchObject({ Retention: { Mode: 'COMPLIANCE' } });
    const ohne = speicher('ohne Lock');
    await expect(extendObjectLockRetention(REF, ZIEL)).resolves.toEqual({
      status: 'VERLAENGERT',
      mode: 'GOVERNANCE',
      retainUntil: ZIEL,
    });
    expect(ohne.puts[0]).toMatchObject({ Retention: { Mode: 'GOVERNANCE' } });
  });

  it('meldet einen nicht nachweisbaren Lock nach dem Setzen als Fehler (Modus oder Ende abweichend)', async () => {
    for (const nachher of [
      { Mode: 'GOVERNANCE', RetainUntilDate: new Date('2030-12-31T23:59:59Z') },
      { Mode: 'COMPLIANCE', RetainUntilDate: ZIEL },
    ]) {
      let aufrufe = 0;
      h.send.mockReset().mockImplementation(async (command: unknown) => {
        if (command instanceof PutObjectRetentionCommand) return {};
        aufrufe += 1;
        return {
          Retention:
            aufrufe === 1
              ? { Mode: 'GOVERNANCE', RetainUntilDate: new Date('2026-01-01T00:00:00Z') }
              : nachher,
        };
      });
      const fehler = await extendObjectLockRetention(REF, ZIEL).catch((e: unknown) => e);
      expect(fehler).toBeInstanceOf(ObjectLockExtensionError);
      expect((fehler as ObjectLockExtensionError).code).toBe('OBJECT_LOCK_EXTEND_UNVERIFIED');
    }
  });

  it('verlängert nie ohne exakte Version und nie auf ein ungültiges Ende; Speicherfehler gehen durch', async () => {
    speicher({ Mode: 'GOVERNANCE', RetainUntilDate: new Date('2026-01-01T00:00:00Z') });
    for (const versionId of ['', '  ', 'null']) {
      await expect(extendObjectLockRetention({ ...REF, versionId }, ZIEL)).rejects.toMatchObject({
        code: 'STORAGE_VERSION_ID_MISSING',
      });
    }
    await expect(extendObjectLockRetention(REF, new Date(Number.NaN))).rejects.toMatchObject({
      code: 'OBJECT_LOCK_TARGET_INVALID',
    });
    expect(h.send).not.toHaveBeenCalled();
    h.send.mockReset().mockRejectedValue(Object.assign(new Error('x'), { name: 'AccessDenied' }));
    await expect(extendObjectLockRetention(REF, ZIEL)).rejects.toMatchObject({
      name: 'AccessDenied',
    });
  });

  it('readObjectLock: ohne Lock null, unvollständiger Lock ist ein Fehler', async () => {
    speicher('ohne Lock');
    await expect(readObjectLock(REF)).resolves.toBeNull();
    h.send.mockReset().mockResolvedValue({ Retention: { Mode: 'GOVERNANCE' } });
    await expect(readObjectLock(REF)).rejects.toMatchObject({ code: 'OBJECT_LOCK_STATE_INVALID' });
    h.send.mockReset().mockResolvedValue({
      Retention: { Mode: 'LEGAL', RetainUntilDate: ZIEL },
    });
    await expect(readObjectLock(REF)).rejects.toMatchObject({ code: 'OBJECT_LOCK_STATE_INVALID' });
  });
});
