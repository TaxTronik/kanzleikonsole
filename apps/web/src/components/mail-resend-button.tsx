'use client';

// =============================================================================
// „Erneut senden" an einer Zustellstatus-Zeile (Review-Entscheidung C4)
//
// Setzt fehlgeschlagene oder unklare Versandaufträge für den Hintergrunddienst
// zurück; gesendet wird nie aus dem Request. Bei unklarem Ausgang fragt die
// Schaltfläche vorher nach, weil die Mail möglicherweise schon zugestellt ist.
// Gate, Zustandsprüfung und Audit liegen in der Server-Action.
// =============================================================================

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { RotateCw } from 'lucide-react';
import { confirmDialog } from '@/components/ui/modal';
import type { MailResendTarget } from '@/lib/mail-delivery-status';
import { resendMailOutboxAction } from '@/server/mail/resend-actions';

export const MAIL_RESEND_UNCERTAIN_HINT =
  'Der Versandstatus ist unklar: Die Mail wurde möglicherweise bereits zugestellt. Ein erneuter Versand kann beim Mandanten zu einer doppelten E-Mail führen.';

export function MailResendButton({ target }: { target: MailResendTarget }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  async function resend() {
    if (
      target.uncertain &&
      !(await confirmDialog(MAIL_RESEND_UNCERTAIN_HINT, {
        title: 'Mail erneut senden?',
        confirmLabel: 'Trotzdem erneut senden',
      }))
    ) {
      return;
    }
    startTransition(async () => {
      const result = await resendMailOutboxAction({
        purpose: target.purpose,
        resourceType: target.resourceType,
        resourceId: target.resourceId,
        outboxIds: target.outboxIds,
        confirmUncertain: target.uncertain,
      });
      setMessage(
        result.ok
          ? 'Zum erneuten Versand vorgemerkt.'
          : (result.error ?? 'Die Mail konnte nicht erneut vorgemerkt werden.'),
      );
      router.refresh();
    });
  }

  return (
    <span className="ml-2 inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void resend()}
        disabled={pending}
        className="btn-secondary inline-flex items-center gap-1 px-2 py-0.5 text-[11px]"
        title={target.uncertain ? MAIL_RESEND_UNCERTAIN_HINT : undefined}
        data-mail-resend={target.uncertain ? 'uncertain' : 'failed'}
      >
        <RotateCw aria-hidden="true" className="h-3 w-3" />
        {pending ? 'Wird vorgemerkt …' : 'Erneut senden'}
      </button>
      {message ? (
        <span role="status" className="text-muted">
          {message}
        </span>
      ) : null}
    </span>
  );
}
