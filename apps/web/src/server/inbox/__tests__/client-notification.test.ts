import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  findAudit: vi.fn(),
  notifyContacts: vi.fn(),
  resolve: vi.fn(),
  notify: vi.fn(),
  audit: vi.fn(),
  scope: vi.fn(),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('@taxtronik/db', () => ({ withTenantContext: h.withTenant }));
vi.mock('@taxtronik/db/notification', () => ({ resolveNotificationsTx: h.resolve }));
vi.mock('@/server/mail/dispatch', () => ({ notifyClientContacts: h.notifyContacts }));
vi.mock('@/server/notifications/service', () => ({ notify: h.notify }));
vi.mock('@/server/container', () => ({ evidenceService: { record: h.audit } }));
vi.mock('@/server/logger', () => ({ log: h.log }));

import { sendInboxClientActivityMail } from '../client-notification';

const input = {
  context: { tenantId: 'tenant-1', actorId: 'staff-1', actorType: 'STAFF' as const },
  tenantId: 'tenant-1',
  clientId: 'client-1',
  staffId: 'staff-1',
  threadId: 'thread-1',
  messageId: 'message-1',
};

describe('ACCESS-NOTIFICATION-RECIPIENT-001 neutrale Inbox-E-Mail', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const tx = {
      $executeRaw: vi.fn(),
      $queryRaw: h.scope,
      auditLog: { findFirst: h.findAudit },
    };
    h.withTenant.mockImplementation(async (_context, callback) => callback(tx));
    h.findAudit.mockResolvedValue(null);
    h.scope.mockResolvedValue([{ allowed: true }]);
  });

  it('adressiert aktive bestätigte Kontakte ausschließlich mit festem Link und ohne Inhaltsvariablen', async () => {
    h.notifyContacts.mockResolvedValue({
      attempted: 2,
      recipients: 2,
      uncertainFailure: false,
      externalSideEffectOccurred: false,
    });

    await expect(sendInboxClientActivityMail(input)).resolves.toEqual({
      delivered: true,
      attempted: 2,
      accepted: 2,
      safeToRetry: false,
    });
    expect(h.notifyContacts).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      slug: 'portal-inbox-activity',
      vars: { link: 'https://portal.example.test/portal/inbox/thread-1' },
      fallback: {
        subject: 'Neue Nachricht im Mandantenportal',
        bodyMd: expect.stringContaining('keine Vorschau'),
      },
    });
    const serialized = JSON.stringify(h.notifyContacts.mock.calls[0]);
    expect(serialized).not.toContain('subjectPreview');
    expect(serialized).not.toContain('messageBody');
    expect(serialized).not.toContain('fileName');
  });

  it('journalisiert einen Totalfehler sichtbar und nur ohne Side-Effect als retrybar', async () => {
    h.notifyContacts.mockResolvedValue({
      attempted: 2,
      recipients: 0,
      uncertainFailure: false,
      externalSideEffectOccurred: false,
    });

    await expect(sendInboxClientActivityMail(input)).resolves.toMatchObject({
      delivered: false,
      safeToRetry: true,
    });
    expect(h.notify).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        clientId: 'client-1',
        kind: 'SYSTEM_MAIL_FAILED',
        resourceType: 'portal_inbox_message',
        resourceId: 'message-1',
      }),
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'portal_inbox.client_activity_mail_failed',
        after: expect.objectContaining({ safeToRetry: true }),
      }),
    );
  });

  it('versendet nach bereits protokolliertem Abschluss kein zweites Mal', async () => {
    h.findAudit.mockResolvedValueOnce({
      action: 'portal_inbox.client_activity_mail_completed',
      after: { attempted: 2, accepted: 2 },
    });
    await expect(sendInboxClientActivityMail(input)).resolves.toEqual({
      delivered: true,
      attempted: 0,
      accepted: 0,
      safeToRetry: false,
    });
    expect(h.notifyContacts).not.toHaveBeenCalled();
  });

  it('behandelt einen dauerhaften Claim als unsicher und verhindert Parallel- oder Crash-Retries', async () => {
    h.findAudit.mockResolvedValueOnce({
      action: 'portal_inbox.client_activity_mail_claimed',
      after: { retry: false },
    });

    await expect(sendInboxClientActivityMail(input)).resolves.toEqual({
      delivered: false,
      attempted: 0,
      accepted: 0,
      safeToRetry: false,
    });
    expect(h.notifyContacts).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it('stuft einen geworfenen Providerfehler konservativ als nicht retrybar ein', async () => {
    h.notifyContacts.mockRejectedValueOnce(new Error('provider connection lost'));

    await expect(sendInboxClientActivityMail(input)).resolves.toMatchObject({
      delivered: false,
      safeToRetry: false,
    });
    expect(h.audit).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'portal_inbox.client_activity_mail_failed',
        after: expect.objectContaining({ uncertainFailure: true, safeToRetry: false }),
      }),
    );
  });
});
