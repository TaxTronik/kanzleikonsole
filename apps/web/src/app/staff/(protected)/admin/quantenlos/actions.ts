'use server';

// =============================================================================
// Quantenlos-Actions — blinde Compliance-Stichprobe (Admin/Partner).
//
// Die Ziehung ist Compliance-Hoheit (sie erzeugt Review-Aufgaben + Chain-
// Einträge) → ADMIN/PARTNER wie Audit-Log/GwG. Geschäftslogik liegt in
// @/server/risk/los — hier nur Validierung + Gate + Revalidate.
// =============================================================================

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { isRiskLayerConfigured } from '@taxtronik/risk-layer';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { toActionError, ForbiddenError } from '@/server/auth/rbac';
import { readModules } from '@/server/settings/modules';
import type { TenantContext } from '@taxtronik/db';
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

/** Rahmen-Vorschau: wie viele Subsumtionen liegen im Zeitraum? (nur Anzahl) */
export async function rahmenVorschauAction(
  input: z.infer<typeof ZeitraumSchema>,
): Promise<ActionResult & { n?: number }> {
  try {
    const parsed = ZeitraumSchema.parse(input);
    const g = await guard();
    if (!g.ok) return g;
    const rahmen = await buildLosRahmen(g.ctx, parsed);
    return { ok: true, n: rahmen.length };
  } catch (e) {
    return toActionError(e);
  }
}

const ZiehenSchema = ZeitraumSchema.extend({
  k: z.number().int().min(1).max(500),
  backend: z.enum(['qpu', 'simulator', 'csprng']),
});

export async function losZiehenAction(
  input: z.infer<typeof ZiehenSchema>,
): Promise<ActionResult & { ergebnis?: LosZiehungErgebnis }> {
  try {
    const parsed = ZiehenSchema.parse(input);
    const g = await guard();
    if (!g.ok) return g;
    const ergebnis = await zieheLosStichprobe(g.ctx, {
      zeitraum: { von: parsed.von, bis: parsed.bis },
      k: parsed.k,
      backend: parsed.backend,
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
    const ergebnis = await holeLosAb(g.ctx);
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
    const ergebnis = await pruefeLosNachweis(g.ctx, parsed.auditId, { online: parsed.online });
    return { ok: true, ergebnis };
  } catch (e) {
    return toActionError(e);
  }
}
