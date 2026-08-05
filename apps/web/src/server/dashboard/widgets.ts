/**
 * Dashboard-Widget-Definitionen
 *
 * Jedes Widget hat einen stabilen Type-Key, ein UI-Label und eine Größe.
 * Daten holt das Widget selbst beim Rendern (Server-Komponenten) — diese
 * Datei ist nur die Registry für Auswahl + Validierung des Layouts.
 *
 * Bewusst keine Mitarbeiter-Überwachungs-Widgets (keine pro-Mitarbeiter-
 * Stunden, Reaktionszeiten, Quoten) — entspricht der Projekt-Vorgabe.
 */

export type WidgetType =
  | 'kpi_clients'
  | 'kpi_open_requests'
  | 'kpi_documents'
  | 'kpi_unread_notes'
  | 'kpi_pending_change_requests'
  | 'kpi_open_workflows'
  | 'recent_activity'
  | 'upcoming_requests'
  | 'gwg_expiring'
  | 'unreviewed_notices'
  | 'my_tax_deadlines'
  | 'calendar'
  | 'tax_news'
  | 'phone_notes'
  | 'bookmarks'
  | 'personal_notes'
  | 'my_workflow_items'
  | 'my_workflows'
  | 'my_reminders'
  | 'latest_notifications';

export type WidgetSize = 'kpi' | 'wide' | 'half';

export interface WidgetDef {
  type: WidgetType;
  label: string;
  description: string;
  size: WidgetSize;
}

export const WIDGETS: WidgetDef[] = [
  { type: 'kpi_clients', label: 'Mandanten', description: 'Anzahl aller Mandanten', size: 'kpi' },
  {
    type: 'kpi_open_requests',
    label: 'Offene Anforderungen',
    description: 'Anforderungen mit Status OPEN/IN_PROGRESS',
    size: 'kpi',
  },
  { type: 'kpi_documents', label: 'Dokumente', description: 'Gesamtzahl Dokumente', size: 'kpi' },
  {
    type: 'kpi_unread_notes',
    label: 'Offene Telefonzettel',
    description: 'Telefonnotizen, die noch nicht erledigt sind',
    size: 'kpi',
  },
  {
    type: 'kpi_pending_change_requests',
    label: 'Offene Stammdaten-Anträge',
    description: 'Mandanten-Änderungsanträge',
    size: 'kpi',
  },
  {
    type: 'kpi_open_workflows',
    label: 'Laufende Workflows',
    description: 'Aktive Workflow-Instanzen',
    size: 'kpi',
  },
  {
    type: 'recent_activity',
    label: 'Letzte Aktivitäten',
    description: 'Audit-Strom (Top 10)',
    size: 'wide',
  },
  {
    type: 'upcoming_requests',
    label: 'Fällige Anforderungen',
    description: 'Anforderungen mit Fälligkeit',
    size: 'half',
  },
  {
    type: 'gwg_expiring',
    label: 'GwG läuft bald aus',
    description: 'Mandanten mit GwG-Ablauf < 90 Tage',
    size: 'half',
  },
  {
    type: 'unreviewed_notices',
    label: 'Ungeprüfte Bescheide',
    description: 'Bescheide mit Status NEU',
    size: 'half',
  },
  {
    type: 'my_tax_deadlines',
    label: 'Nächste Steuertermine',
    description: 'Anstehende Termine der Kanzlei',
    size: 'half',
  },
  {
    type: 'calendar',
    label: 'Kalender',
    description: 'Anstehende Termine + Steuertermine der nächsten Tage',
    size: 'half',
  },
  {
    type: 'tax_news',
    label: 'RSS-Reader',
    description: 'Eigene RSS-Feeds (BMF, BFH und beliebige weitere)',
    size: 'half',
  },
  {
    type: 'phone_notes',
    label: 'Telefonzettel',
    description: 'Ungelesene + aktuelle Telefonnotizen der Kanzlei',
    size: 'half',
  },
  {
    type: 'bookmarks',
    label: 'Gemerkt',
    description: 'Persönlich gemerkte Einträge (z. B. BMF/BFH-Schreiben)',
    size: 'half',
  },
  {
    type: 'personal_notes',
    label: 'Persönliche Notizen',
    description: 'Eigene Kurz-Notizen — privater Block',
    size: 'half',
  },
  {
    type: 'my_workflow_items',
    label: 'Mein Tag',
    description: 'Meine offenen Aufgaben, Wiedervorlagen, Termine und Telefonzettel',
    size: 'half',
  },
  {
    type: 'my_workflows',
    label: 'Meine Workflows',
    description: 'Workflow-Instanzen, die mir Schritte zuweisen oder die ich gestartet habe',
    size: 'half',
  },
  {
    type: 'my_reminders',
    label: 'Wiedervorlagen',
    description: 'Mir zugewiesene offene Wiedervorlagen, fällig zuerst',
    size: 'half',
  },
  {
    type: 'latest_notifications',
    label: 'Neueste Benachrichtigungen',
    description: 'Die neuesten Benachrichtigungen (persönlich + kanzleiweit)',
    size: 'half',
  },
];

