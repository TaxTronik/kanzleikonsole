// Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notifyClientContacts: vi.fn(),
}));

vi.mock('@taxtronik/config', () => ({ portalBaseUrl: 'https://portal.example.test' }));
vi.mock('../dispatch', () => ({
  notifyClientContacts: mocks.notifyClientContacts,
}));

import {
  AUTOMATIC_TAX_REQUEST_OPENED_FALLBACK,
  notifyAutomaticTaxRequestOpened,
} from '../request-opened';

describe('datenminimierte automatische Steuertermin-Anforderung', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notifyClientContacts.mockResolvedValue({
      ok: true,
      recipients: 1,
      attempted: 1,
      externalSideEffectOccurred: false,
      uncertainFailure: false,
    });
  });

  it('stellt weder Steuerdetails noch Fälligkeit als Mail-Template-Variable bereit', async () => {
    await notifyAutomaticTaxRequestOpened({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      requestId: 'request-1',
      priority: 'HIGH',
      dueAtIso: '2026-09-10T00:00:00.000Z',
    });

    expect(mocks.notifyClientContacts).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      clientId: 'client-1',
      slug: 'tax-deadline-request-opened',
      subjectSuffix: '',
      vars: {
        request: { id: 'request-1' },
        portalUrl: 'https://portal.example.test/portal/requests/request-1',
      },
      n8nEvent: 'request.opened',
      n8nPayload: {
        tenantId: 'tenant-1',
        requestId: 'request-1',
        clientId: 'client-1',
        priority: 'HIGH',
        dueAt: '2026-09-10T00:00:00.000Z',
      },
      fallback: AUTOMATIC_TAX_REQUEST_OPENED_FALLBACK,
    });
    expect(JSON.stringify(mocks.notifyClientContacts.mock.calls[0]?.[0].vars)).not.toContain(
      '2026-09-10',
    );
  });

  it('enthält im Fallback ausschließlich den neutralen Portalhinweis', () => {
    expect(AUTOMATIC_TAX_REQUEST_OPENED_FALLBACK.subject).toBe(
      'Neue Anforderung in Ihrem Mandantenportal',
    );
    expect(AUTOMATIC_TAX_REQUEST_OPENED_FALLBACK.bodyMd).not.toMatch(
      /request\.(?:title|description)|Steuer|Frist|Fälligkeit/i,
    );
  });
});
