'use client';

import { useRef, useState } from 'react';

interface TabEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  defaultPrevented: boolean;
  stopPropagation(): void;
}

interface FocusTarget {
  isConnected: boolean;
  focus(options?: FocusOptions): void;
}

/**
 * Radix verhindert Tab auch bei nichtmodalen Menüs. Im Capture-Pfad wird nur
 * diese Weiterleitung unterbunden: Der Browser darf ab dem Auslöser nativ zum
 * nächsten/vorigen Tabziel wechseln. Keine eigene, unvollständige Tabzielliste.
 */
export function createActionMenuKeyboardExit() {
  let skipCloseFocus = false;

  return {
    onKeyDownCapture(event: TabEvent, trigger: FocusTarget | null, close: () => void) {
      if (
        event.key !== 'Tab' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.defaultPrevented
      )
        return;

      if (!trigger?.isConnected) return;

      skipCloseFocus = true;
      event.stopPropagation();
      trigger.focus({ preventScroll: true });
      close();
      // Absichtlich kein preventDefault(): auch Shift+Tab bleibt native Navigation.
    },
    onCloseAutoFocus(event: { preventDefault(): void }) {
      if (!skipCloseFocus) return;
      skipCloseFocus = false;
      // Radix führt die Rückgabe asynchron aus; das neue Tabziel muss erhalten bleiben.
      event.preventDefault();
    },
  };
}

/** Gemeinsames Verhalten für einfache, nichtmodale Konto-/Aktionsmenüs. */
export function useActionMenu() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [keyboardExit] = useState(createActionMenuKeyboardExit);

  function onKeyDownCapture(event: TabEvent) {
    keyboardExit.onKeyDownCapture(event, triggerRef.current, () => setOpen(false));
  }

  return {
    open,
    onOpenChange: setOpen,
    triggerRef,
    onKeyDownCapture,
    onCloseAutoFocus: keyboardExit.onCloseAutoFocus,
  };
}
