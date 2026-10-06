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
import {
  CircuitOpenError,
  isRiskLayerConfigured,
  RiskLayerHttpError,
  RiskLayerNotConfiguredError,
} from '@taxtronik/risk-layer';
import { withTenantContext, type TenantContext } from '@taxtronik/db';
import { Prisma } from '@taxtronik/db/prisma-client';
import { SsrfGuardError } from '@taxtronik/http-utils';
import {
  parseActionInput,
  staffAction,
  type ActionFailure,
  type ActionResult,
  type StaffGuardOptions,
} from '@/server/actions/staff-action';
import { toActionError, ForbiddenError } from '@/server/auth/rbac';
import { networkFailure } from '@/server/http/network-error';
import { readModules } from '@/server/settings/modules';
import {
  readIbmToken,
  writeIbmTokenTx,
  deleteIbmTokenTx,
  getIbmTokenStatus,
  type IbmTokenStatus,
} from '@/server/settings/quantenlos';
import { evidenceService } from '@/server/container';
import {
  buildLosRahmen,
  zieheLosStichprobe,
  holeLosAb,
  resumeLosStart,
  resumeLosStartProof,
  releaseLosStart,
  pruefeLosNachweis,
  type LosZiehungErgebnis,
  type LosPruefErgebnis,
} from '@/server/risk';

const PFAD = '/staff/admin/quantenlos';

function engineMessage(e: RiskLayerHttpError): string {
  try {
    const body = JSON.parse(e.body) as Record<string, unknown>;
    const msg = body['fehler'] ?? body['error'] ?? body['detail'] ?? body['message'];
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  } catch {
    // Non-JSON response; fall through to status-only message.
  }
  return `Risk-Engine antwortete mit HTTP ${e.status}.`;
}

function toQuantenlosActionError(e: unknown): ActionFailure {
  // LosRahmenLeerError, LosNachweisInkonsistentError und LosStateConflictError
  // sind ActionErrors: toActionError (unten) reicht ihre Meldung durch.
  if (e instanceof RiskLayerNotConfiguredError) {
    return {
      ok: false,
      error:
        'Risk-Engine ist nicht konfiguriert. Bitte RISK_LAYER_URL und RISK_LAYER_TOKEN setzen.',
    };
  }
  if (e instanceof RiskLayerHttpError) {
    return { ok: false, error: `Risk-Engine: ${engineMessage(e)}` };
  }
  if (e instanceof SsrfGuardError) {
    return {
      ok: false,
      error:
        `Risk-Engine-URL wurde vom SSRF-Schutz blockiert (${e.reason}). ` +
        'Prüfe RISK_LAYER_URL; Risk-Layer-Ziele dürfen interne IPs nutzen.',
    };
  }
  if (e instanceof CircuitOpenError) {
    return {
      ok: false,
      error:
        'Risk-Engine ist vorübergehend gesperrt, weil mehrere Aufrufe fehlgeschlagen sind. Bitte später erneut versuchen.',
    };
  }
  if (e instanceof z.ZodError) {
    const first = e.issues[0];
    return {
      ok: false,
      error:
        'Risk-Engine-Antwort passt nicht zum erwarteten Quantenlos-Schema. ' +
        `Vermutlich läuft eine alte oder inkompatible Engine. Detail: ${first?.path.join('.') || 'Antwort'} ${first?.message ?? ''}`.trim(),
    };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return {
      ok: false,
      error: `Datenbankfehler beim Quantenlos (${e.code}). Bitte Server-Log prüfen.`,
    };
  }
  // F-03: Netzwerkfehler über Fehlername bzw. Fehlercode; fachliche Fehler aus
  // @/server/risk/los sind ActionErrors und laufen über toActionError.
  const network = networkFailure(e);
  if (network?.kind === 'timeout') {
    return {
      ok: false,
      error: 'Risk-Engine hat nicht rechtzeitig geantwortet. Bitte Engine-Status und Logs prüfen.',
    };
  }
  if (network) {
    return {
      ok: false,
      error:
        `Risk-Engine nicht erreichbar${network.code ? ` (${network.code})` : ''}. ` +
        'Prüfe Container, RISK_LAYER_URL und Bearer-Token.',
    };
  }
  return toActionError(e);
}

/** Ziehung ist Compliance-Hoheit → ADMIN/PARTNER (Gate von staffAction). */
const LOS_GATE: StaffGuardOptions = { requireAdmin: true };

/** Nach dem Gate: Subsumtions-Modul aktiv und Risk-Engine konfiguriert. */
async function assertLosVerfuegbar(ctx: TenantContext): Promise<void> {
  const modules = await readModules(ctx);
  if (!modules.risk)
    throw new ForbiddenError('Das Subsumtions-Modul ist für diese Kanzlei deaktiviert.');
  if (!isRiskLayerConfigured()) {
    throw new ForbiddenError(
      'Die Risk-Engine ist nicht konfiguriert — Quantenlos derzeit nicht möglich.',
    );
  }
}

const ZeitraumSchema = z.object({
  von: z.string().date(),
  bis: z.string().date(),
});

const RahmenTypSchema = z.enum(['subsumtion', 'audit']);

