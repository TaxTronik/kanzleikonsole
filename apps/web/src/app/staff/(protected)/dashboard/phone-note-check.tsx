'use client';

import { useTransition, useState, type ReactNode, type MouseEvent } from 'react';
import { Check } from 'lucide-react';
import { markPhoneNoteDoneAction } from '@/app/staff/(protected)/phone-notes/actions';

export function PhoneNoteRow({
  id,
  children,
  className,
}: {
  id: string;
  children: ReactNode;
  className?: string;
}) {
  const [hidden, setHidden] = useState(false);
  const [isPending, start] = useTransition();

  if (hidden) return null;

  function mark(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setHidden(true);
    start(async () => {
      await markPhoneNoteDoneAction({ id });
    });
  }

  return (
    <li className={(className ?? '') + ' flex items-start gap-3'}>
      <button
        type="button"
        onClick={mark}
        disabled={isPending}
        className="shrink-0 mt-0.5 w-5 h-5 rounded border-2 border-strong hover:border-emerald-600 hover:bg-emerald-50 flex items-center justify-center text-transparent hover:text-emerald-600 dark:hover:border-emerald-500 dark:hover:bg-emerald-900/20"
        title="Als erledigt markieren"
        aria-label="Als erledigt markieren"
      >
        <Check className="h-3 w-3" />
      </button>
      <div className="flex-1 min-w-0">{children}</div>
    </li>
  );
}
