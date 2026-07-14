'use client';

import { useState, useTransition, type MouseEvent } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Circle } from 'lucide-react';
import { acknowledgeDocumentAction } from './acknowledge-actions';
import { fmtDateTimeShort } from '@/lib/fmt';

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
  const router = useRouter();
  const [done, setDone] = useState(Boolean(acknowledgedAt));
  const [doneAt, setDoneAt] = useState(acknowledgedAt);
  const [isPending, start] = useTransition();

  function toggle(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const next = !done;
    setDone(next);
    if (next) setDoneAt(new Date().toISOString());
    else setDoneAt(null);
    start(async () => {
      await acknowledgeDocumentAction({ documentId, acknowledged: next });
      router.refresh();
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
