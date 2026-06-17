'use client';

// =============================================================================
// SettingsFormGuard — Dirty-State-Tracking + Unsaved-Changes-Schutz für die
// gesamten Settings-Subtree.
//
// Problematik (User-Feedback): Einstellungen haben mehrere getrennte Formulare
// pro Seite (z. B. /branding: Branding + Letterhead + Legal = 3 Speicher-
// buttons). Man vergisst leicht zu speichern, sucht den Button mühsam und ist
// durch die vielen Buttons verwirrt.
//
// Lösung (ohne jedes Formular auf react-hook-form umzustellen):
//  • Jedes Formular MIT Speichern-Button wird bei der ersten Änderung "dirty".
//  • Dirty-Formulare bekommen die CSS-Klasse `settings-dirty` → der eigene
//    Speichern-Button wird per globals.css hervorgehoben (gelber Puls-Ring).
//  • Eine Sticky-Leiste am Ende der Seite erinnert an offene Änderungen + nennt
//    die Anzahl der betroffenen Abschnitte.
//  • beforeunload warnt beim Verlassen der Seite mit offenen Änderungen.
//  • Beim Absenden (submit) wird der Dirty-Status dieses Formulars gelöscht —
//    die Server-Action revalidiert danach ohnehin.
// =============================================================================

import { useEffect, useRef, useState, type ReactNode } from 'react';

function hasSubmitButton(form: HTMLFormElement): boolean {
  return !!form.querySelector('button[type="submit"], input[type="submit"]');
}

export function SettingsFormGuard({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef<Set<HTMLFormElement>>(new Set());
  const [dirtyCount, setDirtyCount] = useState(0);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    function sync() {
      const forms = Array.from(root!.querySelectorAll('form'));
      const present = new Set(forms);
      for (const f of [...dirtyRef.current]) {
        if (!present.has(f) || !hasSubmitButton(f)) dirtyRef.current.delete(f);
      }
      for (const f of forms) {
        f.classList.toggle('settings-dirty', dirtyRef.current.has(f));
      }
      setDirtyCount(dirtyRef.current.size);
    }

    function markDirty(e: Event) {
      const target = e.target as HTMLElement | null;
      const form = target?.closest?.('form') as HTMLFormElement | null;
      if (form && root!.contains(form) && hasSubmitButton(form)) {
        if (!dirtyRef.current.has(form)) {
          dirtyRef.current.add(form);
          sync();
        }
      }
    }

    function clearDirty(e: Event) {
      const form = e.target as HTMLFormElement;
      if (root!.contains(form) && dirtyRef.current.has(form)) {
        dirtyRef.current.delete(form);
        sync();
      }
    }

    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (dirtyRef.current.size > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    }

    root.addEventListener('input', markDirty);
    root.addEventListener('change', markDirty);
    // Capture: feuert vor dem React-Server-Action-Handler, sodass der Dirty-
    // Status schon beim Absenden zurückgesetzt wird.
    root.addEventListener('submit', clearDirty, true);
    window.addEventListener('beforeunload', onBeforeUnload);
    const mo = new MutationObserver(sync);
    mo.observe(root, { childList: true, subtree: true });
    sync();

    return () => {
      root.removeEventListener('input', markDirty);
      root.removeEventListener('change', markDirty);
      root.removeEventListener('submit', clearDirty, true);
      window.removeEventListener('beforeunload', onBeforeUnload);
      mo.disconnect();
    };
  }, []);

  return (
    <div ref={containerRef} className="min-w-0">
      {children}
      {dirtyCount > 0 && (
        <div
          role="status"
          className="sticky bottom-0 z-30 mt-6 -mb-4 border-t border-yellow-300 bg-yellow-50/95 px-4 py-2.5 text-sm text-yellow-900 backdrop-blur"
        >
          <strong>{dirtyCount} ungespeicherte{dirtyCount === 1 ? 's' : ''} Änderung{dirtyCount === 1 ? '' : 'en'}.</strong>{' '}
          Speichern-Button der markierten Abschnitte klicken — ungespeicherte Änderungen verfallen beim Verlassen der Seite.
        </div>
      )}
    </div>
  );
}
