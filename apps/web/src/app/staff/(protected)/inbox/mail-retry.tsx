'use client';

// =============================================================================
// „Erneut senden" für den neutralen E-Mail-Hinweis einer Kanzleiantwort
// (Review-Entscheidung C1)
//
// Der Verlauf zeigt das nur, solange der letzte Versuch ohne Zustellung und
// ohne möglichen Seiteneffekt scheiterte (`safeToRetry`). Die Server-Action
// prüft das unter Lock erneut, versendet höchstens einmal und verweigert den
// Neuversand bei möglicher Teilzustellung.
// =============================================================================

import { useState, useTransition } from 'react';
import { RotateCw } from 'lucide-react';
import { retryInboxClientNotificationAction } from './actions';

interface RetryOutcome {
  delivered: boolean;
  text: string;
  /** Ein weiterer Versuch ist weiterhin sicher. */
  retryable: boolean;
}

export const INBOX_MAIL_NOT_DELIVERED =
  'Der E-Mail-Hinweis an den Mandanten wurde nicht zugestellt.';

export function InboxMailRetry({ messageId }: { messageId: string }) {
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<RetryOutcome | null>(null);

  function retry() {
    startTransition(async () => {
      const form = new FormData();
      form.set('messageId', messageId);
      try {
        const result = await retryInboxClientNotificationAction(form);
        setOutcome(
          result.ok
            ? { delivered: true, text: 'Der E-Mail-Hinweis wurde zugestellt.', retryable: false }
            : {
                delivered: false,
                text: result.error ?? 'Der E-Mail-Hinweis konnte nicht zugestellt werden.',
                retryable: result.safeToRetryMail === true,
              },
        );
      } catch {
        // Ausgang unbekannt: kein weiterer Klick, bis die Seite den Journalstand zeigt.
        setOutcome({
          delivered: false,
          text: 'Der Versandstatus konnte nicht bestätigt werden. Bitte laden Sie die Seite neu.',
          retryable: false,
        });
      }
    });
  }

  const showButton = outcome === null || outcome.retryable;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2 text-xs"
      data-inbox-mail-retry={messageId}
    >
      {outcome?.delivered ? null : (
        <span className="text-amber-700 dark:text-amber-300">{INBOX_MAIL_NOT_DELIVERED}</span>
      )}
      {showButton ? (
        <button
          type="button"
          onClick={retry}
          disabled={pending}
          className="btn-secondary inline-flex items-center gap-1 px-2 py-0.5 text-[11px]"
        >
          <RotateCw aria-hidden="true" className="h-3 w-3" />
          {pending ? 'Wird gesendet …' : 'Erneut senden'}
        </button>
      ) : null}
      {outcome ? (
        <span
          role="status"
          className={
            outcome.delivered
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-red-700 dark:text-red-300'
          }
        >
          {outcome.text}
        </span>
      ) : null}
    </div>
  );
}
