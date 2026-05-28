// =============================================================================
// n8n-Outbox (S15)
//
// `enqueueN8nEvent` ersetzt das alte fire-and-forget aus emit.ts. Schritte:
//   1. Outbox-Reihe in Postgres anlegen (status=PENDING)
//   2. BullMQ-Job einreihen mit Outbox-ID
//   3. Worker (apps/worker/src/jobs/n8n-deliver.ts) liefert aus
//
// BullMQ-Retry: 5 Versuche mit Exponential-Backoff (60s, 5m, 30m, 2h, 6h)
// → ~9h Worst-Case bis FAILED. Lange genug für n8n-Restart, kurze genug
// damit Mandanten ihre Reminder zeitnah bekommen.
//
// Wenn die Outbox-Reihe nicht geschrieben werden kann (DB-Ausfall): Fehler
// wird geloggt, Geschäftslogik bleibt unbeeinträchtigt — analog zur alten
// fire-and-forget-Semantik.
// =============================================================================

import { prismaOwner } from '@/server/db/prisma-owner';
import { getN8nDeliverQueue } from './queue';
import type { N8nEventName } from './emit';
import { log } from '@/server/logger';
import { isAllowedN8nEvent } from '@taxtronik/n8n-shared';

const RETRY_BACKOFF_MS = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 60 * 60_000, // 2 h
  6 * 60 * 60_000, // 6 h
];

// S6/Konsolidierung Round 12: Whitelist + Workflow-Step-Regex sind jetzt
// zentral in @taxtronik/n8n-shared. Vorher in zwei parallelen Dateien
// (outbox.ts und worker/n8n-deliver.ts) gepflegt.

export async function enqueueN8nEvent(
  event: N8nEventName,
  payload: Record<string, unknown>,
  opts: { tenantId?: string } = {},
): Promise<void> {
  if (!isAllowedN8nEvent(event)) {
    log.error({ component: 'n8n-outbox', event }, 'event not in whitelist — refusing to enqueue');
    return;
  }
  let outboxId: string;
  try {
    const row = await prismaOwner.n8nOutbox.create({
      data: {
        tenantId: opts.tenantId ?? null,
        event,
        payload: payload as object,
      },
      select: { id: true },
    });
    outboxId = row.id;
  } catch (err) {
    log.error({ component: 'n8n-outbox', event, err: (err as Error).message }, 'write failed');
    return;
  }

  try {
    await getN8nDeliverQueue().add(
      'deliver',
      { outboxId },
      {
        // Erster Versuch sofort, Folgeversuche mit den oben definierten Intervallen.
        // BullMQ erwartet ein einzelnes Delay zwischen Versuchen — wir nutzen
        // 'exponential' und stellen den Erstwert auf 60s ein. Approximiert die
        // Wunsch-Sequenz (60s, 2m, 4m, 8m, 16m... ist für unseren Fall etwas
        // schneller, aber das ist OK — n8n-Restarts sind meistens kurz).
        attempts: RETRY_BACKOFF_MS.length + 1,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { age: 24 * 60 * 60 }, // 1 Tag aufheben
        removeOnFail: false, // FAILED-Jobs für Ops behalten
      },
    );
  } catch (err) {
    log.error(
      { component: 'n8n-outbox', event, outboxId, err: (err as Error).message },
      'enqueue failed — PENDING row will be picked up by reconcile job',
    );
    // Outbox-Reihe bleibt PENDING — Reconcile-Job (alle 5 min) reiht sie neu ein.
  }
}
