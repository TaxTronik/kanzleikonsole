'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { riskLayerConfig } from '@taxtronik/config';
import { withTenantContext } from '@taxtronik/db';
import { RiskLayerClient } from '@taxtronik/risk-layer';
import { staffActionGuard, type ActionResult } from '@/server/actions/staff-action';
import { evidenceService } from '@/server/container';
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

type EmbeddingGuard = Extract<Awaited<ReturnType<typeof staffActionGuard>>, { ok: true }>;
type EmbeddingGuardFailure = { ok: false; error: string };

async function embeddingGuard(): Promise<EmbeddingGuard | EmbeddingGuardFailure> {
  // Der Signal-Operator ist deployment-global. TaxTronik unterstützt diesen
  // Adminpfad ausschließlich im dokumentierten On-Prem-1:1-Deployment pro
  // Kanzlei; dort ist der Tenant-Admin zugleich Administrator des Deployments.
  const guard = await staffActionGuard({ requireAdmin: true });
  if (!guard.ok) return guard;

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
  return guard;
}

function embeddingFailure(error: unknown): SignalEmbeddingActionResult {
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

export async function triggerSignalEmbeddingAction(): Promise<SignalEmbeddingActionResult> {
  try {
    const guard = await embeddingGuard();
    if (!guard.ok) return guard;
    const accepted = await new RiskLayerClient().embeddingRefresh({ force: true });
    await withTenantContext(guard.ctx, async (tx) => {
      await evidenceService.record(tx, {
        tenantId: guard.tenantId,
        actorType: 'STAFF',
        actorId: guard.staffId,
        action: 'risk.embedding.refresh.triggered',
        resourceType: 'signal_embedding',
        resourceId: accepted.job_id,
        after: { force: true, jobId: accepted.job_id, state: accepted.state },
      });
    });
    revalidateIntegrations();
    return {
      ok: true,
      message: 'Die Embedding-Aktualisierung wurde eingeplant.',
      jobId: accepted.job_id,
      state: accepted.state,
    };
  } catch (error) {
    return embeddingFailure(error);
  }
}

export async function updateSignalEmbeddingScheduleAction(
  input: unknown,
): Promise<SignalEmbeddingActionResult> {
  try {
    const guard = await embeddingGuard();
    if (!guard.ok) return guard;

    const parsed = ScheduleInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: 'Ungültiger Aktualisierungsplan.' };

    const desired = parsed.data.enabled
      ? { enabled: true as const, intervalDays: parsed.data.intervalDays }
      : { enabled: false as const, intervalDays: 7 as const };
    const accepted = await new RiskLayerClient().embeddingSchedule(desired);
    await withTenantContext(guard.ctx, async (tx) => {
      await evidenceService.record(tx, {
        tenantId: guard.tenantId,
        actorType: 'STAFF',
        actorId: guard.staffId,
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
      ok: true,
      message: accepted.schedule.enabled
        ? 'Die wöchentliche Prüfung mit Aktualisierung bei Bedarf ist aktiviert.'
        : 'Die automatische Aktualisierung ist ausgeschaltet.',
    };
  } catch (error) {
    return embeddingFailure(error);
  }
}
