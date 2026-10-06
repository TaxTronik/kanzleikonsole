import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  formDefault,
  formEmpty,
  formFlag,
  formList,
  formOptional,
  parseFormData,
} from '../form-data';

describe('parseFormData', () => {
  it('preserves empty fields and leaves missing fields undefined', () => {
    const formData = new FormData();
    formData.set('name', 'Beispiel');
    formData.set('description', '');

    const result = parseFormData(
      z.object({
        name: z.string().min(2),
        description: z.string().optional(),
        absent: z.string().optional(),
      }),
      formData,
    );

    expect(result).toEqual({
      ok: true,
      data: { name: 'Beispiel', description: '' },
    });
  });

  it('collects only explicitly repeatable fields', () => {
    const formData = new FormData();
    formData.append('events', 'first');
    formData.append('events', 'second');

    const result = parseFormData(z.object({ events: z.array(z.string()) }), formData, {
      repeatable: ['events'],
    });

    expect(result).toEqual({ ok: true, data: { events: ['first', 'second'] } });
  });

  it('keeps FormData#get first-value semantics for scalar fields', () => {
    const formData = new FormData();
    formData.append('name', 'first');
    formData.append('name', 'second');

    expect(parseFormData(z.object({ name: z.string() }), formData)).toEqual({
      ok: true,
      data: { name: 'first' },
    });
  });

  it('lets schemas apply defaults for missing fields', () => {
    const result = parseFormData(
      z.object({ tenantSlug: z.string().min(1).default('default') }),
      new FormData(),
    );

    expect(result).toEqual({ ok: true, data: { tenantSlug: 'default' } });
  });

  it('returns the shared action error with field association', () => {
    const result = parseFormData(z.object({ id: z.string().uuid() }), new FormData());
    expect(result).toEqual({
      ok: false,
      error: 'Bitte prüfen Sie die markierten Angaben.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: {
        id: ['Invalid input: expected string, received undefined'],
      },
    });
  });
});

