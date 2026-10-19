export * from './types';
export * from './frequenz';
export * from './bewertung';
export * from './status';
export * from './phasen';
export * from './grundelemente';
export * from './schwelle';
export * from './perioden';
export * from './prueflast';
export * from './format';
export * from './katalog/risiken';
export * from './katalog/kontrollen';
export * from './katalog/ereignisse';
export * from './katalog/profil';
export * from './katalog/ziele';
export * from './profil-regeln';

export const PAKET = { id: 'ecommerce', name: 'E-Commerce', version: '1.0' } as const;

export const TEILBEREICH_VORLAGE = {
  name: 'Umsatzsteuer & Erlös-Datenkette E-Commerce',
  abgrenzung:
    'Umsatzsteuerliche Pflichten aus Online-Verkäufen (eigener Shop und Marktplätze) im Inland und in allen Ländern mit Steuerpflicht sowie die Erlös-Datenkette vom Shop über Zahlungsdienstleister bis zur Finanzbuchhaltung.',
  einschluesse: [
    'Umsatzsteuer DE und EU',
    'OSS/IOSS',
    'Erlös-Datenkette Shop → ZDL → FiBu',
    'ausgewählte Ertragsteuerrisiken',
  ],
  ausschluesse: [
    'Lohnsteuer',
    'Zoll außer EUSt',
    'Verpackungs-, Elektro- und Batterieregister',
    'Produktsicherheit',
  ],
} as const;

export const HINWEIS_PFLICHTFRAMING =
  'TaxTronik strukturiert und belegt. Angemessenheit und Wirksamkeit beurteilt ein unabhängiger Prüfer; die Verantwortung für das Tax-CMS liegt bei den gesetzlichen Vertretern.';
export * from './beschreibung';
