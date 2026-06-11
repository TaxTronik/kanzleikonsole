'use server';

// =============================================================================
// Quantenlos-Actions — blinde Compliance-Stichprobe (Admin/Partner).
//
// Die Ziehung ist Compliance-Hoheit (sie erzeugt Review-Aufgaben + Chain-
// Einträge) → ADMIN/PARTNER wie Audit-Log/GwG. Geschäftslogik liegt in
// @/server/risk/los — hier nur Validierung + Gate + Revalidate.
//
// IBM-Zugang: zentral verwaltet (verschlüsselt in `quantenlos.ibm`) — diese
// Schicht liest den Token und reicht ihn pro Engine-Request durch (qpu-
// Ziehen, Abholen, Online-Prüfung). Er verlässt den Server NIE Richtung
// Browser; Speichern/Entfernen sind chain-auditiert OHNE den Token selbst.
// =============================================================================

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { toActionError, ForbiddenError } from '@/server/auth/rbac';
import { readModules } from '@/server/settings/modules';
import {
  readIbmToken,
  writeIbmToken,
  deleteIbmToken,
  getIbmTokenStatus,
  type IbmTokenStatus,
} from '@/server/settings/quantenlos';
import { evidenceService } from '@/server/container';
import {
  buildLosRahmen,
  zieheLosStichprobe,
  holeLosAb,
  pruefeLosNachweis,
  type LosZiehungErgebnis,
  type LosPruefErgebnis,
} from '@/server/risk';

const PFAD = '/staff/admin/quantenlos';

async function guard(): Promise<{ ok: true; ctx: TenantContext } | ({ ok: false } & { error: string })> {
  const g = await staffActionGuard({ requireAdmin: true });
  if (!g.ok) return g;
  const modules = await readModules(g.ctx);
  if (!modules.risk) throw new ForbiddenError('Das Subsumtions-Modul ist für diese Kanzlei deaktiviert.');
  if (!isRiskLayerConfigured()) {
    throw new ForbiddenError('Die Risk-Engine ist nicht konfiguriert — Quantenlos derzeit nicht möglich.');
  }
  return { ok: true, ctx: g.ctx };
}

const ZeitraumSchema = z.object({
  von: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum YYYY-MM-DD'),
  bis: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum YYYY-MM-DD'),
});

const RahmenTypSchema = z.enum(['subsumtion', 'audit']);

/** Rahmen-Vorschau: wie viele Items liegen im Zeitraum? (nur Anzahl) */
export async function rahmenVorschauAction(
  input: z.infer<typeof ZeitraumSchema> & { rahmenTyp?: z.infer<typeof RahmenTypSchema> },
): Promise<ActionResult & { n?: number }> {
  try {
    const parsed = ZeitraumSchema.extend({ rahmenTyp: RahmenTypSchema.optional() }).parse(input);
    const g = await guard();
    if (!g.ok) return g;
    const rahmen = await buildLosRahmen(g.ctx, parsed, parsed.rahmenTyp ?? 'subsumtion');
    return { ok: true, n: rahmen.length };
  } catch (e) {
    return toActionError(e);
  }
}

const ZiehenSchema = ZeitraumSchema.extend({
  k: z.number().int().min(1).max(500),
  backend: z.enum(['qpu', 'simulator', 'csprng']),
  rahmenTyp: RahmenTypSchema.optional(),
});

export async function losZiehenAction(
  input: z.infer<typeof ZiehenSchema>,
): Promise<ActionResult & { ergebnis?: LosZiehungErgebnis }> {
  try {
    const parsed = ZiehenSchema.parse(input);
    const g = await guard();
    if (!g.ok) return g;
    // Token nur lesen, wenn die IBM-Seite ihn überhaupt braucht (qpu).
    const ibmToken = parsed.backend === 'qpu' ? (await readIbmToken(g.ctx)) ?? undefined : undefined;
    const ergebnis = await zieheLosStichprobe(g.ctx, {
      zeitraum: { von: parsed.von, bis: parsed.bis },
      k: parsed.k,
      backend: parsed.backend,
      rahmenTyp: parsed.rahmenTyp ?? 'subsumtion',
      ibmToken,
    });
    revalidatePath(PFAD);
    return { ok: true, ergebnis };
  } catch (e) {
    return toActionError(e);
  }
}

