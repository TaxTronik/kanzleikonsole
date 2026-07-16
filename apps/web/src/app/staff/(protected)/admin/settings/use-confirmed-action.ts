'use client';

import { useCallback, type TransitionStartFunction } from 'react';

type Confirmation<TArgs extends unknown[]> = string | null | ((...args: TArgs) => string | null);

interface ConfirmedActionOptions<TArgs extends unknown[], TResult> {
  startTransition: TransitionStartFunction;
  confirmation: Confirmation<TArgs>;
  action: (...args: TArgs) => Promise<TResult>;
  onPending?: (...args: TArgs) => void;
  onResult?: (result: TResult, ...args: TArgs) => void;
}

/**
 * Gemeinsamer Ablauf fuer irreversible Admin-Aktionen. Der aufrufende Screen
 * behaelt seine eine Transition und damit die bestehende globale Busy-Semantik.
 */
export function useConfirmedAction<TArgs extends unknown[], TResult>({
  startTransition,
  confirmation,
  action,
  onPending,
  onResult,
}: ConfirmedActionOptions<TArgs, TResult>): (...args: TArgs) => void {
  return useCallback(
    (...args: TArgs) => {
      const message = typeof confirmation === 'function' ? confirmation(...args) : confirmation;
      if (message && !window.confirm(message)) return;

      onPending?.(...args);
      startTransition(async () => {
        const result = await action(...args);
        onResult?.(result, ...args);
      });
    },
    [action, confirmation, onPending, onResult, startTransition],
  );
}
