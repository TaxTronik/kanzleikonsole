// =============================================================================
// Mandanten-Cockpit-Layout pro Tenant — 12-Spalten Grid analog Dashboard
//
// Statt nur einer Reihenfolge speichert das Layout konkrete X/Y/W/H-Positionen
// pro Block. Admin editiert per Drag-and-Drop + Resize unter
// /staff/admin/settings/modules; Änderung gilt für alle Mitarbeiter (Tenant-
// global, anders als das pro-User Dashboard).
//
// Module-Toggles (modules.ts) entscheiden weiterhin OB ein Block gerendert
// wird — dieses Layout entscheidet nur WO. Position bleibt erhalten, wenn ein
// Modul vorübergehend deaktiviert ist.
// =============================================================================

import type { TenantContext } from '@taxtronik/db';
import { withTenantContext } from '@taxtronik/db';

export type ClientBlockKey =
  // Stammdaten-Bereich
  | 'contacts' // Ansprechpartner-Panel (Inline-Edit)
  | 'master_data' // Stammdaten-Card
  | 'gwg_status' // GwG-Status-Card
  | 'custom_fields' // Tenant-spezifische Custom-Felder
  // Operatives Cockpit
  | 'upcoming' // Anstehende Termine: TaxDeadlines + Appointments
  | 'workflows'
  | 'reminders'
  | 'binders'
  | 'handovers'
  | 'phone_notes'
  // Datenlisten
  | 'requests' // Anforderungs-Tabelle
  | 'documents'; // Dokumente-Tabelle

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
  /** Block-Key fungiert auch als Grid-ID (unique pro Layout) */
  id: ClientBlockKey;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ClientLayoutConfig {
  items: ClientGridItem[];
}

/** Min-/Max-Größen pro Block. h ist nur Minimum — Inhalt darf größer werden. */
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

/**
 * Standard-Layout: sortiert nach Wichtigkeit für den Berater-Alltag.
 * Ansprechpartner ganz oben, dann Stammdaten/GwG, dann das operative
 * Cockpit (Termine/Workflows/Wiedervorlagen/…), zuletzt die großen
 * Listen (Anforderungen + Dokumente) auf voller Breite.
 */
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

const KEY = 'client_detail.layout';

function normalize(value: unknown): ClientLayoutConfig {
  const v = (value ?? {}) as { items?: unknown; order?: unknown };

  // Aktuelles Format: items-Array
  if (Array.isArray(v.items)) {
    const valid: ClientGridItem[] = [];
    for (const raw of v.items) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const id = r['id'];
      if (typeof id !== 'string' || !(ALL_CLIENT_BLOCKS as string[]).includes(id)) continue;
      if (valid.some((x) => x.id === id)) continue; // dedup
      const x = Number(r['x'] ?? 0);
      const y = Number(r['y'] ?? 0);
      const w = Number(r['w'] ?? BLOCK_SIZE[id as ClientBlockKey].w);
      const h = Number(r['h'] ?? BLOCK_SIZE[id as ClientBlockKey].h);
      valid.push({ id: id as ClientBlockKey, x, y, w, h });
    }

    // Wenn deutlich weniger als alle bekannten Blöcke vorhanden sind, war das
    // gespeicherte Layout vermutlich aus einer früheren Version mit weniger
    // Blöcken — komplett auf Default zurücksetzen ist sauberer als einen
    // halb-kaputten Mix mit überlappenden Positionen. Schwellwert
    // konservativ: mehr als 2 fehlende → Reset.
    const present = new Set(valid.map((i) => i.id));
    const missing = ALL_CLIENT_BLOCKS.filter((k) => !present.has(k));
    if (missing.length > 2) {
      return DEFAULT_CLIENT_LAYOUT;
    }

    // Nur 1-2 fehlend → einzeln anhängen (z. B. wenn ein neuer Block dazukommt)
    const maxY = valid.reduce((acc, it) => Math.max(acc, it.y + it.h), 0);
    for (let i = 0; i < missing.length; i++) {
      const id = missing[i]!;
      const def = BLOCK_SIZE[id];
      valid.push({
        id,
        x: def.w >= 12 ? 0 : (i % 2) * 6,
        y: maxY + Math.floor(i / 2) * def.h,
        w: def.w,
        h: def.h,
      });
    }
    return { items: valid };
  }

  // Legacy-Format (alte order-Variante) oder unbekannt → Default
  return DEFAULT_CLIENT_LAYOUT;
}

export async function readClientLayout(ctx: TenantContext): Promise<ClientLayoutConfig> {
  return withTenantContext(ctx, async (tx) => {
    const row = await tx.tenantSetting.findUnique({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
    });
    return row ? normalize(row.value) : DEFAULT_CLIENT_LAYOUT;
  });
}

export async function writeClientLayout(
  ctx: TenantContext,
  cfg: ClientLayoutConfig,
): Promise<void> {
  const stored = normalize(cfg);
  await withTenantContext(ctx, async (tx) => {
    await tx.tenantSetting.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: KEY } },
      create: {
        tenantId: ctx.tenantId,
        key: KEY,
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
      update: {
        value: stored as object,
        updatedBy: ctx.actorId ?? undefined,
      },
    });
  });
}
