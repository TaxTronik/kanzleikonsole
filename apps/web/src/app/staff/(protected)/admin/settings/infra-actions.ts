'use server';

// Infrastruktur-Settings: Bundesland (Feiertage für Steuertermine) + RFC-3161-
// Zeitstempel-Behörde (TSA). Aus der früheren settings/actions.ts herausgelöst.

import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { withTenantContext } from '@taxtronik/db';
import { env } from '@taxtronik/config';
import { assertPublicUrl, urlTargetErrorMessage } from '@/server/http/ssrf-guard';
import { networkFailure } from '@/server/http/network-error';
import { toActionError } from '@/server/actions/to-action-error';
import { log } from '@/server/logger';
import { writeTaxRegionTx } from '@/server/settings/tax-region';
import { writeTsaConfigTx, type TsaConfig } from '@/server/settings/tsa';
import { createRfc3161Adapter, getTsaProvider } from '@taxtronik/evidence';
import type { GermanRegion } from '@taxtronik/tax';
import { staffAction, type ActionResult } from '@/server/actions/staff-action';
import { audit } from '@/server/actions/audit';
import { formDefault, parseFormData } from '@/server/actions/form-data';

/** F-03: abgewiesene TSA-URL ohne rohen Fehlertext; Unbekanntes nur ins Log. */
function tsaUrlErrorMessage(error: unknown): string {
  return urlTargetErrorMessage(error) ?? toActionError(error).error;
}

/**
 * F-03: Ergebnis des TSA-Verbindungstests über Fehlerklasse/-code eingeordnet.
 * Die Detailursache (HTTP-Status, PKIStatus) steht im Server-Log.
 */
function tsaTestErrorMessage(error: unknown): string {
  const target = urlTargetErrorMessage(error);
  if (target) return target;
  const network = networkFailure(error);
  if (network?.kind === 'timeout') return 'Die TSA hat nicht rechtzeitig geantwortet.';
  if (network) return `Die TSA ist nicht erreichbar${network.code ? ` (${network.code})` : ''}.`;
  log.warn(
    {
      component: 'tsa-test',
      errName: error instanceof Error ? error.name : typeof error,
      err: error instanceof Error ? error.message : String(error),
    },
    'TSA-Test fehlgeschlagen',
  );
  return 'Der TSA-Test ist fehlgeschlagen (keine gültige RFC-3161-Antwort). Details stehen im Server-Log.';
}

// ----------------------------------------------------------------------------
// Bundesland (für Steuertermin-Feiertage)
// ----------------------------------------------------------------------------

const VALID_REGIONS: GermanRegion[] = [
  'DE-BW',
  'DE-BY',
  'DE-BE',
  'DE-BB',
  'DE-HB',
  'DE-HH',
  'DE-HE',
  'DE-MV',
  'DE-NI',
  'DE-NW',
  'DE-RP',
  'DE-SL',
  'DE-SN',
  'DE-ST',
  'DE-SH',
  'DE-TH',
];

const TaxRegionSchema = z.object({
  region: formDefault('', z.string().optional().or(z.literal(''))),
  // Haken „Mariä Himmelfahrt“: gesetzt, sobald das Feld im Formular steht.
  assumptionHoliday: z.preprocess((value) => value !== null, z.boolean()),
});

export async function saveTaxRegionAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(TaxRegionSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const raw = parsed.data.region ?? '';
      const region: GermanRegion | null =
        raw && (VALID_REGIONS as readonly string[]).includes(raw) ? (raw as GermanRegion) : null;

      // Mariä Himmelfahrt (nur DE-BY relevant, gemeindeabhängig): Checkbox nur dort
      // sichtbar. Für andere Länder immer Default true speichern (irrelevant), damit
      // ein Regionswechsel den Bayern-Wert nicht als false verschluckt.
      const assumptionHoliday = region === 'DE-BY' ? parsed.data.assumptionHoliday : true;

      const { ctx } = g;
      await withTenantContext(ctx, async (tx) => {
        await writeTaxRegionTx(tx, ctx, region, assumptionHoliday);
        await audit(tx, g, {
          action: 'tenant.settings.tax_region.update',
          resourceType: 'tenant_setting',
          resourceId: 'tax_region',
          after: { region, assumptionHoliday },
        });
      });
    },
    revalidate: '/staff/admin/settings',
  });
}

