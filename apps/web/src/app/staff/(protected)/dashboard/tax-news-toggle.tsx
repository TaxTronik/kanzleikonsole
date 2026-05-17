'use client';

import { useState, useTransition } from 'react';
import { Bell, BellOff, RefreshCw } from 'lucide-react';
import {
  toggleTaxNewsNotifyAction,
  triggerTaxNewsFetchAction,
} from './tax-news-actions';

export function TaxNewsToggle({
  enabled,
  canTriggerFetch,
}: {
  enabled: boolean;
  canTriggerFetch: boolean;
}) {
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
      {canTriggerFetch && (
        <button
          type="button"
          onClick={refetch}
          disabled={isPending}
          className="text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 p-1"
          title="Feeds jetzt aktualisieren (bis zu 20 s)"
        >
          <RefreshCw className={'h-3.5 w-3.5 ' + (isPending ? 'animate-spin' : '')} />
        </button>
      )}
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        className={
          'inline-flex items-center gap-1 text-xs px-2 py-1 rounded-md transition-colors ' +
          (on
            ? 'bg-brand-100 text-brand-700 hover:bg-brand-200 dark:bg-brand-900/40 dark:text-brand-100'
            : 'bg-gray-100 text-gray-500 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-400')
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
