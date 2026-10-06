// Review-Befund R-12: audit(tx, g, event) übernimmt Mandant und Akteur aus dem
// Tenant-Kontext des Gates. Nachweis, dass das an evidenceService.record
// übergebene Ereignis feldgleich zum handgeschriebenen Aufruf ist und damit
// denselben Hash in der Audit-Kette ergibt.
// Fachkatalog: AUDIT-HASH-CHAIN-001

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { eventHash, type AuditEventInput } from '@taxtronik/evidence';
import type { TenantContext } from '@taxtronik/db';

const h = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.record } }));

import { audit, type ActionAuditEvent } from '../audit';

const TENANT = '00000000-0000-4000-8000-000000000001';
const STAFF = '00000000-0000-4000-8000-000000000002';
const CONTACT = '00000000-0000-4000-8000-000000000003';
const RESOURCE = '00000000-0000-4000-8000-000000000004';
const tx = { $queryRaw: vi.fn(), $queryRawUnsafe: vi.fn(), $executeRaw: vi.fn() };

/** So liefern staffActionGuard/withStaff/staffAction den Kontext (`g`). */
const staffGuard = {
  tenantId: TENANT,
  staffId: STAFF,
  ctx: { tenantId: TENANT, actorId: STAFF, actorType: 'STAFF' } satisfies TenantContext,
};
/** So liefern portalActionGuard/withPortalContext/portalAction den Kontext. */
const portalGuard = {
  tenantId: TENANT,
  contactId: CONTACT,
  clientId: RESOURCE,
  ctx: { tenantId: TENANT, actorId: CONTACT, actorType: 'CLIENT_CONTACT' } satisfies TenantContext,
};

function recorded(): AuditEventInput {
  expect(h.record).toHaveBeenCalledOnce();
  expect(h.record.mock.calls[0]![0]).toBe(tx);
  return h.record.mock.calls[0]![1] as AuditEventInput;
}

function chainHash(event: AuditEventInput): string {
  const occurredAt = new Date('2026-10-06T08:00:00.000Z');
  return eventHash(Buffer.alloc(32), {
    tenantId: event.tenantId,
    occurredAt,
    actorType: event.actorType,
    actorId: event.actorId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId ?? null,
    before: event.before,
    after: event.after,
  }).toString('hex');
}

beforeEach(() => {
  h.record.mockReset();
  h.record.mockResolvedValue({ id: 1n });
});

describe('audit(tx, g, event)', () => {
  it('schreibt für Staff dasselbe Ereignis wie der handgeschriebene Aufruf', async () => {
    const handFilled: AuditEventInput = {
      tenantId: staffGuard.tenantId,
      actorType: 'STAFF',
      actorId: staffGuard.staffId,
      action: 'kb.article.update',
      resourceType: 'kb_article',
      resourceId: RESOURCE,
      before: { title: 'Alt', published: false },
      after: { title: 'Neu', published: true, attachmentCount: 0 },
    };

    await audit(tx, staffGuard, {
      action: 'kb.article.update',
      resourceType: 'kb_article',
      resourceId: RESOURCE,
      before: { title: 'Alt', published: false },
      after: { title: 'Neu', published: true, attachmentCount: 0 },
    });

    const event = recorded();
    expect(event).toStrictEqual(handFilled);
    expect(chainHash(event)).toBe(chainHash(handFilled));
  });

  it('schreibt für das Portal den Kontakt als Akteur', async () => {
    await audit(tx, portalGuard, {
      action: 'appointment_request.create',
      resourceType: 'appointment_request',
      resourceId: RESOURCE,
      after: { slots: 2 },
    });

    expect(recorded()).toStrictEqual({
      tenantId: TENANT,
      actorType: 'CLIENT_CONTACT',
      actorId: CONTACT,
      action: 'appointment_request.create',
      resourceType: 'appointment_request',
      resourceId: RESOURCE,
      after: { slots: 2 },
    });
  });

  it('nimmt auch den Tenant-Kontext selbst und ergänzt keine leeren Felder', async () => {
    await audit(tx, staffGuard.ctx, { action: 'kb.category.create', resourceType: 'kb_category' });

    // toStrictEqual: kein `before: undefined`, `after: undefined` oder `resourceId: undefined`.
    expect(recorded()).toStrictEqual({
      tenantId: TENANT,
      actorType: 'STAFF',
      actorId: STAFF,
      action: 'kb.category.create',
      resourceType: 'kb_category',
    });
  });

  it('lässt Mandant und Akteur nicht vom Ereignis überschreiben', async () => {
    const smuggled = {
      action: 'x.y',
      resourceType: 'x',
      tenantId: 'fremd',
      actorType: 'SYSTEM',
      actorId: null,
    } as unknown as ActionAuditEvent;

    await audit(tx, staffGuard, smuggled);

    expect(recorded()).toMatchObject({ tenantId: TENANT, actorType: 'STAFF', actorId: STAFF });
  });

  it('verlangt das Ereignis ohne Akteur-Tripel (Typvertrag)', () => {
    expectTypeOf<ActionAuditEvent>().not.toHaveProperty('tenantId');
    expectTypeOf<ActionAuditEvent>().not.toHaveProperty('actorType');
    expectTypeOf<ActionAuditEvent>().not.toHaveProperty('actorId');
    expectTypeOf<ActionAuditEvent>().toHaveProperty('action');
    expectTypeOf<ActionAuditEvent>().toHaveProperty('before');
  });
});
