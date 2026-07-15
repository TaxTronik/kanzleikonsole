// =============================================================================
// Tenant-spezifischer Katalog freiwilliger Einwilligungen.
//
// Definitionen liegen migrationsfrei in tenant_setting. Alle vom Browser
// eingehenden Auswahlen werden hier erneut gegen den aktuellen Tenant-Katalog
// aufgeloest. Labels und Dienstleister-Snapshots stammen dadurch niemals aus
// ungeprueften Client-Daten.
// =============================================================================

import type { TxClient } from '@taxtronik/db';
import {
  ConsentSelectionsSchema,
  defaultConsentOptionsCatalog,
  isBuiltinConsentOptionId,
  normalizeConsentOptionsCatalog,
  selectedBuiltinConsentOptionIds,
  type ConsentOptionDefinition,
  type ConsentOptionSelectionSnapshot,
  type ConsentOptionsCatalog,
  type ConsentSelections,
  type ConsentServiceProviderSnapshot,
  type ResolvedConsentOption,
} from './consent';

export const CONSENT_OPTIONS_SETTING_KEY = 'privacy.consent_options';

export async function readConsentOptionsCatalogTx(
  tx: TxClient,
  tenantId: string,
): Promise<ConsentOptionsCatalog> {
  const row = await tx.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: CONSENT_OPTIONS_SETTING_KEY } },
    select: { value: true },
  });
  if (!row) return defaultConsentOptionsCatalog();
  try {
    return normalizeConsentOptionsCatalog(row.value);
  } catch {
    // Ein korrupter Katalog darf nicht stillschweigend Defaults reaktivieren
    // (z. B. ein bewusst deaktiviertes Fax). Der Erfassungsflow stoppt daher.
    throw new Error(
      'Der Einwilligungskatalog der Kanzlei ist ungültig. Bitte durch ADMIN/PARTNER prüfen lassen.',
    );
  }
}

function toProviderSnapshot(provider: {
  id: string;
  name: string;
  category: string;
  hasDataAccess: boolean;
  contractFromDate: Date | null;
  contractToDate: Date | null;
}): ConsentServiceProviderSnapshot {
  return {
    id: provider.id,
    name: provider.name,
    category: provider.category,
    hasDataAccess: provider.hasDataAccess,
    contractFromDate: provider.contractFromDate?.toISOString().slice(0, 10) ?? null,
    contractToDate: provider.contractToDate?.toISOString().slice(0, 10) ?? null,
  };
}

async function providersByIdTx(
  tx: TxClient,
  tenantId: string,
  options: readonly ConsentOptionDefinition[],
): Promise<Map<string, ConsentServiceProviderSnapshot>> {
  const ids = [
    ...new Set(
      options.map((option) => option.serviceProviderId).filter((id): id is string => id !== null),
    ),
  ];
  if (ids.length === 0) return new Map();
  const providers = await tx.serviceProvider.findMany({
    where: { tenantId, id: { in: ids } },
    select: {
      id: true,
      name: true,
      category: true,
      hasDataAccess: true,
      contractFromDate: true,
      contractToDate: true,
    },
  });
  return new Map(providers.map((provider) => [provider.id, toProviderSnapshot(provider)]));
}

export async function readResolvedConsentOptionsTx(
  tx: TxClient,
  tenantId: string,
): Promise<ResolvedConsentOption[]> {
  const catalog = await readConsentOptionsCatalogTx(tx, tenantId);
  const providers = await providersByIdTx(tx, tenantId, catalog.options);
  return catalog.options.map((option) => {
    const serviceProvider = option.serviceProviderId
      ? (providers.get(option.serviceProviderId) ?? null)
      : null;
    return {
      ...option,
      serviceProvider,
      providerMissing: option.serviceProviderId !== null && serviceProvider === null,
    };
  });
}

/** Prueft alle im Katalog hinterlegten Provider-IDs gegen denselben Tenant. */
export async function assertConsentCatalogProviderLinksTx(
  tx: TxClient,
  tenantId: string,
  catalog: ConsentOptionsCatalog,
): Promise<void> {
  const providers = await providersByIdTx(tx, tenantId, catalog.options);
  const missing = catalog.options.find(
    (option) => option.serviceProviderId !== null && !providers.has(option.serviceProviderId),
  );
  if (missing) {
    throw new Error(
      `Dienstleister der Einwilligungsoption „${missing.label}“ ist nicht verfügbar.`,
    );
  }
}

function selectedOptionIds(input: ConsentSelections): string[] {
  const ids = new Set<string>(selectedBuiltinConsentOptionIds(input));
  for (const selection of input.optionSelections) {
    if (!isBuiltinConsentOptionId(selection.optionId)) ids.add(selection.optionId);
  }
  return [...ids];
}

/**
 * Canonicalisiert eine Staff-/Public-Auswahl. Fremde, unbekannte oder inaktive
 * IDs sowie verschwundene Provider blockieren den Snapshot fail-closed.
 */
export async function resolveConsentSelectionsTx(
  tx: TxClient,
  tenantId: string,
  value: unknown,
): Promise<ConsentSelections> {
  const input = ConsentSelectionsSchema.parse(value);
  const options = await readResolvedConsentOptionsTx(tx, tenantId);
  const byId = new Map(options.map((option) => [option.id, option]));
  const canonicalSelections: ConsentOptionSelectionSnapshot[] = [];

  for (const optionId of selectedOptionIds(input)) {
    const option = byId.get(optionId);
    if (!option) {
      throw new Error('Eine ausgewählte Einwilligungsoption gehört nicht zu dieser Kanzlei.');
    }
    if (!option.active) {
      throw new Error(`Die Einwilligungsoption „${option.label}“ ist nicht mehr aktiv.`);
    }
    if (option.providerMissing) {
      throw new Error(
        `Der Dienstleister der Einwilligungsoption „${option.label}“ ist nicht mehr verfügbar.`,
      );
    }
    canonicalSelections.push({
      optionId: option.id,
      labelSnapshot: option.label,
      section: option.section,
      serviceProviderSnapshot: option.serviceProvider,
    });
  }

  return {
    ...input,
    thirdParties: input.thirdParties.filter((entry) => entry.recipient.trim() !== ''),
    specialists: input.specialists.filter((entry) => entry.entity.trim() !== ''),
    optionSelections: canonicalSelections,
  };
}
