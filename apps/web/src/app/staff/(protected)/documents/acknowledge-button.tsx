'use client';

import { useState, useTransition, type MouseEvent } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { acknowledgeDocumentAction } from './acknowledge-actions';
import { fmtDateTimeShort } from '@/lib/fmt';

type AcknowledgeDocument = typeof acknowledgeDocumentAction;

/**
 * Setzt bzw. entfernt die Empfangsbestätigung über die Server-Action; `false`,
 * wenn sie abgelehnt wurde. P-18: Die Action revalidiert die Dokumentseite
 * (/staff/documents/<id>), ihre Antwort rendert sie bereits neu — ein
 * zusätzlicher Router-Refresh wäre ein zweiter Seiten-Render.
 */
export async function submitAcknowledgement(
  documentId: string,
  acknowledged: boolean,
  acknowledge: AcknowledgeDocument = acknowledgeDocumentAction,
): Promise<boolean> {
  const result = await acknowledge({ documentId, acknowledged });
  return result.ok;
}

export function AcknowledgeButton({
  documentId,
  acknowledgedAt,
  acknowledgedByName,
  size = 'sm',
}: {
  documentId: string;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  size?: 'sm' | 'md';
}) {
  const [done, setDone] = useState(Boolean(acknowledgedAt));
  const [doneAt, setDoneAt] = useState(acknowledgedAt);
  const [isPending, start] = useTransition();

  function toggle(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !done;
    const previousAt = doneAt;
    setDone(next);
    if (next) setDoneAt(new Date().toISOString());
    else setDoneAt(null);
    start(async () => {
      // Bei Ablehnung den optimistischen Stand zurücknehmen (Serverstand unverändert).
      if (!(await submitAcknowledgement(documentId, next))) {
        setDone(!next);
        setDoneAt(previousAt);
      }
    });
  }

  const tooltip =
    done && doneAt
      ? `Empfang bestätigt am ${fmtDateTimeShort(new Date(doneAt))}${acknowledgedByName ? ' von ' + acknowledgedByName : ''}`
      : 'Empfang bestätigen';

  const iconSize = size === 'md' ? 'h-5 w-5' : 'h-4 w-4';

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending}
      title={tooltip}
      aria-label={tooltip}
      className={
        done
          ? 'text-emerald-600 hover:text-emerald-700 inline-flex items-center gap-1'
          : 'text-disabled hover:text-emerald-600 inline-flex items-center gap-1'
      }
    >
      {done ? <CheckCircle2 className={iconSize} /> : <Circle className={iconSize} />}
      {size === 'md' && (
        <span className="text-xs">{done ? 'Empfang bestätigt' : 'Empfang bestätigen'}</span>
      )}
    </button>
  );
}
