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
import { readTenantSettingValue, writeTenantSettingValue } from '@taxtronik/db/tenant-settings';
import {
  ALL_CLIENT_BLOCKS,
  BLOCK_SIZE,
  DEFAULT_CLIENT_LAYOUT,
  type ClientBlockKey,
  type ClientGridItem,
  type ClientLayoutConfig,
} from './client-layout-shared';

export {
  ALL_CLIENT_BLOCKS,
  BLOCK_SIZE,
  CLIENT_BLOCK_LABELS,
  DEFAULT_CLIENT_LAYOUT,
} from './client-layout-shared';
export type { ClientBlockKey, ClientGridItem, ClientLayoutConfig } from './client-layout-shared';

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
    const value = await readTenantSettingValue(tx, ctx.tenantId, KEY);
    return value === undefined ? DEFAULT_CLIENT_LAYOUT : normalize(value);
  });
}

export async function writeClientLayout(
  ctx: TenantContext,
  cfg: ClientLayoutConfig,
): Promise<void> {
  const stored = normalize(cfg);
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY,
      value: stored as object,
      updatedBy: ctx.actorId,
    });
  });
}
