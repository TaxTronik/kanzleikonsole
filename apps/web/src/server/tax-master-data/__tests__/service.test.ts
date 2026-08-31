import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
const record = vi.hoisted(() => vi.fn());
vi.mock('@/server/container', () => ({ evidenceService: { record } }));
vi.mock('@/server/actions/staff-action', () => ({
  ActionError: class ActionError extends Error {},
}));
import { loadTaxMasterDataTx, saveTaxMasterDataTx } from '../service';

const id = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
const current = {
  vatId: null,
  taxRegistrations: [
    {
      id,
      label: 'Einkommensteuer',
      stateCode: 'BE',
      numberElster: '1112034567890',
      taxOfficeName: 'Beispiel',
      taxOfficeCode: '1112',
      isPrimary: true,
    },
  ],
};
function database() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    client: {
      findFirst: vi.fn().mockResolvedValue(current),
      update: vi.fn().mockResolvedValue({}),
    },
    clientTaxRegistration: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
  };
}
describe('TAX-MASTER-DATA-001 atomic tax updates', () => {
  beforeEach(() => vi.clearAllMocks());
  it('DSGVO-MANDATE-ANONYMIZATION-001 rejects repopulating an anonymized client', async () => {
    const db = database();
    db.client.findFirst.mockResolvedValue({ ...current, anonymizedAt: new Date() });
    const loaded = await loadTaxMasterDataTx(db as unknown as TxClient, 'tenant', 'client');
    await expect(
      saveTaxMasterDataTx(db as unknown as TxClient, {
        tenantId: 'tenant',
        clientId: 'client',
        staffId: 'staff',
        expectedRevision: loaded.revision,
        draft: loaded.draft,
      }),
    ).rejects.toThrow('anonymisierte Mandanten');
    expect(db.clientTaxRegistration.updateMany).not.toHaveBeenCalled();
  });
  it('rejects stale proposals before any tax mutation', async () => {
    const db = database();
    const loaded = await loadTaxMasterDataTx(db as unknown as TxClient, 'tenant', 'client');
    await expect(
      saveTaxMasterDataTx(db as unknown as TxClient, {
        tenantId: 'tenant',
        clientId: 'client',
        staffId: 'staff',
        expectedRevision: '0'.repeat(64),
        draft: loaded.draft,
      }),
    ).rejects.toThrow('inzwischen geändert');
    expect(db.clientTaxRegistration.updateMany).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
  it('rejects a foreign or archived registration ID even with a current revision', async () => {
    const db = database();
    const loaded = await loadTaxMasterDataTx(db as unknown as TxClient, 'tenant', 'client');
    loaded.draft.registrations[0]!.id = foreignId;
    await expect(
      saveTaxMasterDataTx(db as unknown as TxClient, {
        tenantId: 'tenant',
        clientId: 'client',
        staffId: 'staff',
        expectedRevision: loaded.revision,
        draft: loaded.draft,
      }),
    ).rejects.toThrow('gehört nicht');
    expect(db.clientTaxRegistration.updateMany).not.toHaveBeenCalled();
  });
  it('normalizes state input and audits a tax-only update without a GwG transition', async () => {
    const db = database();
    const loaded = await loadTaxMasterDataTx(db as unknown as TxClient, 'tenant', 'client');
    loaded.draft.registrations[0]!.number = '13/345/67890';
    loaded.draft.vatId = 'DE123456789';
    await saveTaxMasterDataTx(db as unknown as TxClient, {
      tenantId: 'tenant',
      clientId: 'client',
      staffId: 'staff',
      expectedRevision: loaded.revision,
      draft: loaded.draft,
    });
    expect(db.clientTaxRegistration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id },
        data: expect.objectContaining({
          numberElster: '1113034567890',
          taxOfficeCode: '1113',
          archivedAt: null,
        }),
      }),
    );
    expect(db.client.update).toHaveBeenCalledWith({
      where: { id: 'client' },
      data: { vatId: 'DE123456789' },
    });
    expect(record).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        action: 'client.tax_master_data.update',
        after: expect.objectContaining({ gwgReverificationTriggered: false }),
      }),
    );
  });
  it('archives omitted registrations and never deletes their query history', async () => {
    const db = database();
    const loaded = await loadTaxMasterDataTx(db as unknown as TxClient, 'tenant', 'client');
    await saveTaxMasterDataTx(db as unknown as TxClient, {
      tenantId: 'tenant',
      clientId: 'client',
      staffId: 'staff',
      expectedRevision: loaded.revision,
      draft: { vatId: '', registrations: [] },
    });
    expect(db.clientTaxRegistration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isPrimary: false, archivedAt: expect.any(Date) } }),
    );
    expect(db.clientTaxRegistration.update).not.toHaveBeenCalled();
  });
});
