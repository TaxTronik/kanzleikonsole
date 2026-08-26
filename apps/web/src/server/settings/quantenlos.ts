// =============================================================================
// Quantenlos: zentral verwalteter IBM-Quantum-Zugang
//
// Liegt in `tenant_setting` unter `quantenlos.ibm`. Der Token wird mit
// `encryptSecret` (AES-256-GCM) verschlüsselt abgelegt — nie als Klartext —
// und pro Engine-Request als `ibm_token` mitgereicht (Engine 1.3.1): die
// Engine persistiert ihn NIE (kein `save_account`), loggt ihn nie und hält
// ihn aus Fehler-/Hinweistexten heraus. Damit entfällt das Hinterlegen von
// Credentials auf der Engine-Maschine; deren Maschinen-Zugang
// (QISKIT_IBM_TOKEN / gespeichertes Konto) bleibt als Deployment-Fallback.
//
// Für die UI gibt es einen Status OHNE Entschlüsselung (`getIbmTokenStatus`):
// nur „hinterlegt + Suffix" — der Suffix (letzte 4 Zeichen) wird beim
// Speichern als Klartext-Hinweis abgelegt, wie das Maskierungs-Muster der
// Integrations-Seite.
// =============================================================================

import { withTenantContext } from '@taxtronik/db';
import type { TenantContext } from '@taxtronik/db';
import {
  deleteTenantSettingValue,
  readTenantSettingValue,
  writeTenantSettingValue,
} from '@taxtronik/db/tenant-settings';
import { decryptSecret, encryptSecret, looksEncrypted } from '@/server/crypto/secret-box';

const KEY = 'quantenlos.ibm';

/** Persistenz-Form: Token verschlüsselt, Suffix als maskierter UI-Hinweis. */
interface QuantenlosIbmStored {
  tokenEncrypted: string;
  /** Letzte 4 Zeichen des Tokens (nur Anzeige „…abcd"). */
  suffix: string;
  gesetztAm: string;
}

export interface IbmTokenStatus {
  hinterlegt: boolean;
  suffix: string | null;
  gesetztAm: string | null;
}

/** Entschlüsselter Token für den Engine-Request — NIE an den Client geben. */
export async function readIbmToken(ctx: TenantContext): Promise<string | null> {
  const value = await withTenantContext(ctx, (tx) => readTenantSettingValue(tx, ctx.tenantId, KEY));
  if (value === undefined) return null;
  const stored = value as Partial<QuantenlosIbmStored>;
  if (!stored.tokenEncrypted || !looksEncrypted(stored.tokenEncrypted)) return null;
  try {
    const token = decryptSecret(stored.tokenEncrypted);
    return token || null;
  } catch {
    return null;
  }
}

export async function writeIbmToken(ctx: TenantContext, token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Leerer Token — zum Entfernen `deleteIbmToken` verwenden.');
  const stored: QuantenlosIbmStored = {
    tokenEncrypted: encryptSecret(trimmed),
    suffix: trimmed.slice(-4),
    gesetztAm: new Date().toISOString(),
  };
  await withTenantContext(ctx, async (tx) => {
    await writeTenantSettingValue(tx, {
      tenantId: ctx.tenantId,
      key: KEY,
      value: stored as object,
      updatedBy: ctx.actorId,
    });
  });
}

export async function deleteIbmToken(ctx: TenantContext): Promise<void> {
  await withTenantContext(ctx, async (tx) => {
    await deleteTenantSettingValue(tx, ctx.tenantId, KEY);
  });
}

/** UI-Status ohne Entschlüsselung. */
export async function getIbmTokenStatus(ctx: TenantContext): Promise<IbmTokenStatus> {
  const value = await withTenantContext(ctx, (tx) => readTenantSettingValue(tx, ctx.tenantId, KEY));
  if (value === undefined) return { hinterlegt: false, suffix: null, gesetztAm: null };
  const stored = value as Partial<QuantenlosIbmStored>;
  return {
    hinterlegt: Boolean(stored.tokenEncrypted),
    suffix: stored.suffix ?? null,
    gesetztAm: stored.gesetztAm ?? null,
  };
}
