import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseFormData } from '../form-data';

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

  it('returns the shared action error without exposing schema details', () => {
    const result = parseFormData(z.object({ id: z.string().uuid() }), new FormData());
    expect(result).toEqual({ ok: false, error: 'Validierungsfehler.' });
  });
});
