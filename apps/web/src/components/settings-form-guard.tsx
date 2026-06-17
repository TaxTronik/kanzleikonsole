'use client';

// =============================================================================
// SettingsFormGuard — zentraler Speichern-Flyover für die Settings-Subtree.
//
// Ersetzt die verstreuten, verwirrend vielen Speichern-Buttons pro Abschnitt
// (auf /branding z. B. drei) durch EINEN schwebenden Flyover, der nur bei
// offenen Änderungen erscheint.
//
// Funktionsweise:
//  • Dirty-Erkennung per Serialisierungs-Snapshot: beim ersten Auftauchen eines
//    speicherbaren Formulars wird sein initialer Wert-Hash gemerkt. Eine Änderung
//    macht es "dirty" — und WIEDER rückgängig machen nimmt das zurück (der
//    Snapshot stimmt wieder => Flyover verschwindet). Löst das "Aufforderung
//    bleibt, obwohl Änderung revertiert"-Problem.
//  • "Speichern": reicht bei allen dirty Formularen requestSubmit() ein — jede
//    behält ihre eigene Server-Action. Die Speichern-Buttons der Formulare sind
//    per globals.css in diesem Subtree ausgeblendet (Flyover ist die einzige
//    sichtbare Save-Aktion).
//  • "Verwerfen": lädt die Seite neu — verwirft zuverlässig ALLE offenen
//    Änderungen (auch React-State-gesteuerte Felder wie das Logo).
//  • beforeunload warnt beim Verlassen mit offenen Änderungen.
//
// Speicherbar = Formulare mit Submit-Button, die NICHT data-settings-no-track
// tragen (z. B. SMTP-Testmail oder Autosave-Layouts).
// =============================================================================

import { useEffect, useRef, useState, type ReactNode } from 'react';

function serialize(form: HTMLFormElement): string {
  const parts: string[] = [];
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement) {
      if (!el.name) continue;
      const t = el.type;
      if (t === 'file' || t === 'submit' || t === 'button') continue;
      if (t === 'checkbox' || t === 'radio') {
        if (el.checked) parts.push(`${el.name}=${el.value || 'on'}`);
      } else {
        // text/hidden/number/email/date/color usf. — hidden bewusst inklusive,
        // weil darüber React-State-Felder (z. B. logoDataUrl, accentColor) fließen.
        parts.push(`${el.name}=${el.value}`);
      }
    } else if (el instanceof HTMLTextAreaElement && el.name) {
      parts.push(`${el.name}=${el.value}`);
    } else if (el instanceof HTMLSelectElement && el.name) {
      parts.push(`${el.name}=${el.value}`);
    }
  }
  return parts.join('&');
}

function isSaveable(form: HTMLFormElement): boolean {
  if (form.hasAttribute('data-settings-no-track')) return false;
  return !!form.querySelector('button[type="submit"], input[type="submit"]');
}

export function SettingsFormGuard({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const snapshots = useRef<WeakMap<HTMLFormElement, string>>(new WeakMap());
  const [dirtyCount, setDirtyCount] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;

    function recompute() {
      const forms = Array.from(root!.querySelectorAll('form'));
      let count = 0;
      for (const f of forms) {
        if (!isSaveable(f)) continue;
        if (!snapshots.current.has(f)) snapshots.current.set(f, serialize(f));
        const dirty = serialize(f) !== snapshots.current.get(f)!;
        f.classList.toggle('settings-dirty', dirty);
        if (dirty) count += 1;
      }
      setDirtyCount(count);
    }

    function onBeforeUnload(e: BeforeUnloadEvent) {
      const forms = Array.from(root!.querySelectorAll('form'));
      if (forms.some((f) => isSaveable(f) && f.classList.contains('settings-dirty'))) {
        e.preventDefault();
        e.returnValue = '';
      }
    }

    root.addEventListener('input', recompute);
    root.addEventListener('change', recompute);
    window.addEventListener('beforeunload', onBeforeUnload);
    const mo = new MutationObserver(recompute);
    mo.observe(root, { childList: true, subtree: true });
    recompute();
    return () => {
      root.removeEventListener('input', recompute);
      root.removeEventListener('change', recompute);
      window.removeEventListener('beforeunload', onBeforeUnload);
      mo.disconnect();
    };
  }, []);

  function saveAll() {
    const root = containerRef.current;
    if (!root || saving) return;
    const forms = Array.from(root.querySelectorAll('form')).filter(
      (f) => isSaveable(f) && f.classList.contains('settings-dirty'),
    );
    if (forms.length === 0) return;
    setSaving(true);
    // Optimistisch als clean markieren (eingereichte Werte = Snapshot). Schlägt
    // eine Action fehl, zeigt das Formular inline ihren eigenen Fehler.
    for (const f of forms) {
      snapshots.current.set(f, serialize(f));
      f.classList.remove('settings-dirty');
      try {
        f.requestSubmit();
      } catch {
        /* ältere Browser: ohne Request-Action-Konsole kein Submit möglich */
      }
    }
    setDirtyCount(0);
    setTimeout(() => setSaving(false), 1500);
  }

  function discardAll() {
    if (!confirm('Alle ungespeicherten Änderungen verwerfen?')) return;
    window.location.reload();
  }

  return (
    <div ref={containerRef} className="settings-form-guard min-w-0">
      {children}
      {dirtyCount > 0 && (
        <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-yellow-300 bg-yellow-50 px-3 py-2 text-xs text-yellow-900 shadow-lg">
          <span className="font-medium">
            {dirtyCount} ungespeicherte{dirtyCount === 1 ? 's' : ''} Änderung{dirtyCount === 1 ? '' : 'en'}
          </span>
          <button
            type="button"
            onClick={discardAll}
            className="rounded-full px-2 py-1 text-yellow-800 hover:bg-yellow-100"
          >
            Verwerfen
          </button>
          <button
            type="button"
            onClick={saveAll}
            disabled={saving}
            className="rounded-full bg-yellow-500 px-3 py-1 font-medium text-white hover:bg-yellow-600 disabled:opacity-60"
          >
            {saving ? 'Speichert …' : 'Speichern'}
          </button>
        </div>
      )}
    </div>
  );
}