export const WIDGET_BY_TYPE: Record<WidgetType, WidgetDef> = Object.fromEntries(
  WIDGETS.map((w) => [w.type, w]),
) as Record<WidgetType, WidgetDef>;

/**
 * Position + Größe im 12-Spalten-Grid. Zeilenhöhe wird vom Grid-Component
 * vorgegeben (siehe DashboardGrid). Höhe in Grid-Einheiten (rowHeight × h).
 */
export interface LayoutWidget {
  id: string;
  type: WidgetType;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardLayout {
  version: 2;
  widgets: LayoutWidget[];
}

/** Default-Größe pro Widget-Slot (in Grid-Einheiten). */
export const DEFAULT_SIZE: Record<
  WidgetType,
  { w: number; h: number; minW: number; minH: number }
> = {
  kpi_clients: { w: 3, h: 3, minW: 2, minH: 3 },
  kpi_open_requests: { w: 3, h: 3, minW: 2, minH: 3 },
  kpi_documents: { w: 3, h: 3, minW: 2, minH: 3 },
  kpi_unread_notes: { w: 3, h: 3, minW: 2, minH: 3 },
  kpi_pending_change_requests: { w: 3, h: 3, minW: 2, minH: 3 },
  kpi_open_workflows: { w: 3, h: 3, minW: 2, minH: 3 },
  recent_activity: { w: 8, h: 10, minW: 4, minH: 6 },
  upcoming_requests: { w: 4, h: 10, minW: 3, minH: 4 },
  gwg_expiring: { w: 4, h: 10, minW: 3, minH: 4 },
  unreviewed_notices: { w: 4, h: 10, minW: 3, minH: 4 },
  my_tax_deadlines: { w: 4, h: 10, minW: 3, minH: 4 },
  calendar: { w: 6, h: 12, minW: 4, minH: 6 },
  tax_news: { w: 6, h: 10, minW: 4, minH: 5 },
  phone_notes: { w: 4, h: 10, minW: 3, minH: 4 },
  bookmarks: { w: 4, h: 10, minW: 3, minH: 4 },
  personal_notes: { w: 4, h: 10, minW: 3, minH: 5 },
  my_workflow_items: { w: 4, h: 10, minW: 3, minH: 4 },
  my_workflows: { w: 4, h: 10, minW: 3, minH: 4 },
  my_reminders: { w: 4, h: 10, minW: 3, minH: 4 },
  latest_notifications: { w: 4, h: 10, minW: 3, minH: 4 },
};

export const DEFAULT_LAYOUT: DashboardLayout = {
  version: 2,
  widgets: [
    { id: 'w-1', type: 'kpi_clients', x: 0, y: 0, w: 3, h: 3 },
    { id: 'w-2', type: 'kpi_open_requests', x: 3, y: 0, w: 3, h: 3 },
    { id: 'w-3', type: 'kpi_documents', x: 6, y: 0, w: 3, h: 3 },
    { id: 'w-4', type: 'kpi_unread_notes', x: 9, y: 0, w: 3, h: 3 },
    { id: 'w-5', type: 'recent_activity', x: 0, y: 3, w: 8, h: 10 },
    { id: 'w-6', type: 'upcoming_requests', x: 8, y: 3, w: 4, h: 10 },
  ],
};

/** Parsed Layout; akzeptiert auch das alte v1-Format (positionsfrei). */
export function parseLayout(raw: unknown): DashboardLayout {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_LAYOUT;
  const obj = raw as { version?: number; widgets?: unknown };
  if (!Array.isArray(obj.widgets)) return DEFAULT_LAYOUT;

  // v1 → v2 Migration: positionsfrei → automatisch fließend platzieren
  if (obj.version !== 2) {
    let x = 0;
    let y = 0;
    let rowH = 0;
    const widgets: LayoutWidget[] = [];
    for (const w of obj.widgets) {
      if (
        typeof w !== 'object' ||
        w === null ||
        typeof (w as { id?: unknown }).id !== 'string' ||
        typeof (w as { type?: unknown }).type !== 'string' ||
        !((w as { type: string }).type in WIDGET_BY_TYPE)
      )
        continue;
      const id = (w as { id: string }).id;
      const type = (w as { type: WidgetType }).type;
      const def = DEFAULT_SIZE[type];
      if (x + def.w > 12) {
        x = 0;
        y += rowH;
        rowH = 0;
      }
      widgets.push({ id, type, x, y, w: def.w, h: def.h });
      x += def.w;
      rowH = Math.max(rowH, def.h);
    }
    return { version: 2, widgets };
  }

  const widgets = obj.widgets.filter((w): w is LayoutWidget => {
    if (typeof w !== 'object' || w === null) return false;
    const o = w as Record<string, unknown>;
    return (
      typeof o['id'] === 'string' &&
      typeof o['type'] === 'string' &&
      (o['type'] as string) in WIDGET_BY_TYPE &&
      typeof o['x'] === 'number' &&
      typeof o['y'] === 'number' &&
      typeof o['w'] === 'number' &&
      typeof o['h'] === 'number'
    );
  });
  return { version: 2, widgets };
}