export async function losAbholenAction(): Promise<ActionResult & { ergebnis?: LosZiehungErgebnis }> {
  try {
    const g = await guard();
    if (!g.ok) return g;
    const ibmToken = (await readIbmToken(g.ctx)) ?? undefined;
    const ergebnis = await holeLosAb(g.ctx, undefined, { ibmToken });
    revalidatePath(PFAD);
    return { ok: true, ergebnis };
  } catch (e) {
    return toActionError(e);
  }
}

const PruefenSchema = z.object({
  auditId: z.string().regex(/^\d+$/),
  online: z.boolean().optional(),
});

export async function losPruefenAction(
  input: z.infer<typeof PruefenSchema>,
): Promise<ActionResult & { ergebnis?: LosPruefErgebnis }> {
  try {
    const parsed = PruefenSchema.parse(input);
    const g = await guard();
    if (!g.ok) return g;
    const ibmToken = parsed.online ? (await readIbmToken(g.ctx)) ?? undefined : undefined;
    const ergebnis = await pruefeLosNachweis(g.ctx, parsed.auditId, {
      online: parsed.online,
      ibmToken,
    });
    return { ok: true, ergebnis };
  } catch (e) {
    return toActionError(e);
  }
}

// --- IBM-Quantum-Zugang (zentrale Config) ------------------------------------

const TokenSchema = z.object({
  // IBM-Cloud-API-Keys sind ~44 Zeichen; großzügig validieren, aber Unfug
  // (Leerstring, Roman) abfangen.
  token: z.string().trim().min(8, 'Token zu kurz').max(512, 'Token zu lang'),
});

export async function ibmTokenSpeichernAction(
  input: z.infer<typeof TokenSchema>,
): Promise<ActionResult & { status?: IbmTokenStatus }> {
  try {
    const parsed = TokenSchema.parse(input);
    const g = await guard();
    if (!g.ok) return g;
    await writeIbmToken(g.ctx, parsed.token);
    await withTenantContext(g.ctx, async (tx) => {
      await evidenceService.record(tx, {
        tenantId: g.ctx.tenantId,
        actorType: g.ctx.actorType,
        actorId: g.ctx.actorId,
        action: 'tenant.settings.quantenlos_ibm.update',
        resourceType: 'tenant_setting',
        resourceId: 'quantenlos.ibm',
        // NIE den Token in die Chain — nur der maskierte Suffix.
        after: { token: `***${parsed.token.slice(-4)}` },
      });
    });
    revalidatePath(PFAD);
    return { ok: true, status: await getIbmTokenStatus(g.ctx) };
  } catch (e) {
    return toActionError(e);
  }
}

export async function ibmTokenEntfernenAction(): Promise<ActionResult & { status?: IbmTokenStatus }> {
  try {
    const g = await guard();
    if (!g.ok) return g;
    await deleteIbmToken(g.ctx);
    await withTenantContext(g.ctx, async (tx) => {
      await evidenceService.record(tx, {
        tenantId: g.ctx.tenantId,
        actorType: g.ctx.actorType,
        actorId: g.ctx.actorId,
        action: 'tenant.settings.quantenlos_ibm.reset',
        resourceType: 'tenant_setting',
        resourceId: 'quantenlos.ibm',
        after: { token: null },
      });
    });
    revalidatePath(PFAD);
    return { ok: true, status: { hinterlegt: false, suffix: null, gesetztAm: null } };
  } catch (e) {
    return toActionError(e);
  }
}