// ----------------------------------------------------------------------------
// TSA (RFC-3161-Zeitstempel-Behörde)
// ----------------------------------------------------------------------------

const TsaSchema = z.object({
  providerId: formDefault('', z.string().max(50)),
  customUrl: formDefault('', z.string().max(500).optional().or(z.literal(''))),
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
  return staffAction({
    guard: { requireAdmin: true },
    run: async (g) => {
      const parsed = parseFormData(TsaSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;
      if (env.NODE_ENV === 'production' && !parsed.data.providerId) {
        return {
          ok: false,
          error:
            'Self-Timestamp ist in Produktion gesperrt. Bitte eine externe RFC-3161-TSA waehlen.',
        };
      }

      if (parsed.data.providerId === 'custom' && !(parsed.data.customUrl ?? '').trim()) {
        return { ok: false, error: 'Bei „Eigener TSA-Server" eine URL angeben.' };
      }

      // NEW1: SSRF-Schutz. Bei Custom-TSA-URL prüfen, dass sie nicht auf
      // private Adressen zeigt — der Worker würde sie täglich anfetchen.
      if (parsed.data.providerId === 'custom') {
        try {
          await assertPublicUrl(parsed.data.customUrl!.trim());
        } catch (e) {
          return { ok: false, error: tsaUrlErrorMessage(e) };
        }
      }

      const { ctx } = g;
      const cfg: TsaConfig = {
        providerId: parsed.data.providerId,
        customUrl: parsed.data.customUrl ?? '',
      };
      await withTenantContext(ctx, async (tx) => {
        await writeTsaConfigTx(tx, ctx, cfg);
        await audit(tx, g, {
          action: 'tenant.settings.tsa.update',
          resourceType: 'tenant_setting',
          resourceId: 'evidence.tsa',
          after: cfg,
        });
      });
    },
    revalidate: ['/staff/admin/settings/evidence', '/staff/admin'],
  });
}

export async function testTsaAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  return staffAction({
    guard: { requireAdmin: true },
    run: async () => {
      const parsed = parseFormData(TsaSchema, formData, {
        absentAsNull: true,
        errorMessage: 'Validierungsfehler.',
      });
      if (!parsed.ok) return parsed;

      const url = resolveTsaUrlFromInput({
        providerId: parsed.data.providerId,
        customUrl: parsed.data.customUrl ?? '',
      });
      if (!url) return { ok: false, error: 'Kein Server gewählt.' };

      // NEW1: SSRF-Schutz auch beim Test (Admin-supplied URL nicht direkt fetchen).
      try {
        await assertPublicUrl(url);
      } catch (e) {
        return { ok: false, error: tsaUrlErrorMessage(e) };
      }

      try {
        // Factory statt nacktem Konstruktor: so gelten auch die vom Betreiber
        // ueber TSA_TRUSTED_ROOTS_FILE bereitgestellten Trust-Roots im UI-Test.
        const adapter = createRfc3161Adapter(url, 8_000);
        const payload = randomBytes(32);
        const result = await adapter.timestamp(payload);
        const response = result.tsaResponseBlob ? Buffer.from(result.tsaResponseBlob) : null;
        if (!(await adapter.verify(payload, response))) {
          return {
            ok: false,
            error:
              'Die TSA antwortet, aber der Token ist nicht an den Test-Hash oder einen konfigurierten Trust-Anchor gebunden.',
          };
        }
        // Erfolgsmeldung im Feld `error` (tsa-form zeigt sie bei ok: true an).
        return {
          ok: true,
          error: `Antwort ${response?.byteLength ?? 0} Bytes — Status granted und trust-verifiziert (${result.timestampedAt}).`,
        };
      } catch (e) {
        return { ok: false, error: tsaTestErrorMessage(e) };
      }
    },
  });
}
