'use client';

// =============================================================================
// Textfeld mit @-Autovervollständigung.
//
// Beim Tippen von „@" (am Wortanfang) öffnet sich die Personenauswahl; ein
// Klick fügt den vollen Namen ein. Serverseitig zählt ohnehin nur der Text —
// `extractMentions` gleicht gegen die Personenliste ab, das hier ist reine
// Eingabehilfe, keine zweite Wahrheit.
// =============================================================================

import { useRef, useState } from 'react';

interface Option {
  id: string;
  fullName: string;
}

/** Findet das angefangene @-Token vor der Schreibmarke. */
function tokenVorCaret(text: string, caret: number): { start: number; query: string } | null {
  const davor = text.slice(0, caret);
  const m = /(?:^|\s)@([^\n@]{0,40})$/.exec(davor);
  if (!m) return null;
  return { start: caret - m[1]!.length - 1, query: m[1]!.toLowerCase() };
}

export function MentionTextarea({
  value,
  onChange,
  staffOptions,
  rows = 2,
  maxLength = 5000,
  placeholder,
  className = 'input text-sm flex-1',
}: {
  value: string;
  onChange: (v: string) => void;
  staffOptions: Option[];
  rows?: number;
  maxLength?: number;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [vorschlaege, setVorschlaege] = useState<Option[] | null>(null);
  const [tokenStart, setTokenStart] = useState(0);

  function aktualisiere(text: string, caret: number) {
    onChange(text);
    const token = tokenVorCaret(text, caret);
    if (!token) {
      setVorschlaege(null);
      return;
    }
    const passend = staffOptions
      .filter((s) => s.fullName.toLowerCase().includes(token.query))
      .slice(0, 6);
    setTokenStart(token.start);
    setVorschlaege(passend.length > 0 ? passend : null);
  }

  function uebernehmen(s: Option) {
    const el = ref.current;
    const caret = el?.selectionStart ?? value.length;
    const neu = value.slice(0, tokenStart) + '@' + s.fullName + ' ' + value.slice(caret);
    onChange(neu);
    setVorschlaege(null);
    // Schreibmarke hinter den eingefügten Namen setzen.
    requestAnimationFrame(() => {
      const pos = tokenStart + s.fullName.length + 2;
      el?.focus();
      el?.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="relative flex-1">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => aktualisiere(e.target.value, e.target.selectionStart)}
        onBlur={() => window.setTimeout(() => setVorschlaege(null), 150)}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        className={className + ' w-full'}
      />
      {vorschlaege && (
        <ul className="absolute left-0 bottom-full mb-1 z-20 w-64 rounded-md border border-default bg-surface shadow-lg py-1">
          {vorschlaege.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  // mousedown statt click: läuft vor dem Blur des Textfelds.
                  e.preventDefault();
                  uebernehmen(s);
                }}
                className="w-full text-left px-3 py-1.5 text-sm text-secondary hover:bg-gray-50 dark:hover:bg-gray-900/40"
              >
                @{s.fullName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
