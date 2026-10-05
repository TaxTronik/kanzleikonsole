// R-11: notify() ist der eine Benachrichtigungsweg der Worker-Jobs.
// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  upsertNotificationsTx: vi.fn(),
  insertNotificationsTx: vi.fn(),
}));

vi.mock('@taxtronik/db/notification', () => ({
  upsertNotificationsTx: h.upsertNotificationsTx,
  insertNotificationsTx: h.insertNotificationsTx,
}));

import { notify, type NotifyInput, type NotifyTx } from '../notify';

const tx = {} as NotifyTx;
const input = (staffId: string): NotifyInput => ({
  tenantId: 'tenant-1',
  staffId,
  kind: 'SCREENING_REVIEW',
  title: 'Hinweis',
  resourceType: 'tenant',
  resourceId: 'tenant-1',
});

beforeEach(() => {
  vi.resetAllMocks();
  h.upsertNotificationsTx.mockResolvedValue({ created: 1, updated: 1 });
  h.insertNotificationsTx.mockResolvedValue(2);
});

describe('notify', () => {
  it('schreibt Einzel- und Mehrfacheingaben über den gebündelten Upsert', async () => {
    await expect(notify(tx, input('a'))).resolves.toEqual({ created: 1, updated: 1 });
    await notify(tx, [input('a'), input('b')]);

    expect(h.upsertNotificationsTx.mock.calls).toEqual([
      [tx, [input('a')]],
      [tx, [input('a'), input('b')]],
    ]);
    expect(h.insertNotificationsTx).not.toHaveBeenCalled();
  });

  it("legt mit dedupe 'daily' jede Eingabe an (Tages-Dedupe-Index)", async () => {
    await expect(notify(tx, [input('a'), input('b')], { dedupe: 'daily' })).resolves.toEqual({
      created: 2,
      updated: 0,
    });

    expect(h.insertNotificationsTx).toHaveBeenCalledWith(tx, [input('a'), input('b')]);
    expect(h.upsertNotificationsTx).not.toHaveBeenCalled();
  });

  it('macht ohne Empfänger keinen Datenbankzugriff', async () => {
    await expect(notify(tx, [])).resolves.toEqual({ created: 0, updated: 0 });
    await expect(notify(tx, [], { dedupe: 'daily' })).resolves.toEqual({ created: 0, updated: 0 });

    expect(h.upsertNotificationsTx).not.toHaveBeenCalled();
    expect(h.insertNotificationsTx).not.toHaveBeenCalled();
  });
});
