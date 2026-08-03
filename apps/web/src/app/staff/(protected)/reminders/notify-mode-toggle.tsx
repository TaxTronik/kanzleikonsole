'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, AtSign } from 'lucide-react';
import { setReminderNotifyModeAction } from '../clients/[id]/reminders/actions';

type Mode = 'ALL' | 'MENTIONS_ONLY';

/**
 * Persönlicher Schalter: alles hören oder nur gezielte @-Ansprachen.
 * Zuweisungen und Fälligkeiten kommen unabhängig davon immer durch.
 */
export function NotifyModeToggle({ initial }: { initial: Mode }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initial);
  const [pending, start] = useTransition();

  function setzen(next: Mode) {
    if (next === mode) return;
    const vorher = mode;
    setMode(next);
    start(async () => {
      const r = await setReminderNotifyModeAction({ mode: next });
      if (!r.ok) setMode(vorher);
      else router.refresh();
    });
  }

  const knopf = (wert: Mode, label: string, Icon: typeof Bell, hint: string) => (
    <button
      type="button"
      onClick={() => setzen(wert)}
      disabled={pending}
      title={hint}
      className={mode === wert ? 'btn-primary text-xs' : 'btn-secondary text-xs'}
    >
      <Icon className="h-3.5 w-3.5" /> {label}
    </button>
  );

  return (
    <div
      className="flex items-center gap-1.5"
      title="Gilt für Chat, Uploads und Nachfassen — Zuweisungen und Fälligkeiten kommen immer."
    >
      <span className="text-xs text-muted mr-1">Benachrichtigungen:</span>
      {knopf('ALL', 'Alles', Bell, 'Jede Aktivität an deinen Wiedervorlagen')}
      {knopf(
        'MENTIONS_ONLY',
        'Nur @-Erwähnungen',
        AtSign,
        'Vom laufenden Austausch nur noch gezielte Ansprachen — Zuweisungen und Fälligkeiten kommen weiterhin',
      )}
    </div>
  );
}
