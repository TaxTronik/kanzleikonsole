import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../page.tsx'), 'utf8');
const deadlineQuery = source.slice(
  source.indexOf('tx.taxDeadline.'),
  source.indexOf('tx.appointment.findMany'),
);

describe('Kalender-Steuertermine', () => {
  it('aggregiert die Monatsdaten in der Datenbank und lädt keine Client-Relation', () => {
    expect(deadlineQuery).toContain('tx.taxDeadline.groupBy({');
    expect(deadlineQuery).toContain("by: ['dueDate', 'kind', 'period', 'status']");
    expect(deadlineQuery).toContain('_count: { _all: true }');
    expect(deadlineQuery).not.toContain('findMany');
    expect(deadlineQuery).not.toContain('include');
  });

  it('übernimmt die DB-Zähler in Gesamt- und Offen-Anzahl', () => {
    expect(source).toContain('g.total += d._count._all');
    expect(source).toContain('if (isOpen) g.open += d._count._all');
  });
});
