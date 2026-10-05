'use client';

// Mehrfachauswahl von Mandanten über die ClientCombobox: jede Auswahl wird als
// Chip mit eigenem versteckten Feld (gleicher `name`, `getAll()` liest sie)
// übernommen. Ersetzt Checkbox-Listen über den gesamten Bestand.

import { useState } from 'react';
import { X } from 'lucide-react';
import type { ClientPickerFilter } from '@/lib/client-picker';
import { ClientCombobox, type ClientComboboxValue } from './client-combobox';

export function ClientMultiPicker({
  id,
  name,
  filters,
  max,
}: {
  id: string;
  name: string;
  filters?: readonly ClientPickerFilter[];
  /** Obergrenze der Action (z. B. 200 Empfänger je Lauf). */
  max: number;
}) {
  const [selected, setSelected] = useState<ClientComboboxValue[]>([]);
  const full = selected.length >= max;

  function add(client: ClientComboboxValue | null) {
    if (!client) return;
    setSelected((list) =>
      list.length >= max || list.some((c) => c.id === client.id) ? list : [...list, client],
    );
  }

  return (
    <div className="space-y-2">
      {selected.map((client) => (
        <input key={client.id} type="hidden" name={name} value={client.id} />
      ))}
      <ClientCombobox
        id={id}
        value={null}
        onChange={add}
        filters={filters}
        excludeIds={selected.map((c) => c.id)}
        disabled={full}
        blockEnterSubmit
        placeholder="Mandant hinzufügen — Name, DATEV- oder Addison-Nr."
      />
      <p className="text-xs text-muted" aria-live="polite">
        {selected.length} von höchstens {max} Mandanten ausgewählt.
      </p>
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Ausgewählte Mandanten">
          {selected.map((client) => (
            <li
              key={client.id}
              className="inline-flex items-center gap-1 rounded-full border border-default bg-surface-raised px-2 py-0.5 text-sm"
            >
              {client.name}
              <button
                type="button"
                className="rounded p-0.5 text-muted hover:text-primary"
                aria-label={`${client.name} entfernen`}
                onClick={() => setSelected((list) => list.filter((c) => c.id !== client.id))}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
