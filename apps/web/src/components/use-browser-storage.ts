'use client';

import { useCallback, useSyncExternalStore } from 'react';

const CHANGE_EVENT = 'taxtronik-browser-storage-change';
const fallbackValues = new Map<string, string>();

export function readBrowserStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return fallbackValues.get(key) ?? null;
  }
}

export function writeBrowserStorage(key: string, value: string): void {
  fallbackValues.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    // Keep the current browser session usable when persistent storage is blocked.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: key }));
}

/** Stable string snapshots avoid hydration mismatches and newly parsed object loops. */
export function useBrowserStorage(key: string): string | null {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === key) onChange();
      };
      const onLocalChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === key) onChange();
      };
      window.addEventListener('storage', onStorage);
      window.addEventListener(CHANGE_EVENT, onLocalChange);
      return () => {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener(CHANGE_EVENT, onLocalChange);
      };
    },
    [key],
  );
  const getSnapshot = useCallback(() => readBrowserStorage(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