/** Rahmen-Vorschau: wie viele Items liegen im Zeitraum? (nur Anzahl) */
export async function rahmenVorschauAction(
  input: z.infer<typeof ZeitraumSchema> & { rahmenTyp?: z.infer<typeof RahmenTypSchema> },
): Promise<ActionResult & { n?: number }> {
  const checked = parseActionInput(
    ZeitraumSchema.extend({ rahmenTyp: RahmenTypSchema.optional() }),
    input,
  );
  if (!checked.ok) return checked;
  const parsed = checked.data;
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      const rahmen = await buildLosRahmen(g.ctx, parsed, parsed.rahmenTyp ?? 'subsumtion');
      return { n: rahmen.length };
    },
    onError: toQuantenlosActionError,
  });
}

const ZiehenSchema = ZeitraumSchema.extend({
  k: z.number().int().min(1).max(500),
  backend: z.enum(['qpu', 'simulator', 'csprng']),
  rahmenTyp: RahmenTypSchema.optional(),
});

export async function losZiehenAction(
  input: z.infer<typeof ZiehenSchema>,
): Promise<ActionResult & { ergebnis?: LosZiehungErgebnis }> {
  const checked = parseActionInput(ZiehenSchema, input);
  if (!checked.ok) return checked;
  const parsed = checked.data;
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      // Token nur lesen, wenn die IBM-Seite ihn überhaupt braucht (qpu).
      const ibmToken =
        parsed.backend === 'qpu' ? ((await readIbmToken(g.ctx)) ?? undefined) : undefined;
      const ergebnis = await zieheLosStichprobe(g.ctx, {
        zeitraum: { von: parsed.von, bis: parsed.bis },
        k: parsed.k,
        backend: parsed.backend,
        rahmenTyp: parsed.rahmenTyp ?? 'subsumtion',
        ibmToken,
      });
      return { ergebnis };
    },
    revalidate: PFAD,
    onError: toQuantenlosActionError,
  });
}

export async function losAbholenAction(): Promise<
  ActionResult & { ergebnis?: LosZiehungErgebnis }
> {
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      const ibmToken = (await readIbmToken(g.ctx)) ?? undefined;
      const ergebnis = await holeLosAb(g.ctx, undefined, { ibmToken });
      return { ergebnis };
    },
    revalidate: PFAD,
    onError: toQuantenlosActionError,
  });
}

const PruefenSchema = z.object({
  auditId: z.string().regex(/^\d+$/),
  online: z.boolean().optional(),
});

const ResumeSchema = z
  .object({
    attemptId: z.string().uuid(),
    jobId: z.string().trim().max(200),
    proofJson: z.string().max(1_000_000).optional(),
  })
  .refine((v) => Boolean(v.jobId) !== Boolean(v.proofJson?.trim()), {
    message: 'Job-ID oder gespeicherten Nachweis angeben.',
  });

export async function losStartWiederaufnehmenAction(input: {
  attemptId: string;
  jobId: string;
  proofJson?: string;
}): Promise<ActionResult & { ergebnis?: LosZiehungErgebnis }> {
  const checked = parseActionInput(ResumeSchema, input);
  if (!checked.ok) return checked;
  const parsed = checked.data;
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      const ergebnis = parsed.proofJson?.trim()
        ? await resumeLosStartProof(g.ctx, {
            attemptId: parsed.attemptId,
            proof: JSON.parse(parsed.proofJson),
          })
        : await resumeLosStart(g.ctx, {
            ...parsed,
            ibmToken: (await readIbmToken(g.ctx)) ?? undefined,
          });
      return { ergebnis };
    },
    revalidate: PFAD,
    onError: toQuantenlosActionError,
  });
}

const ReleaseSchema = z.object({
  attemptId: z.string().uuid(),
  reason: z.string().trim().min(30).max(2000),
  confirmedNotExecuted: z.literal(true),
});

export async function losStartFreigebenAction(input: {
  attemptId: string;
  reason: string;
  confirmedNotExecuted: boolean;
}): Promise<ActionResult> {
  const checked = parseActionInput(ReleaseSchema, input);
  if (!checked.ok) return checked;
  const parsed = checked.data;
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      await releaseLosStart(g.ctx, parsed);
    },
    revalidate: PFAD,
    onError: toQuantenlosActionError,
  });
}

export async function losPruefenAction(
  input: z.infer<typeof PruefenSchema>,
): Promise<ActionResult & { ergebnis?: LosPruefErgebnis }> {
  const checked = parseActionInput(PruefenSchema, input);
  if (!checked.ok) return checked;
  const parsed = checked.data;
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      const ibmToken = parsed.online ? ((await readIbmToken(g.ctx)) ?? undefined) : undefined;
      const ergebnis = await pruefeLosNachweis(g.ctx, parsed.auditId, {
        online: parsed.online,
        ibmToken,
      });
      return { ergebnis };
    },
    onError: toQuantenlosActionError,
  });
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
  const checked = parseActionInput(TokenSchema, input);
  if (!checked.ok) return checked;
  const parsed = checked.data;
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      await withTenantContext(g.ctx, async (tx) => {
        await writeIbmTokenTx(tx, g.ctx, parsed.token);
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
      return { status: await getIbmTokenStatus(g.ctx) };
    },
  });
}

export async function ibmTokenEntfernenAction(): Promise<
  ActionResult & { status?: IbmTokenStatus }
> {
  return staffAction({
    guard: LOS_GATE,
    run: async (g) => {
      await assertLosVerfuegbar(g.ctx);
      await withTenantContext(g.ctx, async (tx) => {
        await deleteIbmTokenTx(tx, g.ctx);
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
      return { status: { hinterlegt: false, suffix: null, gesetztAm: null } };
    },
    revalidate: PFAD,
  });
}
