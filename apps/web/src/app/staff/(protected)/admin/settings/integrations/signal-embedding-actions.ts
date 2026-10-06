'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { riskLayerConfig } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { RiskLayerClient } from '@taxtronik/risk-layer';
import {
  staffAction,
  type ActionFailure,
  type ActionResult,
  type StaffCtx,
  type StaffGuardOptions,
} from '@/server/actions/staff-action';
import { audit } from '@/server/actions/audit';
import { log } from '@/server/logger';
import { readModules } from '@/server/settings/modules';

export interface SignalEmbeddingActionResult extends ActionResult {
  message?: string;
  jobId?: string;
  state?: string;
}

const ScheduleInputSchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), intervalDays: z.literal(7) }),
]);
const TriggerInputSchema = z.object({ confirmed: z.literal(true) });
const CancelInputSchema = z.object({ jobId: z.string().regex(/^[0-9a-f]{32}$/) });

// Der Signal-Operator ist deployment-global. TaxTronik unterstützt diesen
// Adminpfad ausschließlich im dokumentierten On-Prem-1:1-Deployment pro
// Kanzlei; dort ist der Tenant-Admin zugleich Administrator des Deployments.
const EMBEDDING_GATE: StaffGuardOptions = { requireAdmin: true };

/** Modul und Serverkonfiguration der Signal-Engine; null = verfügbar. */
async function embeddingUnavailable(guard: StaffCtx): Promise<ActionFailure | null> {
  const modules = await readModules(guard.ctx);
  if (!modules.signalEngine) {
    return { ok: false, error: 'Die Signal-Engine ist für diese Kanzlei nicht aktiviert.' };
  }
  if (!riskLayerConfig) {
    return { ok: false, error: 'Die Signal-Engine ist serverseitig nicht konfiguriert.' };
  }
  if (!riskLayerConfig.operatorToken) {
    return {
      ok: false,
      error: 'Die Signal-Engine ist nur lesbar: Der Operator-Token ist nicht konfiguriert.',
    };
  }
  return null;
}

/** Fehler-Mapping aller Embedding-Actions (auch Gate und Konfiguration): feste Meldung, Log. */
function embeddingFailure(error: unknown): ActionFailure {
  const err = error instanceof Error ? error : null;
  log.error(
    { component: 'signal-embedding-settings', name: err?.name },
    'Signal-Embedding-Operator-Aufruf fehlgeschlagen',
  );
  return {
    ok: false,
    error: 'Die Signal-Engine konnte die Aktion nicht ausführen. Bitte später erneut versuchen.',
  };
}

function revalidateIntegrations(): void {
  revalidatePath('/staff/admin/settings/integrations');
}

export async function triggerSignalEmbeddingAction(
  input: unknown,
): Promise<SignalEmbeddingActionResult> {
  return staffAction({
    guard: EMBEDDING_GATE,
    onError: embeddingFailure,
    run: async (guard) => {
      const unavailable = await embeddingUnavailable(guard);
      if (unavailable) return unavailable;
      if (!TriggerInputSchema.safeParse(input).success) {
        return {
          ok: false,
          error: 'Bestätigen Sie den ressourcenintensiven Neuaufbau ausdrücklich.',
        };
      }
      const accepted = await new RiskLayerClient().embeddingRefresh({ force: true });
      await withTenantContext(guard.ctx, async (tx) => {
        await audit(tx, guard, {
          action: 'risk.embedding.refresh.triggered',
          resourceType: 'signal_embedding',
          resourceId: accepted.job_id,
          after: { force: true, jobId: accepted.job_id, state: accepted.state },
        });
      });
      revalidateIntegrations();
      return {
        message: 'Die Embedding-Aktualisierung wurde eingeplant.',
        jobId: accepted.job_id,
        state: accepted.state,
      };
    },
  });
}

export async function cancelSignalEmbeddingAction(
  input: unknown,
): Promise<SignalEmbeddingActionResult> {
  return staffAction({
    guard: EMBEDDING_GATE,
    onError: embeddingFailure,
    run: async (guard) => {
      const unavailable = await embeddingUnavailable(guard);
      if (unavailable) return unavailable;
      const parsed = CancelInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Ungültiger Embedding-Job.' };

      const accepted = await new RiskLayerClient().embeddingCancel(parsed.data);
      await withTenantContext(guard.ctx, async (tx) => {
        await audit(tx, guard, {
          action: 'risk.embedding.refresh.cancel.requested',
          resourceType: 'signal_embedding',
          resourceId: accepted.job_id,
          after: { jobId: accepted.job_id, state: accepted.state },
        });
      });
      revalidateIntegrations();
      return {
        message:
          accepted.state === 'cancelling'
            ? 'Der Abbruch wurde angefordert. Der aktuelle Modell-Batch kann noch kurz weiterlaufen.'
            : 'Der Embedding-Job ist bereits beendet.',
        jobId: accepted.job_id,
        state: accepted.state,
      };
    },
  });
}

export async function updateSignalEmbeddingScheduleAction(
  input: unknown,
): Promise<SignalEmbeddingActionResult> {
  return staffAction({
    guard: EMBEDDING_GATE,
    onError: embeddingFailure,
    run: async (guard) => {
      const unavailable = await embeddingUnavailable(guard);
      if (unavailable) return unavailable;

      const parsed = ScheduleInputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'Ungültiger Aktualisierungsplan.' };

      const desired = parsed.data.enabled
        ? { enabled: true as const, intervalDays: parsed.data.intervalDays }
        : { enabled: false as const, intervalDays: 7 as const };
      const accepted = await new RiskLayerClient().embeddingSchedule(desired);
      await withTenantContext(guard.ctx, async (tx) => {
        await audit(tx, guard, {
          action: 'risk.embedding.schedule.updated',
          resourceType: 'signal_embedding',
          resourceId: 'global-schedule',
          after: {
            enabled: accepted.schedule.enabled,
            intervalDays: accepted.schedule.interval_days,
            nextRunAt: accepted.schedule.next_run_at,
          },
        });
      });
      revalidateIntegrations();
      return {
        message: accepted.schedule.enabled
          ? 'Die wöchentliche Prüfung mit Aktualisierung bei Bedarf ist aktiviert.'
          : 'Die automatische Aktualisierung ist ausgeschaltet.',
      };
    },
  });
}
