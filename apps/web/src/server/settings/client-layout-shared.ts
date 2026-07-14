export type ClientBlockKey =
  | 'contacts'
  | 'master_data'
  | 'gwg_status'
  | 'custom_fields'
  | 'upcoming'
  | 'workflows'
  | 'reminders'
  | 'binders'
  | 'handovers'
  | 'phone_notes'
  | 'requests'
  | 'documents';

export const ALL_CLIENT_BLOCKS: ClientBlockKey[] = [
  'contacts',
  'master_data',
  'gwg_status',
  'custom_fields',
  'upcoming',
  'workflows',
  'reminders',
  'binders',
  'handovers',
  'phone_notes',
  'requests',
  'documents',
];

export const CLIENT_BLOCK_LABELS: Record<ClientBlockKey, string> = {
  contacts: 'Ansprechpartner',
  master_data: 'Stammdaten',
  gwg_status: 'GwG-Status',
  custom_fields: 'Custom-Felder',
  upcoming: 'Anstehende Termine',
  workflows: 'Aktive Workflows',
  reminders: 'Wiedervorlagen',
  binders: 'Pendelordner',
  handovers: 'Anlieferungen',
  phone_notes: 'Telefonzettel',
  requests: 'Anforderungen (Tabelle)',
  documents: 'Dokumente (Tabelle)',
};

export interface ClientGridItem {
  id: ClientBlockKey;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClientLayoutConfig {
  items: ClientGridItem[];
}

export const BLOCK_SIZE: Record<
  ClientBlockKey,
  { w: number; h: number; minW: number; minH: number }
> = {
  contacts: { w: 12, h: 6, minW: 6, minH: 4 },
  master_data: { w: 6, h: 8, minW: 4, minH: 5 },
  gwg_status: { w: 6, h: 5, minW: 4, minH: 4 },
  custom_fields: { w: 6, h: 6, minW: 4, minH: 4 },
  upcoming: { w: 6, h: 10, minW: 4, minH: 5 },
  workflows: { w: 6, h: 8, minW: 4, minH: 5 },
  reminders: { w: 6, h: 8, minW: 4, minH: 5 },
  binders: { w: 6, h: 8, minW: 4, minH: 5 },
  handovers: { w: 6, h: 8, minW: 4, minH: 5 },
  phone_notes: { w: 6, h: 10, minW: 4, minH: 6 },
  requests: { w: 12, h: 12, minW: 6, minH: 6 },
  documents: { w: 12, h: 12, minW: 6, minH: 6 },
};

export const DEFAULT_CLIENT_LAYOUT: ClientLayoutConfig = {
  items: [
    { id: 'contacts', x: 0, y: 0, w: 12, h: 6 },
    { id: 'master_data', x: 0, y: 6, w: 6, h: 8 },
    { id: 'gwg_status', x: 6, y: 6, w: 6, h: 5 },
    { id: 'custom_fields', x: 6, y: 11, w: 6, h: 6 },
    { id: 'upcoming', x: 0, y: 17, w: 6, h: 10 },
    { id: 'workflows', x: 6, y: 17, w: 6, h: 10 },
    { id: 'reminders', x: 0, y: 27, w: 6, h: 8 },
    { id: 'binders', x: 6, y: 27, w: 6, h: 8 },
    { id: 'handovers', x: 0, y: 35, w: 6, h: 8 },
    { id: 'phone_notes', x: 6, y: 35, w: 6, h: 10 },
    { id: 'requests', x: 0, y: 45, w: 12, h: 12 },
    { id: 'documents', x: 0, y: 57, w: 12, h: 12 },
  ],
};
