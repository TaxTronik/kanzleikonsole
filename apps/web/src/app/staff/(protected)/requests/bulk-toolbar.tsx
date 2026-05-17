'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CheckSquare, Square, X, Lock } from 'lucide-react';
import { bulkCloseRequestsAction } from './bulk-actions';

interface Props {
  // IDs aller Anforderungen auf der aktuellen Seite, die noch nicht
  // geschlossen sind (Server-seitig gefiltert)
  closableIds: string[];
}

/**
 * Bulk-Toolbar — überlagert die Tabelle. Wird angezeigt, sobald min. eine
 * Anforderung selektiert ist. Selektion läuft via Custom-Event auf
 * `data-bulk-select-id` Checkboxen, die in der Tabelle sind.
 */
export function BulkToolbar({ closableIds }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onChange(e: Event) {
      const input = e.target as HTMLInputElement;
      if (!input.matches('[data-bulk-id]')) return;
      const id = input.dataset['bulkId']!;
      setSelected((s) => {
        const next = new Set(s);
        if (input.checked) next.add(id);
        else next.delete(id);
        return next;
      });
    }
    document.addEventListener('change', onChange);
    return () => document.removeEventListener('change', onChange);
  }, []);

  function selectAll() {
    setSelected(new Set(closableIds));
    document
      .querySelectorAll<HTMLInputElement>('[data-bulk-id]')
      .forEach((el) => {
        if (closableIds.includes(el.dataset['bulkId']!)) el.checked = true;
      });
  }

  function clearSelection() {
    setSelected(new Set());
    document
      .querySelectorAll<HTMLInputElement>('[data-bulk-id]')
      .forEach((el) => (el.checked = false));
  }

  function closeSelected() {
    setError(null);
    if (selected.size === 0) return;
    if (!confirm(`${selected.size} Anforderung${selected.size === 1 ? '' : 'en'} schließen?`)) return;
    startTransition(async () => {
      const r = await bulkCloseRequestsAction({ ids: Array.from(selected) });
      if (!r.ok) {
        setError(r.error ?? 'Fehler');
        return;
      }
      clearSelection();
      router.refresh();
    });
  }

  if (selected.size === 0 && closableIds.length === 0) return null;

  return (
    <div className="sticky bottom-0 z-10 bg-white border-t border-gray-200 px-6 py-3 flex items-center justify-between text-sm">
      <div className="flex items-center gap-3">
        {selected.size > 0 ? (
          <>
            <CheckSquare className="h-4 w-4 text-brand-600" />
            <span className="font-medium text-gray-900">{selected.size} ausgewählt</span>
            <button type="button" onClick={clearSelection} className="text-gray-500 hover:text-gray-900 flex items-center gap-1 text-xs">
              <X className="h-3 w-3" />
              Auswahl aufheben
            </button>
          </>
        ) : (
          <>
            <Square className="h-4 w-4 text-gray-400" />
            <button type="button" onClick={selectAll} className="text-brand-700 hover:underline text-xs">
              Alle {closableIds.length} schließbaren auswählen
            </button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-red-700">{error}</span>}
        <button
          type="button"
          onClick={closeSelected}
          disabled={selected.size === 0 || isPending}
          className="btn-primary text-xs py-1.5"
        >
          <Lock className="h-3.5 w-3.5" />
          {isPending ? 'Schließt…' : `${selected.size} schließen`}
        </button>
      </div>
    </div>
  );
}
