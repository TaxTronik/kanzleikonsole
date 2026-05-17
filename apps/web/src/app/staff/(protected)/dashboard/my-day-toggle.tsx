'use client';

import { useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { toggleItemDoneAction } from '@/app/staff/(protected)/clients/[id]/workflows/actions';

export function MyDayToggle({ id }: { id: string }) {
  const [done, setDone] = useState(false);
  const [isPending, start] = useTransition();

  function toggle() {
    setDone(true);
    start(async () => {
      await toggleItemDoneAction({ id, done: true });
    });
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={isPending || done}
      className={
        done
          ? 'mt-0.5 w-5 h-5 rounded border-2 border-emerald-600 bg-emerald-600 text-white flex items-center justify-center shrink-0'
          : 'mt-0.5 w-5 h-5 rounded border-2 border-gray-300 hover:border-emerald-600 shrink-0'
      }
      aria-label="Als erledigt markieren"
      title="Als erledigt markieren"
    >
      {done && <Check className="h-3 w-3" />}
    </button>
  );
}
