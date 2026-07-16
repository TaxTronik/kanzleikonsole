import { createHash } from 'node:crypto';
import type { ResolvedConsentOption } from './consent';

export const CONSENT_DISPLAY_CHANGED_MESSAGE =
  'Die Datenschutzhinweise oder die Datenschutz-Auswahl wurden zwischenzeitlich geändert. Bitte laden Sie die Seite neu und prüfen Sie die aktuelle Fassung erneut.';

export interface ConsentDisplayNotice {
  version: number;
  body: string;
}

/**
 * Exakt der Katalog, den das Portal rendert: inaktive oder nicht vollständig
 * auflösbare Einträge werden weder angezeigt noch als auswählbar behandelt.
 */
export function visibleConsentOptions(
  options: readonly ResolvedConsentOption[],
): ResolvedConsentOption[] {
  return options.filter((option) => option.active && !option.providerMissing);
}

/**
 * Bindet eine Portal-Erklärung an den exakten Hinweistext und den vollständig
 * aufgelösten, sichtbaren Katalog. Die explizite Projektion macht den Hash
 * unabhängig von Objekt-Key-Reihenfolgen; die Array-Reihenfolge bleibt dagegen
 * bewusst Teil des Nachweises, weil sie der Anzeige-Reihenfolge entspricht.
 */
export function consentDisplayRevision(
  notice: ConsentDisplayNotice,
  options: readonly ResolvedConsentOption[],
): string {
  const evidence = {
    schema: 'taxtronik.privacy-consent-display.v1',
    notice: {
      version: notice.version,
      body: notice.body,
    },
    options: options.map((option, displayOrder) => ({
      displayOrder,
      id: option.id,
      builtin: option.builtin,
      section: option.section,
      label: option.label,
      description: option.description,
      active: option.active,
      required: option.required,
      recommended: option.recommended,
      sortOrder: option.sortOrder,
      serviceProviderId: option.serviceProviderId,
      serviceProvider: option.serviceProvider
        ? {
            id: option.serviceProvider.id,
            name: option.serviceProvider.name,
            category: option.serviceProvider.category,
            hasDataAccess: option.serviceProvider.hasDataAccess,
            contractFromDate: option.serviceProvider.contractFromDate,
            contractToDate: option.serviceProvider.contractToDate,
          }
        : null,
    })),
  };

  return createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
}
