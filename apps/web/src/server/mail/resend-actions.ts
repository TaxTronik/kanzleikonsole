'use server';

// =============================================================================
// Server-Action „Erneut senden" an den Zustellstatus-Zeilen (Review-Entscheidung
// C4). Gate je Anlass wie die auslösende Action (MAIL_RESEND_GUARDS); die
// Arbeit steht in ./resend.ts. Nach dem Commit wird nur der Worker angestoßen —
// keine SMTP-Verbindung aus dem Request.
// =============================================================================

import { z } from 'zod';
import { withTenantContext } from '@taxtronik/db';
import { MAIL_OUTBOX_PURPOSES } from '@taxtronik/mail/outbox-purposes';
import { staffAction, type ActionResult } from '@/server/actions/staff-action';
import { kickMailOutboxDelivery } from '@/server/mail/outbox';
import { resendMailOutboxTx } from '@/server/mail/resend';
import { MAIL_RESEND_GUARDS } from '@/server/mail/resend-guards';

const ResendSchema = z.object({
  purpose: z.enum(MAIL_OUTBOX_PURPOSES),
  resourceType: z.string().regex(/^[a-z][a-z_]{0,63}$/),
  resourceId: z.string().uuid(),
  outboxIds: z.array(z.string().uuid()).min(1).max(50),
  confirmUncertain: z.boolean().default(false),
});

export type ResendMailResult = ActionResult & { requeued?: number };

/** Eingabe aus der Statuszeile; Anlass und IDs prüft das Schema. */
export interface ResendMailInput {
  purpose: string;
  resourceType: string;
  resourceId: string;
  outboxIds: readonly string[];
  confirmUncertain?: boolean;
}

export async function resendMailOutboxAction(input: ResendMailInput): Promise<ResendMailResult> {
  const parsed = ResendSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: 'Ungültige Angaben zum erneuten Versand.',
      errorCode: 'VALIDATION_ERROR',
    };
  }
  const data = parsed.data;
  return staffAction({
    guard: MAIL_RESEND_GUARDS[data.purpose],
    run: async (g) => {
      const outcome = await withTenantContext(g.ctx, (tx) =>
        resendMailOutboxTx(tx, g, data, new Date()),
      );
      if (outcome.kind === 'skipped') {
        // Bereits committet: der Auftrag ist als nicht mehr aktuell verworfen.
        return {
          ok: false as const,
          error: `Nicht erneut gesendet: ${outcome.reason}`,
          errorCode: 'CONFLICT' as const,
        };
      }
      kickMailOutboxDelivery();
      return { requeued: outcome.count };
    },
  });
}
