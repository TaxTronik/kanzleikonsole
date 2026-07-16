'use client';

import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { ActionResult } from './n8n-actions';

export function N8nActionResult({ result }: { result: ActionResult | null | undefined }) {
  if (!result) return null;
  return result.ok ? (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
      <CheckCircle2 className="h-4 w-4" /> {result.message ?? 'Erledigt.'}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 whitespace-pre-wrap text-xs text-red-700 dark:text-red-400">
      <AlertCircle className="h-4 w-4 shrink-0" /> {result.error ?? 'Fehler.'}
    </span>
  );
}
