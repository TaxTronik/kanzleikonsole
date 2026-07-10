'use server';

// Infrastruktur-Settings: Bundesland (Feiertage für Steuertermine) + RFC-3161-
// Zeitstempel-Behörde (TSA). Aus der früheren settings/actions.ts herausgelöst.

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { randomBytes } from 'node:crypto';
import { withTenantContext } from '@taxtronik/db';
import { env } from '@taxtronik/config';
import { evidenceService } from '@/server/container';
import { assertPublicHost } from '@/server/http/ssrf-guard';
import { writeTaxRegion } from '@/server/settings/tax-region';
import { writeTsaConfig, type TsaConfig } from '@/server/settings/tsa';
import { Rfc3161HttpAdapter, getTsaProvider } from '@taxtronik/evidence';
import type { GermanRegion } from '@taxtronik/tax';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';

// ----------------------------------------------------------------------------
// Bundesland (für Steuertermin-Feiertage)
// ----------------------------------------------------------------------------

const VALID_REGIONS: GermanRegion[] = [
  'DE-BW','DE-BY','DE-BE','DE-BB','DE-HB','DE-HH','DE-HE','DE-MV',
  'DE-NI','DE-NW','DE-RP','DE-SL','DE-SN','DE-ST','DE-SH','DE-TH',
];

const TaxRegionSchema = z.object({
  region: z.string().optional().or(z.literal('')),
});

export async function saveTaxRegionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const parsed = TaxRegionSchema.safeParse({ region: formData.get('region') ?? '' });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const raw = parsed.data.region ?? '';
  const region: GermanRegion | null =
    raw && (VALID_REGIONS as readonly string[]).includes(raw) ? (raw as GermanRegion) : null;

  // Mariä Himmelfahrt (nur DE-BY relevant, gemeindeabhängig): Checkbox nur dort
  // sichtbar. Für andere Länder immer Default true speichern (irrelevant), damit
  // ein Regionswechsel den Bayern-Wert nicht als false verschluckt.
  const assumptionHoliday =
    region === 'DE-BY' ? formData.get('assumptionHoliday') !== null : true;

  const { tenantId, staffId, ctx } = g;
  await writeTaxRegion(ctx, region, assumptionHoliday);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.tax_region.update',
      resourceType: 'tenant_setting',
      resourceId: 'tax_region',
      after: { region, assumptionHoliday },
    });
  });

  revalidatePath('/staff/admin/settings');
  return { ok: true };
}

// ----------------------------------------------------------------------------
// TSA (RFC-3161-Zeitstempel-Behörde)
// ----------------------------------------------------------------------------

const TsaSchema = z.object({
  providerId: z.string().max(50),
  customUrl: z.string().max(500).optional().or(z.literal('')),
});

function resolveTsaUrlFromInput(input: { providerId: string; customUrl: string }): string | null {
  if (!input.providerId) return null;
  if (input.providerId === 'custom') return input.customUrl.trim() || null;
  const p = getTsaProvider(input.providerId);
  return p?.url || null;
}

export async function saveTsaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const parsed = TsaSchema.safeParse({
    providerId: formData.get('providerId') ?? '',
    customUrl: formData.get('customUrl') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };
  if (env.NODE_ENV === 'production' && !parsed.data.providerId) {
    return {
      ok: false,
      error: 'Self-Timestamp ist in Produktion gesperrt. Bitte eine externe RFC-3161-TSA waehlen.',
    };
  }

  if (parsed.data.providerId === 'custom' && !(parsed.data.customUrl ?? '').trim()) {
    return { ok: false, error: 'Bei „Eigener TSA-Server" eine URL angeben.' };
  }

  // NEW1: SSRF-Schutz. Bei Custom-TSA-URL prüfen, dass sie nicht auf
  // private Adressen zeigt — der Worker würde sie täglich anfetchen.
  if (parsed.data.providerId === 'custom') {
    try {
      await assertPublicHost(parsed.data.customUrl!.trim());
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  const { tenantId, staffId, ctx } = g;
  const cfg: TsaConfig = {
    providerId: parsed.data.providerId,
    customUrl: parsed.data.customUrl ?? '',
  };
  await writeTsaConfig(ctx, cfg);

  await withTenantContext(ctx, async (tx) => {
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'tenant.settings.tsa.update',
      resourceType: 'tenant_setting',
      resourceId: 'evidence.tsa',
      after: cfg,
    });
  });

  revalidatePath('/staff/admin/settings/evidence');
  revalidatePath('/staff/admin');
  return { ok: true };
}

export async function testTsaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const parsed = TsaSchema.safeParse({
    providerId: formData.get('providerId') ?? '',
    customUrl: formData.get('customUrl') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler.' };

  const url = resolveTsaUrlFromInput({
    providerId: parsed.data.providerId,
    customUrl: parsed.data.customUrl ?? '',
  });
  if (!url) return { ok: false, error: 'Kein Server gewählt.' };

  // NEW1: SSRF-Schutz auch beim Test (Admin-supplied URL nicht direkt fetchen).
  try {
    await assertPublicHost(url);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  try {
    const adapter = new Rfc3161HttpAdapter(url, 8_000);
    const result = await adapter.timestamp(randomBytes(32));
    return {
      ok: true,
      error: `Antwort ${result.tsaResponseBlob?.byteLength ?? 0} Bytes — Status granted (${result.timestampedAt}).`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