describe('Feldschemas für parseFormData (R-12)', () => {
  // Bisherige Form der Actions: Schema aus formData.get-Umwandlungen befüllt.
  const Base = {
    uuid: z.string().uuid(),
    note: z.string().max(5),
    ids: z.array(z.string().uuid()).max(2),
    optionalNote: z.string().nullable(),
    // `.optional()` ohne `.nullable()`: ein fehlendes Feld war bisher `null` → Fehler.
    remark: z.string().max(5).optional(),
    approve: z.enum(['1', 'true']).optional(),
    datevNo: z.string().max(5).optional(),
  };
  const legacy = (formData: FormData) =>
    z
      .object({
        clientId: Base.uuid,
        note: Base.note,
        confirmed: z.boolean(),
        ids: Base.ids,
        reference: Base.optionalNote,
        remark: Base.remark,
        approve: Base.approve,
        datevNo: Base.datevNo,
        ended: z.boolean(),
      })
      .safeParse({
        clientId: formData.get('clientId'),
        note: formData.get('note') ?? '',
        confirmed: formData.get('confirmed') === 'on',
        ids: formData.getAll('ids').map(String),
        reference: formData.get('reference') || null,
        remark: formData.get('remark'),
        approve: formData.get('approve') ?? undefined,
        datevNo: formData.get('datevNo') || undefined,
        ended: formData.get('ended') === 'on' || formData.get('ended') === '1',
      });
  const migrated = (formData: FormData) =>
    parseFormData(
      z.object({
        clientId: Base.uuid,
        note: formDefault('', Base.note),
        confirmed: formFlag(),
        ids: formList(Base.ids),
        reference: formEmpty(null, Base.optionalNote),
        remark: Base.remark,
        approve: formOptional(Base.approve),
        datevNo: formEmpty(undefined, Base.datevNo),
        ended: formFlag(['on', '1']),
      }),
      formData,
      { repeatable: ['ids'], absentAsNull: true },
    );

  const ID_1 = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
  const ID_2 = '7a2b3c4d-5e6f-4a7b-9c8d-0e1f2a3b4c5d';
  const file = () => new File(['%PDF-'], 'beleg.pdf', { type: 'application/pdf' });
  const variants: Array<[string, Array<[string, string | File]>]> = [
    [
      'vollständig',
      [
        ['clientId', ID_1],
        ['note', 'kurz'],
        ['confirmed', 'on'],
        ['ids', ID_1],
        ['ids', ID_2],
        ['reference', 'R-1'],
        ['remark', 'ok'],
        ['approve', '1'],
        ['datevNo', '123'],
        ['ended', '1'],
      ],
    ],
    ['alles fehlt', []],
    [
      'leere Felder',
      [
        ['clientId', ''],
        ['note', ''],
        ['reference', ''],
        ['remark', ''],
        ['approve', ''],
        ['datevNo', ''],
        ['ended', ''],
      ],
    ],
    [
      'Schalter mit anderem Wert, doppeltes Skalarfeld',
      [
        ['clientId', ID_1],
        ['clientId', 'zweiter'],
        ['confirmed', 'yes'],
        ['ended', 'on'],
        ['approve', 'true'],
      ],
    ],
    [
      'ungültige Werte',
      [
        ['clientId', 'kein-uuid'],
        ['note', 'viel zu lang'],
        ['ids', 'x'],
        ['ids', ID_1],
        ['ids', ID_2],
        ['approve', 'ja'],
        ['datevNo', 'zu lang'],
      ],
    ],
    [
      'Datei statt Text',
      [
        ['clientId', file()],
        ['note', file()],
        ['confirmed', file()],
        ['ids', file()],
        ['reference', file()],
        ['approve', file()],
        ['datevNo', file()],
      ],
    ],
  ];

  it.each(variants)(
    'liefert dieselben Daten bzw. Meldungen wie formData.get (%s)',
    (_, entries) => {
      const formData = new FormData();
      for (const [key, value] of entries) formData.append(key, value);

      const before = legacy(formData);
      const after = migrated(formData);

      if (before.success) {
        expect(after).toEqual({ ok: true, data: before.data });
      } else {
        expect(after.ok).toBe(false);
        const issues = before.error.issues.map((issue) => [issue.path.join('.'), issue.message]);
        const fieldErrors = !after.ok ? after.fieldErrors : {};
        expect(
          Object.entries(fieldErrors).flatMap(([field, messages]) =>
            messages.map((message) => [field, message]),
          ),
        ).toEqual(issues);
      }
    },
  );

  it('bildet die Gesamtmeldung auf Wunsch aus den Issues', () => {
    const formData = new FormData();
    formData.set('name', '');

    const result = parseFormData(z.object({ name: z.string().min(1, 'Name fehlt.') }), formData, {
      errorMessage: (issues) => `Validierungsfehler: ${issues.map((i) => i.message).join('; ')}`,
    });

    expect(result).toEqual({
      ok: false,
      error: 'Validierungsfehler: Name fehlt.',
      errorCode: 'VALIDATION_ERROR',
      fieldErrors: { name: ['Name fehlt.'] },
    });
  });
});

describe('parseFormData mit absentAsNull', () => {
  it('füllt fehlende Felder des Objekt-Schemas wie FormData#get bzw. getAll', () => {
    const formData = new FormData();
    formData.set('present', 'x');

    const result = parseFormData(
      z
        .object({
          present: z.string(),
          missing: z.string().nullable(),
          list: z.array(z.string()),
        })
        .superRefine(() => undefined),
      formData,
      { repeatable: ['list'], absentAsNull: true },
    );

    expect(result).toEqual({ ok: true, data: { present: 'x', missing: null, list: [] } });
  });

  it('findet die Felder auch hinter einer Umformung (.transform)', () => {
    const formData = new FormData();
    formData.set('role.ADMIN', 'on');

    const result = parseFormData(
      z
        .object({ 'role.ADMIN': formFlag(), note: z.string().nullable() })
        .transform(({ 'role.ADMIN': admin, note }) => ({ admin, note })),
      formData,
      { absentAsNull: true },
    );

    expect(result).toEqual({ ok: true, data: { admin: true, note: null } });
  });

  it('verlangt ein Objekt-Schema', () => {
    expect(() => parseFormData(z.string(), new FormData(), { absentAsNull: true })).toThrow(
      'absentAsNull braucht ein z.object-Schema',
    );
  });
});
