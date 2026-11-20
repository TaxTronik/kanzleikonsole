'use client';

import { useCallback, useSyncExternalStore } from 'react';

const CHANGE_EVENT = 'taxtronik-browser-storage-change';
const fallbackValues = new Map<
  string,
  { value: string; storedAtWrite: string | null | undefined }
>();

function persistedValue(key: string): string | null | undefined {
  try {
    return localStorage.getItem(key);
  } catch {
    return undefined;
  }
}

export function readBrowserStorage(key: string): string | null {
  const stored = persistedValue(key);
  const fallback = fallbackValues.get(key);
  if (stored === undefined) return fallback?.value ?? null;
  if (fallback) {
    if (fallback.storedAtWrite === stored) return fallback.value;
    fallbackValues.delete(key);
  }
  return stored;
}

export function writeBrowserStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
    fallbackValues.set(key, { value, storedAtWrite: value });
  } catch {
    // At quota, reads still return the old persisted value. A later write in
    // another tab takes precedence once that persisted value actually changes.
    fallbackValues.set(key, { value, storedAtWrite: persistedValue(key) });
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
