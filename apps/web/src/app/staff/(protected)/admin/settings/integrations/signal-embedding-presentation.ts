import type { EmbeddingStatusResponse } from '@taxtronik/risk-layer';

export type EmbeddingJobState = EmbeddingStatusResponse['job']['state'];

const JOB_LABELS: Record<EmbeddingJobState, string> = {
  idle: 'Bereit',
  queued: 'Eingeplant',
  running: 'Wird aktualisiert',
  cancelling: 'Abbruch angefordert',
  cancelled: 'Abgebrochen',
  succeeded: 'Erfolgreich',
  failed: 'Fehlgeschlagen',
  skipped: 'Nicht erforderlich',
};

export function embeddingJobLabel(state: EmbeddingJobState): string {
  return JOB_LABELS[state];
}

export function isActiveEmbeddingJob(state: EmbeddingJobState): boolean {
  return state === 'queued' || state === 'running' || state === 'cancelling';
}

export function presentEmbeddingCurrent(current: boolean | null): {
  label: string;
  positive?: boolean;
} {
  if (current === null) return { label: 'Nicht prüfbar' };
  return current ? { label: 'Aktuell', positive: true } : { label: 'Veraltet', positive: false };
}

export function safeEmbeddingJobError(error: string | null): string | null {
  if (!error) return null;
  const compact = error.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, 500) : null;
}
