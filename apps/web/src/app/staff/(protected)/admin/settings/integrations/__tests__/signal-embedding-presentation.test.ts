import { describe, expect, it } from 'vitest';
import {
  embeddingJobLabel,
  isActiveEmbeddingJob,
  presentEmbeddingCurrent,
  safeEmbeddingJobError,
} from '../signal-embedding-presentation';

describe('Signal-Embedding-Darstellung', () => {
  it('pollt ausschließlich wartende und laufende Jobs', () => {
    expect(isActiveEmbeddingJob('queued')).toBe(true);
    expect(isActiveEmbeddingJob('running')).toBe(true);
    expect(isActiveEmbeddingJob('idle')).toBe(false);
    expect(isActiveEmbeddingJob('succeeded')).toBe(false);
    expect(isActiveEmbeddingJob('failed')).toBe(false);
    expect(isActiveEmbeddingJob('skipped')).toBe(false);
  });

  it('liefert verständliche deutsche Jobstatus', () => {
    expect(embeddingJobLabel('queued')).toBe('Eingeplant');
    expect(embeddingJobLabel('running')).toBe('Wird aktualisiert');
    expect(embeddingJobLabel('failed')).toBe('Fehlgeschlagen');
  });

  it('unterscheidet einen veralteten von einem nicht prüfbaren Index', () => {
    expect(presentEmbeddingCurrent(true)).toEqual({ label: 'Aktuell', positive: true });
    expect(presentEmbeddingCurrent(false)).toEqual({ label: 'Veraltet', positive: false });
    expect(presentEmbeddingCurrent(null)).toEqual({ label: 'Nicht prüfbar' });
  });

  it('begrenzt und vereinheitlicht die sichtbare Engine-Fehlermeldung', () => {
    expect(safeEmbeddingJobError('  erster\n zweiter  ')).toBe('erster zweiter');
    expect(safeEmbeddingJobError('x'.repeat(800))).toHaveLength(500);
    expect(safeEmbeddingJobError('   ')).toBeNull();
    expect(safeEmbeddingJobError(null)).toBeNull();
  });
});
