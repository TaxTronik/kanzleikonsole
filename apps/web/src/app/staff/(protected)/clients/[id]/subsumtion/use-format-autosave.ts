'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

type Save = (doc: unknown) => Promise<{ ok: boolean; error?: string }>;
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/** RISK-AI-SUGGESTION-001: serialize format-only saves and retain the latest unsaved document. */
export function useFormatAutosave(canEdit: boolean, save: Save | undefined) {
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const state = useRef({
    canEdit,
    save,
    mounted: true,
    saving: false,
    pending: null as unknown,
    revision: 0,
    failures: 0,
    timer: null as ReturnType<typeof setTimeout> | null,
  });
  const flushRef = useRef<() => void>(() => {});
  const clearTimer = useCallback(() => {
    if (state.current.timer) clearTimeout(state.current.timer);
    state.current.timer = null;
  }, []);
  const flush = useCallback(async () => {
    clearTimer();
    const current = state.current;
    if (current.saving || current.pending == null || !current.save || !current.canEdit) return;
    const doc = current.pending;
    const revision = current.revision;
    current.pending = null;
    current.saving = true;
    if (current.mounted) setSaveState('saving');
    const ok = await current
      .save(doc)
      .then((result) => result.ok)
      .catch(() => false);
    current.saving = false;
    if (!ok && current.pending == null && current.revision === revision && current.canEdit) {
      current.pending = doc;
    }
    current.failures = ok ? 0 : current.failures + 1;
    if (current.mounted) setSaveState(ok ? 'saved' : 'error');
    if (current.pending == null || !current.canEdit) return;
    // A newer edit wins over a failed older snapshot. Back off transient failures;
    // no retry timer survives navigation away from the editor.
    if (ok) flushRef.current();
    else if (current.mounted) {
      clearTimer();
      current.timer = setTimeout(
        () => flushRef.current(),
        Math.min(30_000, 2000 * 2 ** Math.min(current.failures - 1, 4)),
      );
    }
  }, [clearTimer]);

  useLayoutEffect(() => {
    state.current.canEdit = canEdit;
    state.current.save = save;
    flushRef.current = () => {
      void flush();
    };
    if (!canEdit) {
      clearTimer();
      state.current.pending = null;
      state.current.revision++;
    }
  }, [canEdit, save, flush, clearTimer]);

  const schedule = useCallback(
    (doc: unknown, textChanged: boolean) => {
      clearTimer();
      const current = state.current;
      current.revision++;
      current.pending = null;
      if (textChanged || !current.canEdit) return;
      current.pending = doc;
      current.failures = 0;
      setSaveState('dirty');
      current.timer = setTimeout(() => flushRef.current(), 1000);
    },
    [clearTimer],
  );

  useEffect(() => {
    const current = state.current;
    current.mounted = true;
    return () => {
      current.mounted = false;
      clearTimer();
      // Keep the existing best-effort navigation flush, without background retries.
      if (current.pending != null) flushRef.current();
    };
  }, [clearTimer]);
  return { saveState, schedule, flush };
}
