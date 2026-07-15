import { describe, expect, it, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { readRequestCreationOptionsTx } from '../request-creation-options';

describe('readRequestCreationOptionsTx', () => {
  it('vereinigt referenzierte Formulare mit dem begrenzten Auswahlkatalog', async () => {
    const linkedId = '11111111-1111-4111-8111-111111111111';
    const requestTemplate = {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Mit Formular',
      category: null,
      title: 'Unterlagen',
      description: 'Bitte ausfüllen.',
      priority: 'NORMAL' as const,
      dueAfterDays: null,
      formTemplateId: linkedId,
    };
    const baseForms = Array.from({ length: 3 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      name: `Formular ${index}`,
    }));
    const formFindMany = vi
      .fn()
      .mockResolvedValueOnce(baseForms)
      .mockResolvedValueOnce([{ id: linkedId, name: 'Zugeordnetes Formular' }]);
    const tx = {
      requestTemplate: { findMany: vi.fn().mockResolvedValue([requestTemplate]) },
      formTemplate: { findMany: formFindMany },
    } as unknown as TxClient;

    const result = await readRequestCreationOptionsTx(tx, 2);

    expect(result.templatesLimited).toBe(false);
    expect(result.formTemplatesLimited).toBe(true);
    expect(result.requestTemplates).toEqual([requestTemplate]);
    expect(result.requestFormTemplates).toEqual(
      expect.arrayContaining([{ id: linkedId, name: 'Zugeordnetes Formular' }]),
    );
    expect(formFindMany).toHaveBeenLastCalledWith({
      where: { id: { in: [linkedId] }, active: true },
      select: { id: true, name: true },
    });
  });
});
