// TAX-MASTER-DATA-001: structural conversion, never proof of issuance/competence.
// Source: https://www.elster.de/eportal/helpGlobal?themaGlobal=wo_ist_meine_steuernummer
export const TAX_STATES = [
  ['BW', 'Baden-Württemberg', '28', 2],
  ['BY', 'Bayern', '9', 3],
  ['BE', 'Berlin', '11', 2],
  ['BB', 'Brandenburg', '3', 3],
  ['HB', 'Bremen', '24', 2],
  ['HH', 'Hamburg', '22', 2],
  ['HE', 'Hessen', '26', 3],
  ['MV', 'Mecklenburg-Vorpommern', '4', 3],
  ['NI', 'Niedersachsen', '23', 2],
  ['NW', 'Nordrhein-Westfalen', '5', 3],
  ['RP', 'Rheinland-Pfalz', '27', 2],
  ['SL', 'Saarland', '1', 3],
  ['SN', 'Sachsen', '3', 3],
  ['ST', 'Sachsen-Anhalt', '3', 3],
  ['SH', 'Schleswig-Holstein', '21', 2],
  ['TH', 'Thüringen', '4', 3],
] as const;

export type TaxStateCode = (typeof TAX_STATES)[number][0];

function validateStateNumberGroups(raw: string, officeLength: number, stateCode: TaxStateCode) {
  const groups = raw.replace(/\s/g, '').split('/');
  if (groups.length === 1) return;
  const lengths = stateCode === 'NW' ? [officeLength, 4, 4] : [officeLength, 3, 5];
  if (groups.length !== 3 || groups.some((group, index) => group.length !== lengths[index])) {
    throw new Error('Die Gruppierung der Steuernummer passt nicht zum Bundesland.');
  }
}

export function normalizeTaxNumber(input: string, stateCode?: string | null): string {
  const raw = input.trim();
  if (!/^[\d\s/]+$/.test(raw))
    throw new Error('Steuernummer: nur Ziffern, Leerzeichen und Schrägstriche verwenden.');
  const digits = raw.replace(/[\s/]/g, '');
  const state = TAX_STATES.find(([code]) => code === stateCode);
  if (stateCode && !state) throw new Error('Unbekanntes Bundesland.');
  if (digits.length === 13) {
    if (digits[4] !== '0') throw new Error('Im ELSTER-Bundesformat muss die fünfte Ziffer 0 sein.');
    if (state && !digits.startsWith(state[2]))
      throw new Error('Steuernummer und Bundesland stimmen nicht überein.');
    return digits;
  }
  if (!state) throw new Error('Für das Länderformat bitte das Bundesland wählen.');
  const [code, , prefix, officeLength] = state;
  if (digits.length !== officeLength + 8)
    throw new Error('Die Steuernummer hat für dieses Bundesland nicht die richtige Länge.');
  if (code === 'HE' && digits[0] !== '0')
    throw new Error('Das hessische Länderformat beginnt mit 0.');
  validateStateNumberGroups(raw, officeLength, code);
  const office = code === 'HE' ? digits.slice(1, 3) : digits.slice(0, officeLength);
  return `${prefix}${office}0${digits.slice(officeLength)}`;
}

export function formatTaxNumber(numberElster: string, stateCode?: string | null): string {
  const state = TAX_STATES.find(([code]) => code === stateCode);
  if (!state || !/^\d{4}0\d{8}$/.test(numberElster) || !numberElster.startsWith(state[2]))
    return numberElster;
  const office =
    state[0] === 'HE' ? `0${numberElster.slice(2, 4)}` : numberElster.slice(4 - state[3], 4);
  const districtEnd = state[0] === 'NW' ? 9 : 8;
  return `${office}/${numberElster.slice(5, districtEnd)}/${numberElster.slice(districtEnd)}`;
}

export interface TaxRegistrationDraft {
  id?: string;
  label: string;
  stateCode: string;
  number: string;
  taxOfficeName: string;
  isPrimary: boolean;
}

export interface TaxMasterDraft {
  vatId: string;
  registrations: TaxRegistrationDraft[];
}

export function summarizeTaxMasterData(draft: TaxMasterDraft): string {
  return [
    `USt-ID: ${draft.vatId || '—'}`,
    ...draft.registrations.map(
      (row) =>
        `${row.isPrimary ? 'Standard · ' : ''}${row.label}: ${row.number} · ${row.taxOfficeName || 'Finanzamt nicht angegeben'}`,
    ),
  ].join('\n');
}
