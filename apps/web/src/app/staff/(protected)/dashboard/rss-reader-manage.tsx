'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, Plus, Trash2, RefreshCw, Rss } from 'lucide-react';
import {
  addRssFeedAction,
  toggleRssFeedAction,
  deleteRssFeedAction,
  resetRssFeedDefaultsAction,
  type ActionResult,
} from './rss-feed-actions';

export interface FeedRow {
  id: string;
  name: string;
  url: string;
  color: string | null;
  active: boolean;
}

const COLOR_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Standard' },
  { value: 'blue', label: 'Blau' },
  { value: 'purple', label: 'Lila' },
  { value: 'green', label: 'Grün' },
  { value: 'amber', label: 'Bernstein' },
  { value: 'pink', label: 'Pink' },
  { value: 'slate', label: 'Grau' },
];

export function RssReaderManage({ feeds }: { feeds: FeedRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    addRssFeedAction,
    null,
  );
  const [isMutating, startMut] = useTransition();

  function toggle(id: string, active: boolean) {
    startMut(async () => {
      await toggleRssFeedAction({ id, active });
      router.refresh();
    });
  }

  function remove(id: string) {
    if (!confirm('Feed aus deinem Reader entfernen?')) return;
    startMut(async () => {
      await deleteRssFeedAction({ id });
      router.refresh();
    });
  }

  function resetDefaults() {
    startMut(async () => {
      await resetRssFeedDefaultsAction();
      router.refresh();
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 p-1"
        aria-label="Feeds verwalten"
        title="Feeds verwalten"
      >
        <Settings className="h-4 w-4" />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-30 w-[420px] max-w-[90vw] rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100 inline-flex items-center gap-2">
              <Rss className="h-4 w-4 text-gray-400" />
              Deine Feeds ({feeds.length})
            </p>
            <button
              type="button"
              onClick={resetDefaults}
              disabled={isMutating}
              className="text-[11px] text-gray-500 hover:text-brand-700 inline-flex items-center gap-1"
              title="BMF + BFH wieder hinzufügen"
            >
              <RefreshCw className="h-3 w-3" />
              Defaults
            </button>
          </div>

          {feeds.length === 0 ? (
            <p className="text-xs text-gray-400 py-2 text-center">Noch keine Feeds.</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-800 max-h-60 overflow-y-auto scrollbar-thin -mx-1">
              {feeds.map((f) => (
                <li key={f.id} className="px-1 py-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={f.active}
                    onChange={(e) => toggle(f.id, e.target.checked)}
                    disabled={isMutating}
                    className="h-4 w-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                    title={f.active ? 'Deaktivieren' : 'Aktivieren'}
                  />
                  <div className="flex-1 min-w-0">
                    <p className={'text-sm truncate ' + (f.active ? 'text-gray-900 dark:text-gray-100' : 'text-gray-400 line-through')}>
                      {f.name}
                    </p>
                    <p className="text-[10px] text-gray-400 truncate">{f.url}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(f.id)}
                    disabled={isMutating}
                    className="text-gray-400 hover:text-red-700 p-1 shrink-0"
                    title="Entfernen"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form action={formAction} className="pt-2 border-t border-gray-100 dark:border-gray-800 space-y-2">
            <p className="text-xs font-medium text-gray-700 dark:text-gray-300">Neuen Feed hinzufügen</p>
            <div className="grid grid-cols-3 gap-2">
              <input
                type="text"
                name="name"
                placeholder="Name (z. B. FG Köln)"
                maxLength={80}
                required
                className="input text-xs col-span-2"
              />
              <select name="color" className="input text-xs">
                {COLOR_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <input
              type="url"
              name="url"
              placeholder="https://… RSS-Feed-URL"
              maxLength={500}
              required
              className="input text-xs"
            />
            {state && !state.ok && <p className="text-[11px] text-red-700">{state.error}</p>}
            <div className="flex justify-end">
              <button type="submit" disabled={isPending} className="btn-primary text-xs inline-flex items-center gap-1">
                <Plus className="h-3 w-3" />
                {isPending ? 'Lege an…' : 'Hinzufügen'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
