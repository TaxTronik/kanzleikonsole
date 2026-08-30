'use client';

import { useState, useTransition } from 'react';
import { Bell, BellOff, RefreshCw } from 'lucide-react';
import { toggleTaxNewsNotifyAction, triggerTaxNewsFetchAction } from './tax-news-actions';

export function TaxNewsToggle({ enabled }: { enabled: boolean }) {
  const [on, setOn] = useState(enabled);
  const [isPending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function toggle() {
    setError(null);
    setInfo(null);
    const next = !on;
    setOn(next);
    start(async () => {
      const r = await toggleTaxNewsNotifyAction({ enabled: next });
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        setOn(!next);
      }
    });
  }

  function refetch() {
    setError(null);
    setInfo(null);
    start(async () => {
      const r = await triggerTaxNewsFetchAction();
      if (!r.ok) {
        setError(r.error ?? 'Fehler.');
        return;
      }
      const errs = r.errors ?? [];
      if (errs.length > 0 && (r.inserted ?? 0) === 0) {
        setError(errs.join(' · '));
      } else {
        setInfo(
          `${r.inserted ?? 0}/${r.fetched ?? 0} neu${
            errs.length > 0 ? ` (Warnungen: ${errs.join(', ')})` : ''
          }`,
        );
      }
    });
  }

  return (
    <div className="flex items-center gap-1.5 flex-wrap justify-end">
      {(error || info) && (
        <span
          className={
            'text-[10px] max-w-[260px] truncate ' +
            (error ? 'text-red-700 dark:text-red-300' : 'text-emerald-700 dark:text-emerald-300')
          }
          title={error ?? info ?? ''}
        >
          {error || info}
        </span>
      )}
      <button
        type="button"
        onClick={refetch}
        disabled={isPending}
        className="text-disabled hover:text-primary p-1"
        title="Meine Feeds jetzt aktualisieren (bis zu 20 s)"
        aria-label="Meine RSS-Feeds jetzt aktualisieren"
      >
        <RefreshCw className={'h-3.5 w-3.5 ' + (isPending ? 'animate-spin' : '')} />
      </button>
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        className={
          'inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ' +
          (on
            ? 'bg-brand-600 text-on-brand shadow-sm hover:bg-brand-600 dark:bg-brand-600 dark:text-on-brand dark:hover:bg-brand-600'
            : 'bg-gray-100 text-muted hover:bg-gray-200')
        }
        title={
          on
            ? 'Benachrichtigungen aktiv — klicken zum Deaktivieren'
            : 'Benachrichtigungen deaktiviert — klicken zum Aktivieren'
        }
      >
        {on ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
        {on ? 'Benachrichtigt' : 'Stumm'}
      </button>
    </div>
  );
}
