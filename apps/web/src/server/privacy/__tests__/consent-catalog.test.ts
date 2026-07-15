import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { defaultConsentOptionsCatalog, emptyConsent } from '../consent';
import { resolveConsentSelectionsTx } from '../consent-catalog';

const TENANT_ID = '4d34cf1b-2298-4dc6-84f5-6fcc12b4c15f';
const CUSTOM_ID = 'c8ecfcf4-aa72-47b5-a67e-d42fdc736dcc';
const PROVIDER_ID = '8d872603-4004-4d57-9a36-b789279bf288';

function catalogWithCustom(input: { active?: boolean; providerId?: string | null } = {}) {
  const catalog = defaultConsentOptionsCatalog();
  catalog.options.push({
    id: CUSTOM_ID,
    builtin: false,
    section: 'OTHER',
    label: 'Digitale Beleganalyse',
    description: 'Option der Kanzlei',
    active: input.active ?? true,
    sortOrder: 1000,
    serviceProviderId: input.providerId ?? null,
  });
  return catalog;
}

function txFor(
  catalog: unknown,
  providers: Array<{
    id: string;
    name: string;
    category: string;
    hasDataAccess: boolean;
    contractFromDate: Date | null;
    contractToDate: Date | null;
  }> = [],
): TxClient {
  return {
    tenantSetting: {
      findUnique: vi.fn().mockResolvedValue({ value: catalog }),
    },
    serviceProvider: {
      findMany: vi.fn().mockResolvedValue(providers),
    },
  } as unknown as TxClient;
}

describe('resolveConsentSelectionsTx', () => {
  it('ersetzt manipulierte Labels und Provider-Snapshots durch Tenant-Daten', async () => {
    const submitted = emptyConsent();
    submitted.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Vom Browser manipuliert',
        section: 'MARKETING',
        serviceProviderSnapshot: {
          id: PROVIDER_ID,
          name: 'Falscher Anbieter',
          category: 'Falsch',
          hasDataAccess: null,
          contractFromDate: null,
          contractToDate: null,
        },
      },
    ];

    const resolved = await resolveConsentSelectionsTx(
      txFor(catalogWithCustom({ providerId: PROVIDER_ID }), [
        {
          id: PROVIDER_ID,
          name: 'AVV Cloud GmbH',
          category: 'IT / Cloud',
          hasDataAccess: true,
          contractFromDate: new Date('2025-01-01T00:00:00.000Z'),
          contractToDate: null,
        },
      ]),
      TENANT_ID,
      submitted,
    );

    expect(resolved.optionSelections).toEqual([
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Digitale Beleganalyse',
        section: 'OTHER',
        serviceProviderSnapshot: {
          id: PROVIDER_ID,
          name: 'AVV Cloud GmbH',
          category: 'IT / Cloud',
          hasDataAccess: true,
          contractFromDate: '2025-01-01',
          contractToDate: null,
        },
      },
    ]);
  });

  it('blockiert unbekannte oder inaktive eigene IDs fail-closed', async () => {
    const unknown = emptyConsent();
    unknown.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Fremde Option',
        section: 'OTHER',
        serviceProviderSnapshot: null,
      },
    ];
    await expect(
      resolveConsentSelectionsTx(txFor(defaultConsentOptionsCatalog()), TENANT_ID, unknown),
    ).rejects.toThrow(/gehört nicht|gehoert nicht/);

    await expect(
      resolveConsentSelectionsTx(txFor(catalogWithCustom({ active: false })), TENANT_ID, unknown),
    ).rejects.toThrow(/nicht mehr aktiv/);
  });

  it('blockiert einen nicht im Tenant auflösbaren Provider', async () => {
    const submitted = emptyConsent();
    submitted.optionSelections = [
      {
        optionId: CUSTOM_ID,
        labelSnapshot: 'Beliebig',
        section: 'OTHER',
        serviceProviderSnapshot: null,
      },
    ];
    await expect(
      resolveConsentSelectionsTx(
        txFor(catalogWithCustom({ providerId: PROVIDER_ID }), []),
        TENANT_ID,
        submitted,
      ),
    ).rejects.toThrow(/Dienstleister/);
  });

  it('ergänzt für alte Built-in-Bools einen kanonischen Snapshot', async () => {
    const legacy = emptyConsent();
    legacy.communication.fax = true;
    const resolved = await resolveConsentSelectionsTx(
      txFor(defaultConsentOptionsCatalog()),
      TENANT_ID,
      legacy,
    );
    expect(resolved.optionSelections).toEqual([
      {
        optionId: 'communication.fax',
        labelSnapshot: 'Fax',
        section: 'COMMUNICATION',
        serviceProviderSnapshot: null,
      },
    ]);
  });
});
