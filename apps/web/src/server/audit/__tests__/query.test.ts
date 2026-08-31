import { describe, expect, it } from 'vitest';
import {
  AuditQuerySchema,
  auditCategory,
  auditWhere,
  auditPageWhere,
  auditQueryString,
} from '../query';

describe('AUDIT-HASH-CHAIN-001: read-only audit views', () => {
  it('classifies GwG actions across resource families and preserves unknown history', () => {
    expect(auditCategory('gwg.check.verify')).toBe('gwg');
    expect(auditCategory('client.update.gwg_relevant')).toBe('gwg');
    expect(auditCategory('client.deactivate.gwg_expired')).toBe('gwg');
    expect(auditCategory('document.download')).toBe('documents');
    expect(auditCategory('future.unknown')).toBe('other');
    expect(auditCategory('gwg.future_unknown')).toBe('other');
  });

  it('combines category and action filters rather than overwriting either', () => {
    const query = AuditQuerySchema.parse({ category: 'gwg', action: 'client', actorType: 'STAFF' });
    const where = auditWhere(query);
    expect(where).toMatchObject({
      action: { contains: 'client' },
      actorType: 'STAFF',
      AND: [{ action: { in: expect.arrayContaining(['client.update.gwg_relevant']) } }],
    });
    expect(auditWhere(AuditQuerySchema.parse({ category: 'other' }))).toMatchObject({
      AND: [{ action: { notIn: expect.arrayContaining(['gwg.check.verify']) } }],
    });
  });

  it.each([
    ['2026-01-15', '2026-01-14T23:00:00.000Z', '2026-01-15T22:59:59.999Z'],
    ['2026-07-15', '2026-07-14T22:00:00.000Z', '2026-07-15T21:59:59.999Z'],
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T21:59:59.999Z'],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T22:59:59.999Z'],
  ])('uses Berlin boundaries for UI and export on %s', (day, start, end) => {
    const query = AuditQuerySchema.parse({ from: day, to: day });
    expect(auditWhere(query)).toEqual({
      occurredAt: { gte: new Date(start), lt: new Date(new Date(end).getTime() + 1) },
    });
    expect(auditPageWhere(query)).toEqual(auditWhere(query));
  });

  it('paginates with exclusive IDs in both directions and keeps counts/export cursor-free', () => {
    for (const sort of ['newest', 'oldest']) {
      const query = AuditQuerySchema.parse({ category: 'gwg', sort });
      const where = auditPageWhere(query, '9007199254740993');
      expect(where.id).toEqual(
        sort === 'oldest' ? { gt: 9007199254740993n } : { lt: 9007199254740993n },
      );
      expect(auditWhere(query).id).toBeUndefined();
      expect(auditQueryString(query).get('category')).toBe('gwg');
      expect(auditQueryString(query).get('sort')).toBe(sort);
      expect(auditQueryString(query).has('cursor')).toBe(false);
    }
  });

  it('rejects malformed filter values and reversed dates', () => {
    for (const query of [
      { category: 'invalid' },
      { sort: 'action' },
      { from: '2026-02-31' },
      { from: '2026-08-02', to: '2026-08-01' },
    ]) {
      expect(AuditQuerySchema.safeParse(query).success).toBe(false);
    }
  });
});
