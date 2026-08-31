'use server';

// =============================================================================
// ELSTER-Kontoabfrage (Stufe 2) — Server-Action.
//
// Ablauf bewusst dreigeteilt:
//   1. Tx A: Guards (Vertraulich-Ventil!) + Steuernummer/Kanzleiname laden.
//   2. Bridge-Call OHNE offene DB-Tx (Netz-Roundtrip bis 120 s — niemals eine
//      Transaktion darüber offen halten).
//   3. Tx B: Vorgang persistieren (append-only Historie) + Evidence-Record.
//
// Die Portalzertifikat-PIN wird pro Vorgang durchgereicht und weder
// persistiert noch geloggt noch in den Audit-Trail geschrieben.
// =============================================================================

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { withTenantContext } from '@taxtronik/db';
import {
  ElsterBridgeClient,
  ElsterNotConfiguredError,
  ElsterKontoabfrageInputError,
  ElsterBridgeHttpError,
  type KontoabfrageTeil,
  type Uebertragung,
} from '@taxtronik/elster';
import { evidenceService } from '@/server/container';
import { assertClientAccessTx } from '@/server/auth/rbac';
import { checkRateLimit } from '@/server/rate-limit';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';

const STEUERARTEN = ['ESt', 'KSt', 'USt', 'LSt', 'GewSt', 'ZaSt', 'KapESt'] as const;

const Schema = z.object({
  clientId: z.string().uuid(),
  taxRegistrationId: z.string().uuid(),
  art: z.enum(['I', 'O', 'ZS']),
  steuerart: z.enum(STEUERARTEN).optional().or(z.literal('')),
  /** ZS: vierstelliges Jahr. */
  jahr: z
    .string()
    .regex(/^[0-9]{4}$/)
    .optional()
    .or(z.literal('')),
  /** I: Wertstellungsdatum TTMMJJJJ. */
  wertstellungsdatum: z
    .string()
    .regex(/^[0-9]{8}$/)
    .optional()
    .or(z.literal('')),
  wertstellungsdatumOption: z.enum(['J', 'V']).optional().or(z.literal('')),
  /** PIN des Portalzertifikats — nur durchgereicht, nie gespeichert. */
  pin: z.string().min(1).max(200),
  echtfall: z.boolean(),
  /** Test-Übertragung: Testmerker gemäß ERiC-/Bridge-Doku. */
  testmerker: z.string().max(20).optional().or(z.literal('')),
});

