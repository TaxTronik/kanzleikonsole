// Fachkatalog: PORTAL-INBOX-SUBMISSION-001
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ assertPortal: vi.fn(), advance: vi.fn() }));
vi.mock('../access', () => ({ assertActivePortalInboxIdentityTx: h.assertPortal }));
vi.mock('../routing', () => ({ resolveInboxNotificationRecipientsTx: vi.fn() }));
vi.mock('../read-state', () => ({ advancePortalInboxReadTx: h.advance }));
vi.mock('@/server/container', () => ({ evidenceService: { record: vi.fn() } }));

import { markPortalInboxThreadReadTx } from '../portal-mutations';

const actor = { tenantId: 'tenant', clientId: 'client', contactId: 'contact' };
const displayed = new Date('2026-09-14T00:00:00.000Z');
const latest = new Date('2026-09-14T00:00:01.000Z');
const findFirst = vi.fn();
const tx = { portalInboxThread: { findFirst } };

describe('PORTAL-INBOX-SUBMISSION-001: nur angezeigte Nachrichten bestätigen', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    findFirst.mockResolvedValue({ lastMessageAt: latest });
  });

  it('lässt eine zwischen Render und Action neu eingegangene Antwort ungelesen', async () => {
    await markPortalInboxThreadReadTx(tx as never, actor, 'thread', displayed);

    expect(h.assertPortal).toHaveBeenCalledWith(tx, actor);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'thread', tenantId: actor.tenantId, clientId: actor.clientId },
      select: { lastMessageAt: true },
    });
    expect(h.advance).toHaveBeenCalledWith(tx, actor, 'thread', displayed);
  });

  it('bestätigt den neueren Stand erst nach dessen Anzeige', async () => {
    await markPortalInboxThreadReadTx(tx as never, actor, 'thread', latest);

    expect(h.advance).toHaveBeenCalledWith(tx, actor, 'thread', latest);
  });

  it('begrenzt einen vorgegebenen zukünftigen Stand auf die vorhandenen Nachrichten', async () => {
    await markPortalInboxThreadReadTx(
      tx as never,
      actor,
      'thread',
      new Date('2099-01-01T00:00:00.000Z'),
    );

    expect(h.advance).toHaveBeenCalledWith(tx, actor, 'thread', latest);
  });

  it('schreibt bei entzogener Identität keinen Lesestand', async () => {
    h.assertPortal.mockRejectedValue(new Error('Zugriff entzogen'));

    await expect(
      markPortalInboxThreadReadTx(tx as never, actor, 'thread', displayed),
    ).rejects.toThrow('Zugriff entzogen');
    expect(findFirst).not.toHaveBeenCalled();
    expect(h.advance).not.toHaveBeenCalled();
  });

  it('schreibt bei fremdem oder nicht vorhandenem Verlauf keinen Lesestand', async () => {
    findFirst.mockResolvedValue(null);

    await expect(
      markPortalInboxThreadReadTx(tx as never, actor, 'thread', displayed),
    ).rejects.toThrow('Verlauf nicht gefunden');
    expect(h.advance).not.toHaveBeenCalled();
  });

  it('weist einen ungültigen Zeitwert vor dem Schreiben zurück', async () => {
    await expect(
      markPortalInboxThreadReadTx(tx as never, actor, 'thread', new Date('invalid')),
    ).rejects.toThrow('Ungültiger Lesestand');
    expect(h.advance).not.toHaveBeenCalled();
  });
});
