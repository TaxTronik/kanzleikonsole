// Fachkatalog: DSGVO-CONSENT-SNAPSHOT-001
import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import {
  BUILTIN_CONSENT_OPTION_IDS,
  defaultConsentOptionsCatalog,
  emptyConsent,
  parseConsent,
  setBuiltinConsentSelected,
  type ConsentOptionSection,
} from '../consent';
import { consentDisplayRevision, visibleConsentOptions } from '../consent-display';
import {
  ConsentDisplayChangedError,
  readResolvedConsentOptionsTx,
  resolveConsentSelectionsTx,
} from '../consent-catalog';

const TENANT_ID = '4d34cf1b-2298-4dc6-84f5-6fcc12b4c15f';
const CUSTOM_ID = 'c8ecfcf4-aa72-47b5-a67e-d42fdc736dcc';
const PROVIDER_ID = '8d872603-4004-4d57-9a36-b789279bf288';

function catalogWithCustom(
  input: {
    active?: boolean;
    providerId?: string | null;
    required?: boolean;
    recommended?: boolean;
    section?: ConsentOptionSection;
  } = {},
) {
  const catalog = defaultConsentOptionsCatalog();
  catalog.options.push({
    id: CUSTOM_ID,
    builtin: false,
    section: input.section ?? 'OTHER',
    label: 'Digitale Beleganalyse',
    description: 'Option der Kanzlei',
    active: input.active ?? true,
    required: input.required ?? false,
    recommended: input.recommended ?? false,
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
        descriptionSnapshot: null,
        section: 'MARKETING',
        requiredSnapshot: false,
        recommendedSnapshot: false,
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
      txFor(catalogWithCustom({ providerId: PROVIDER_ID, required: true, recommended: true }), [
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
        descriptionSnapshot: 'Option der Kanzlei',
        section: 'OTHER',
        requiredSnapshot: true,
        recommendedSnapshot: true,
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
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: false,
        recommendedSnapshot: false,
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
        descriptionSnapshot: null,
        section: 'OTHER',
        requiredSnapshot: false,
        recommendedSnapshot: false,
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
        descriptionSnapshot: null,
        section: 'COMMUNICATION',
        requiredSnapshot: false,
        recommendedSnapshot: false,
        serviceProviderSnapshot: null,
      },
    ]);
  });

  it.each(['COMMUNICATION', 'MARKETING', 'OTHER'] as const)(
    'erzwingt eigene Abschlussvorgaben aus %s nur im Portal-Policy-Modus',
    async (section) => {
      const empty = emptyConsent();
      const catalog = catalogWithCustom({ required: true, section });

      await expect(
        resolveConsentSelectionsTx(txFor(catalog), TENANT_ID, empty, { enforceRequired: true }),
      ).rejects.toThrow(/Pflichtoptionen.*Digitale Beleganalyse/);

      await expect(
        resolveConsentSelectionsTx(txFor(catalog), TENANT_ID, empty),
      ).resolves.toMatchObject({ optionSelections: [] });
    },
  );

  it.each(['COMMUNICATION', 'MARKETING', 'OTHER'] as const)(
    'akzeptiert eine kanonisch ausgewählte Abschlussvorgabe aus %s',
    async (section) => {
      const submitted = emptyConsent();
      submitted.optionSelections = [
        {
          optionId: CUSTOM_ID,
          labelSnapshot: 'Browser-Label',
          descriptionSnapshot: null,
          section: 'OTHER',
          requiredSnapshot: false,
          recommendedSnapshot: false,
          serviceProviderSnapshot: null,
        },
      ];

      await expect(
        resolveConsentSelectionsTx(
          txFor(catalogWithCustom({ required: true, section })),
          TENANT_ID,
          submitted,
          { enforceRequired: true },
        ),
      ).resolves.toMatchObject({
        optionSelections: [
          expect.objectContaining({ optionId: CUSTOM_ID, section, requiredSnapshot: true }),
        ],
      });
    },
  );

  it.each(BUILTIN_CONSENT_OPTION_IDS)(
    'verlangt für die Abschlussvorgabe %s den tatsächlichen Built-in-Bool',
    async (optionId) => {
      const catalog = defaultConsentOptionsCatalog();
      const option = catalog.options.find((entry) => entry.id === optionId)!;
      option.required = true;
      const unchecked = emptyConsent();
      unchecked.optionSelections = [
        {
          optionId,
          labelSnapshot: 'Gefälschte Auswahl',
          descriptionSnapshot: null,
          section: 'OTHER',
          requiredSnapshot: true,
          recommendedSnapshot: false,
          serviceProviderSnapshot: null,
        },
      ];

      await expect(
        resolveConsentSelectionsTx(txFor(catalog), TENANT_ID, emptyConsent(), {
          enforceRequired: true,
        }),
      ).rejects.toThrow(/Pflichtoptionen/);
      await expect(
        resolveConsentSelectionsTx(txFor(catalog), TENANT_ID, unchecked, { enforceRequired: true }),
      ).rejects.toThrow(/Pflichtoptionen/);
      await expect(
        resolveConsentSelectionsTx(txFor(catalog), TENANT_ID, unchecked),
      ).resolves.toMatchObject({ optionSelections: [] });
      await expect(
        resolveConsentSelectionsTx(
          txFor(catalog),
          TENANT_ID,
          setBuiltinConsentSelected(unchecked, optionId, true),
          { enforceRequired: true },
        ),
      ).resolves.toMatchObject({
        optionSelections: [
          {
            optionId,
            labelSnapshot: option.label,
            descriptionSnapshot: option.description,
            section: option.section,
            requiredSnapshot: true,
            recommendedSnapshot: false,
            serviceProviderSnapshot: null,
          },
        ],
      });
    },
  );

  it('ändert bei späteren Abschlussvorgaben keinen historischen freiwilligen Snapshot', async () => {
    const historical = await resolveConsentSelectionsTx(
      txFor(defaultConsentOptionsCatalog()),
      TENANT_ID,
      setBuiltinConsentSelected(emptyConsent(), 'communication.fax', true),
    );
    const storedJson = JSON.stringify(historical);
    const updatedCatalog = defaultConsentOptionsCatalog();
    const updated = updatedCatalog.options.find((option) => option.id === 'communication.fax')!;
    updated.required = true;

    const newDeclaration = await resolveConsentSelectionsTx(
      txFor(updatedCatalog),
      TENANT_ID,
      historical,
      { enforceRequired: true },
    );

    expect(newDeclaration.optionSelections[0]?.requiredSnapshot).toBe(true);
    expect(historical.optionSelections[0]?.requiredSnapshot).toBe(false);
    expect(JSON.stringify(historical)).toBe(storedJson);
    expect(parseConsent(JSON.parse(storedJson))).toEqual(historical);
  });

  it('blockiert eine geänderte Anzeige vor der Snapshot-Kanonisierung', async () => {
    const originalCatalog = catalogWithCustom({ recommended: true });
    const originalTx = txFor(originalCatalog);
    const originalOptions = visibleConsentOptions(
      await readResolvedConsentOptionsTx(originalTx, TENANT_ID),
    );
    const notice = { version: 5, body: 'Der exakt angezeigte Hinweis.' };
    const expectedRevision = consentDisplayRevision(notice, originalOptions);

    const changedCatalog = catalogWithCustom({ recommended: true });
    const changed = changedCatalog.options.find((option) => option.id === CUSTOM_ID);
    if (!changed) throw new Error('Eigene Option fehlt');
    changed.description = 'Zwischenzeitlich geänderte Beschreibung';

    await expect(
      resolveConsentSelectionsTx(txFor(changedCatalog), TENANT_ID, emptyConsent(), {
        enforceRequired: true,
        expectedDisplay: { revision: expectedRevision, notice },
      }),
    ).rejects.toBeInstanceOf(ConsentDisplayChangedError);
  });
});