export async function kontoabfrageAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const g = await staffActionGuard();
  if (!g.ok) return g;
  const { tenantId, staffId, ctx, session } = g;

  // Jede Abfrage löst einen echten ELSTER-Vorgang aus (Bridge-Roundtrip bis
  // 120 s, PIN durchgereicht). Drossel gegen Echtfall-Spam / Portalzertifikat-
  // Sperrgefahr: pro Mitarbeiter + tenant-weiter Backstop.
  const rlUser = await checkRateLimit(`elster-konto:${staffId}`, { max: 5, windowSec: 600 });
  if (!rlUser.ok) {
    return { ok: false, error: 'Zu viele ELSTER-Abfragen — bitte einige Minuten warten.' };
  }
  const rlTenant = await checkRateLimit(`elster-konto-tenant:${tenantId}`, {
    max: 20,
    windowSec: 600,
  });
  if (!rlTenant.ok) {
    return {
      ok: false,
      error: 'Zu viele ELSTER-Abfragen in der Kanzlei — bitte einige Minuten warten.',
    };
  }

  const parsed = Schema.safeParse({
    clientId: formData.get('clientId'),
    taxRegistrationId: formData.get('taxRegistrationId'),
    art: formData.get('art'),
    steuerart: formData.get('steuerart') ?? '',
    jahr: formData.get('jahr') ?? '',
    wertstellungsdatum: formData.get('wertstellungsdatum') ?? '',
    wertstellungsdatumOption: formData.get('wertstellungsdatumOption') ?? '',
    pin: formData.get('pin'),
    echtfall: formData.get('echtfall') === 'on',
    testmerker: formData.get('testmerker') ?? '',
  });
  if (!parsed.success) return { ok: false, error: 'Validierungsfehler — bitte Eingaben prüfen.' };
  const d = parsed.data;

  if (!d.echtfall && !d.testmerker) {
    return {
      ok: false,
      error: 'Test-Übertragung braucht einen Testmerker (oder Echtfall explizit bestätigen).',
    };
  }

  // Teil-Abfrage strukturiert bauen; die fachliche Validierung (Steuernummer-
  // Format, Pflichtfelder je Art) macht der Bridge-Client lokal, BEVOR ein
  // ELSTER-Vorgang entsteht.
  let teil: KontoabfrageTeil;

  // --- Tx A: Guards + Stammdaten -------------------------------------------
  const stammdaten = await withTenantContext(ctx, async (tx) => {
    await assertClientAccessTx(tx, session, d.clientId);
    const client = await tx.client.findUnique({
      where: { id: d.clientId },
      select: { name: true },
    });
    if (!client) return null;
    const registration = await tx.clientTaxRegistration.findFirst({
      where: { id: d.taxRegistrationId, tenantId, clientId: d.clientId, archivedAt: null },
    });
    if (!registration) return null;
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return {
      steuernummer: registration.numberElster,
      taxRegistrationId: registration.id,
      kanzlei: tenant?.name ?? 'Kanzlei',
    };
  });
  if (!stammdaten)
    return {
      ok: false,
      error: 'Mandant oder aktive Steuerverbindung nicht gefunden. Bitte Auswahl neu laden.',
    };
  if (!stammdaten.steuernummer) {
    return {
      ok: false,
      error:
        'Keine Steuernummer hinterlegt — bitte zuerst unter „Bearbeiten" erfassen (13-stelliges ELSTER-Format).',
    };
  }

  const steuernummer = stammdaten.steuernummer;
  if (d.art === 'ZS') {
    if (!d.steuerart || !d.jahr)
      return { ok: false, error: 'Sollstellungen brauchen Steuerart und Jahr.' };
    teil = { art: 'ZS', steuernummer, steuerart: d.steuerart, zeitraum: d.jahr };
  } else if (d.art === 'I') {
    if (!d.wertstellungsdatum || !d.wertstellungsdatumOption) {
      return {
        ok: false,
        error: 'Istbuchungen brauchen Wertstellungsdatum (TTMMJJJJ) und Option.',
      };
    }
    teil = {
      art: 'I',
      steuernummer,
      steuerart: d.steuerart || 'alle',
      wertstellungsdatum: d.wertstellungsdatum,
      wertstellungsdatumOption: d.wertstellungsdatumOption,
    };
  } else {
    teil = { art: 'O', steuernummer };
  }

  const uebertragung: Uebertragung = d.echtfall
    ? { echtfall: true }
    : { testmerker: d.testmerker! };

  // --- Bridge-Call (außerhalb jeder DB-Tx) ----------------------------------
  let response;
  try {
    const client = new ElsterBridgeClient();
    response = await client.kontoabfrage({
      abfragen: [teil],
      datenLieferant: stammdaten.kanzlei,
      pin: d.pin,
      uebertragung,
    });
  } catch (e) {
    if (e instanceof ElsterNotConfiguredError) {
      return {
        ok: false,
        error: 'ELSTER-Bridge ist nicht konfiguriert (ELSTER_BRIDGE_URL/TOKEN).',
      };
    }
    if (e instanceof ElsterKontoabfrageInputError) {
      return { ok: false, error: e.message };
    }
    if (e instanceof ElsterBridgeHttpError) {
      // HTTP-Fehler der Bridge (kein ELSTER-Vorgang entstanden bzw. nicht
      // nachweisbar) — nicht persistieren, nur melden. Message ist bereits
      // Nutzdaten-frei (nur Status + strukturierter Fehlercode).
      return { ok: false, error: e.message };
    }
    return { ok: false, error: 'Bridge nicht erreichbar — Container/URL prüfen.' };
  }

  // --- Tx B: Vorgang persistieren + Evidence --------------------------------
  await withTenantContext(ctx, async (tx) => {
    const row = await tx.elsterKontoabfrage.create({
      data: {
        tenantId,
        clientId: d.clientId,
        taxRegistrationId: stammdaten.taxRegistrationId,
        taxNumberSnapshot: stammdaten.steuernummer,
        art: d.art,
        steuerart: d.art === 'O' ? null : d.steuerart || (d.art === 'I' ? 'alle' : null),
        zeitraum: d.art === 'ZS' ? d.jahr! : d.art === 'I' ? d.wertstellungsdatum! : null,
        echtfall: d.echtfall,
        ok: response.ok,
        returnCode: response.returnCode,
        nutzdatenTicket: response.nutzdatenTicket,
        result: response.result,
        errorText: response.errorText,
        requestedBy: staffId,
      },
    });
    // Evidence: NUR Metadaten — keine PIN, kein Ergebnis-Volltext (Steuerdaten
    // liegen in der RLS-geschützten Historie, nicht im Audit-Log).
    await evidenceService.record(tx, {
      tenantId,
      actorType: 'STAFF',
      actorId: staffId,
      action: 'elster.kontoabfrage',
      resourceType: 'elster_kontoabfrage',
      resourceId: row.id,
      after: {
        clientId: d.clientId,
        taxRegistrationId: stammdaten.taxRegistrationId,
        art: d.art,
        steuerart: teil.art === 'O' ? null : teil.steuerart,
        zeitraum: row.zeitraum,
        echtfall: d.echtfall,
        ok: response.ok,
        returnCode: response.returnCode,
        nutzdatenTicket: response.nutzdatenTicket,
      },
    });
  });

  revalidatePath(`/staff/clients/${d.clientId}/elster`);
  if (!response.ok) {
    return {
      ok: false,
      error: `ELSTER meldet Fehler (returnCode ${response.returnCode})${response.errorText ? `: ${response.errorText}` : ''} — Vorgang wurde in der Historie protokolliert.`,
    };
  }
  return { ok: true };
}
