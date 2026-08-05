import { describe, expect, it } from 'vitest';
import { deriveAutoRequestPipeline, type PipelineInput } from '../tax-deadline-pipeline';

const TODAY = new Date(Date.UTC(2026, 5, 9)); // 09.06.2026
const DUE = new Date(Date.UTC(2026, 5, 20)); // 20.06.2026

function input(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    status: 'PLANNED',
    requestId: null,
    staffNotifiedAt: null,
    autoRequestSuppressedAt: null,
    dueDate: DUE,
    config: { active: true, autoRequest: true, reminderDaysBefore: 10, staffLeadDays: 3 },
    today: TODAY,
    ...overrides,
  };
}

describe('deriveAutoRequestPipeline', () => {
  it('SENT sobald ein Request verknüpft ist — unabhängig vom Rest', () => {
    expect(
      deriveAutoRequestPipeline(input({ requestId: 'req-1', autoRequestSuppressedAt: new Date() })),
    ).toEqual({ state: 'SENT' });
  });

  it('SUPPRESSED wenn gestoppt und noch kein Request raus ist', () => {
    expect(deriveAutoRequestPipeline(input({ autoRequestSuppressedAt: new Date() }))).toEqual({
      state: 'SUPPRESSED',
    });
  });

  it('NONE ohne Config, bei autoRequest=false und nach Fälligkeit', () => {
    expect(deriveAutoRequestPipeline(input({ config: null }))).toEqual({ state: 'NONE' });
    expect(
      deriveAutoRequestPipeline(
        input({
          config: { active: true, autoRequest: false, reminderDaysBefore: 10, staffLeadDays: 3 },
        }),
      ),
    ).toEqual({ state: 'NONE' });
    expect(deriveAutoRequestPipeline(input({ dueDate: new Date(Date.UTC(2026, 5, 8)) }))).toEqual({
      state: 'NONE',
    });
    expect(deriveAutoRequestPipeline(input({ status: 'OVERDUE' }))).toEqual({ state: 'NONE' });
  });

  it('WARNED: Versand am Folgetag, wenn das Fenster schon offen ist', () => {
    // sendFrom = 10.06. = morgen → sendDate = 10.06.
    const res = deriveAutoRequestPipeline(
      input({ staffNotifiedAt: new Date('2026-06-09T07:35:00.000Z') }),
    );
    expect(res).toEqual({ state: 'WARNED', sendDate: new Date(Date.UTC(2026, 5, 10)) });
  });

  it('WARNED: künftiges Versanddatum bleibt stehen', () => {
    // reminder 5 → sendFrom = 15.06. (nach morgen)
    const res = deriveAutoRequestPipeline(
      input({
        staffNotifiedAt: new Date('2026-06-09T07:35:00.000Z'),
        config: { active: true, autoRequest: true, reminderDaysBefore: 5, staffLeadDays: 3 },
      }),
    );
    expect(res).toEqual({ state: 'WARNED', sendDate: new Date(Date.UTC(2026, 5, 15)) });
  });

  it('SCHEDULED ohne Vorwarnung (staffLeadDays 0): frühestens heute', () => {
    // reminder 14 → sendFrom = 06.06. < heute → sendDate = heute
    const res = deriveAutoRequestPipeline(
      input({
        config: { active: true, autoRequest: true, reminderDaysBefore: 14, staffLeadDays: 0 },
      }),
    );
    expect(res).toEqual({ state: 'SCHEDULED', sendDate: TODAY });
  });

  it('SCHEDULED mit ausstehender Vorwarnung: Warn-Tag + 1 Tageslauf', () => {
    // reminder 14, lead 3 → sendFrom = 06.06., warnFrom = 03.06. — beides
    // vorbei: Warnung kommt heute, Versand frühestens morgen (10.06.).
    const res = deriveAutoRequestPipeline(
      input({
        config: { active: true, autoRequest: true, reminderDaysBefore: 14, staffLeadDays: 3 },
      }),
    );
    expect(res).toEqual({ state: 'SCHEDULED', sendDate: new Date(Date.UTC(2026, 5, 10)) });
  });

  it('SCHEDULED im Normalfall: reguläres Versanddatum', () => {
    // reminder 5, lead 2 → sendFrom = 15.06., warnFrom = 13.06. (Zukunft) →
    // sendDate = 15.06. (warnDate 13.06. + 1 = 14.06. < sendFrom).
    const res = deriveAutoRequestPipeline(
      input({
        config: { active: true, autoRequest: true, reminderDaysBefore: 5, staffLeadDays: 2 },
      }),
    );
    expect(res).toEqual({ state: 'SCHEDULED', sendDate: new Date(Date.UTC(2026, 5, 15)) });
  });
});
