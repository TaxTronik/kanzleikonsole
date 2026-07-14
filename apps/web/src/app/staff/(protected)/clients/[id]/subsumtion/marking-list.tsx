'use client';

// =============================================================================
// Markierungsliste — Navigation für den Review. Statt Markierungen nur im Text
// zu suchen, kann der Berater sie hier durchklicken/durchsteppen: Klick wählt
// + scrollt im Dokument hin (revealMarking), Pfeile/Alt+↑/↓ steppen durch.
// Zeigt Begriff + Fundstelle + Status, farbcodiert nach Herkunft.
// =============================================================================

import { useState } from 'react';
import { ChevronDown, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react';
import { type MarkingDTO, STATUS_LABEL, herkunftColor } from './_ui';

export function MarkingList({
  markings,
  selectedId,
  onSelect,
  onPrev,
  onNext,
}: {
  /** Bereits gefiltert + nach Position sortiert. */
  markings: MarkingDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPrev: () => void;
  onNext: () => void;
}) {
  const [open, setOpen] = useState(true);
  if (markings.length === 0) return null;

  return (
    <div className="card p-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-sm font-medium text-primary"
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown className="h-4 w-4 text-disabled" />
          ) : (
            <ChevronRight className="h-4 w-4 text-disabled" />
          )}
          Markierungen <span className="badge-gray text-[10px]">{markings.length}</span>
        </button>
        <div className="inline-flex items-center gap-0.5">
          <button
            type="button"
            onClick={onPrev}
            className="p-1 text-disabled hover:text-secondary"
            title="Vorherige Markierung (Alt+↑)"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onNext}
            className="p-1 text-disabled hover:text-secondary"
            title="Nächste Markierung (Alt+↓)"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <ul className="mt-2 space-y-0.5 max-h-72 overflow-y-auto">
          {markings.map((m) => {
            const fund = m.matchedText.replace(/\s+/g, ' ').trim();
            const sub = fund && fund !== m.begriff.trim() ? fund : '';
            const active = m.id === selectedId;
            return (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => onSelect(m.id)}
                  aria-current={active ? 'true' : undefined}
                  className={
                    'w-full text-left rounded px-2 py-1 flex items-start gap-2 ' +
                    (active
                      ? 'bg-indigo-50 dark:bg-indigo-950/40'
                      : 'hover:bg-gray-50 dark:hover:bg-gray-900/40')
                  }
                >
                  <span
                    className="mt-1 h-2 w-2 rounded-full shrink-0"
                    style={{ backgroundColor: m.streitig ? '#ef4444' : herkunftColor(m.herkunft) }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-primary truncate">
                      {m.begriff || '(ohne Begriff)'}
                    </span>
                    {sub && <span className="block text-[11px] text-muted truncate">„{sub}"</span>}
                  </span>
                  <span className="badge-gray text-[10px] shrink-0">{STATUS_LABEL[m.status]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
