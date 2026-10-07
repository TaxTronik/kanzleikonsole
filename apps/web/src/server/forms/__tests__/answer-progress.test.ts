// Fachkatalog: YEAR-END-CAMPAIGN-001
// P-19: Der gespeicherte Fortschritt ist genau formAnswerProgress der
// gespeicherten Antworten; „nicht berechenbar“ bleibt von „nicht gespeichert“
// unterscheidbar.
import { describe, expect, it } from 'vitest';
import {
  answerProgressColumns,
  storedAnswerProgress,
  type AnswerProgressColumns,
} from '../answer-progress';
import { freezeFormSchema } from '../schema-snapshot';
import { formAnswerProgress } from '@/server/workflows/dashboard-policy';

type FieldType = Parameters<typeof freezeFormSchema>[0]['fields'][number]['type'];

function field(key: string, type: FieldType, required: boolean) {
  return {
    id: `field-${key}`,
    key,
    label: key.toUpperCase(),
    type,
    required,
    options: null,
    helpText: null,
    defaultValue: null,
    minValue: null,
    maxValue: null,
  };
}

const SNAPSHOT = freezeFormSchema({
  name: 'Checkliste',
  description: null,
  introMd: null,
  fields: [
    field('name', 'TEXT', true),
    field('hinweis', 'INFO_TEXT', false),
    field('betrag', 'MONEY', false),
    field('bestaetigt', 'CHECKBOX', true),
    field('anzahl', 'NUMBER', false),
  ],
});
const AT = new Date('2026-10-07T08:00:00Z');
const SUBMISSION = { schemaSnapshot: SNAPSHOT, answerProgressAt: null };

describe('answerProgressColumns', () => {
  it('speichert die Zählung von formAnswerProgress für genau diese Antworten', () => {
    for (const answers of [
      {},
      { name: 'Mara' },
      // Nullbetrag zählt, eine nicht bestätigte Pflicht-Checkbox nicht.
      { name: 'Mara', betrag: 0, bestaetigt: false },
      { name: 'Mara', betrag: 12.5, bestaetigt: true, anzahl: 3 },
      // Ungültige Werte zählen nicht.
      { name: '  ', betrag: 1.005, anzahl: 'drei' },
    ]) {
      const progress = formAnswerProgress(SNAPSHOT, answers)!;
      expect(answerProgressColumns(SUBMISSION, answers, AT), JSON.stringify(answers)).toEqual({
        answerProgressAt: AT,
        answerProgressFilled: progress.filled,
        answerProgressTotal: progress.total,
        answerProgressRequiredFilled: progress.requiredFilled,
        answerProgressRequiredTotal: progress.requiredTotal,
      });
    }
    expect(
      answerProgressColumns(SUBMISSION, { name: 'Mara', betrag: 0, bestaetigt: false }, AT),
    ).toMatchObject({
      answerProgressFilled: 2,
      answerProgressTotal: 4,
      answerProgressRequiredFilled: 1,
      answerProgressRequiredTotal: 2,
    });
  });

  it('markiert fehlende oder beschädigte Schemata als gespeichert, aber nicht berechenbar', () => {
    for (const schemaSnapshot of [null, { version: 1, fields: [{}] }, { version: 2, fields: [] }]) {
      expect(answerProgressColumns({ schemaSnapshot }, { name: 'Mara' }, AT)).toEqual({
        answerProgressAt: AT,
        answerProgressFilled: null,
        answerProgressTotal: null,
        answerProgressRequiredFilled: null,
        answerProgressRequiredTotal: null,
      });
    }
  });
});

describe('answerProgressColumns – Zeitstempel', () => {
  // Der Trigger erkennt eine Neuberechnung nur an einem neuen Zeitstempel.
  it('liegt immer nach dem gespeicherten, auch in derselben Millisekunde', () => {
    const at = (previous: Date | null, now: Date) =>
      answerProgressColumns(
        { schemaSnapshot: SNAPSHOT, answerProgressAt: previous },
        {},
        now,
      ).answerProgressAt!.getTime();
    const later = new Date(AT.getTime() + 5_000);

    expect(at(null, AT)).toBe(AT.getTime());
    expect(at(AT, later)).toBe(later.getTime());
    expect(at(AT, AT)).toBe(AT.getTime() + 1);
    // Nachgehende Uhr eines anderen Servers.
    expect(at(later, AT)).toBe(later.getTime() + 1);
  });
});

describe('storedAnswerProgress', () => {
  const NOT_STORED: AnswerProgressColumns = {
    answerProgressAt: null,
    answerProgressFilled: null,
    answerProgressTotal: null,
    answerProgressRequiredFilled: null,
    answerProgressRequiredTotal: null,
  };

  it('liest denselben Fortschritt zurück, den formAnswerProgress liefert', () => {
    for (const answers of [{}, { name: 'Mara', betrag: 0 }, { name: 'Mara', anzahl: 1 }]) {
      expect(storedAnswerProgress(answerProgressColumns(SUBMISSION, answers, AT))).toEqual(
        formAnswerProgress(SNAPSHOT, answers),
      );
    }
    const empty = freezeFormSchema({ name: 'Leer', description: null, introMd: null, fields: [] });
    expect(storedAnswerProgress(answerProgressColumns({ schemaSnapshot: empty }, {}, AT))).toEqual(
      formAnswerProgress(empty, {}),
    );
    expect(formAnswerProgress(empty, {})).toMatchObject({ total: 0, percent: null });
  });

  it('unterscheidet „nicht gespeichert“ (undefined) von „nicht berechenbar“ (null)', () => {
    expect(storedAnswerProgress(NOT_STORED)).toBeUndefined();
    expect(
      storedAnswerProgress(answerProgressColumns({ schemaSnapshot: null }, {}, AT)),
    ).toBeNull();
  });
});
