// F-08: Die Oberfläche zeigt statt „versendet" den Stand der Versandaufträge.
import { describe, expect, it } from 'vitest';

import {
  MAIL_DELIVERY_STATE_LABELS,
  summarizeMailDelivery,
  type MailOutboxStatusRow,
} from '../mail-delivery-status';

const T0 = new Date('2026-10-06T10:00:00.000Z');
const T1 = new Date('2026-10-06T11:00:00.000Z');

function row(overrides: Partial<MailOutboxStatusRow>): MailOutboxStatusRow {
  return {
    purpose: 'invoice-sent',
    kind: 'DIRECT',
    status: 'PROVIDER_ACCEPTED',
    recipientsAttempted: 1,
    recipientsAccepted: 1,
    createdAt: T0,
    ...overrides,
  };
}

describe('summarizeMailDelivery', () => {
  it('fasst Einzelmails eines Vorgangs an mehrere Adressen zusammen', () => {
    expect(summarizeMailDelivery([row({}), row({ createdAt: T1 })])).toEqual([
      { purpose: 'invoice-sent', state: 'accepted', accepted: 2, attempted: 2 },
    ]);
    expect(
      summarizeMailDelivery([row({}), row({ status: 'FAILED', recipientsAccepted: 0 })]),
    ).toEqual([{ purpose: 'invoice-sent', state: 'partial', accepted: 1, attempted: 2 }]);
  });

  it('zeigt wartende Aufträge vor jedem Endzustand und zählt unbekannte Empfänger als einen', () => {
    expect(
      summarizeMailDelivery([
        row({ status: 'QUEUED', recipientsAttempted: null, recipientsAccepted: null }),
        row({ status: 'FAILED', recipientsAccepted: 0 }),
      ]),
    ).toEqual([{ purpose: 'invoice-sent', state: 'pending', accepted: 0, attempted: 2 }]);
    expect(
      summarizeMailDelivery([row({ status: 'RETRY_PENDING', recipientsAccepted: 0 })]),
    ).toEqual([{ purpose: 'invoice-sent', state: 'retrying', accepted: 0, attempted: 1 }]);
  });

  it('wertet bei Kontaktmails nur den jüngsten Auftrag je Anlass', () => {
    const replies = [
      row({
        purpose: 'request-staff-replied',
        kind: 'CLIENT_CONTACTS',
        status: 'FAILED',
        recipientsAttempted: 2,
        recipientsAccepted: 0,
        createdAt: T0,
      }),
      row({
        purpose: 'request-staff-replied',
        kind: 'CLIENT_CONTACTS',
        status: 'PROVIDER_ACCEPTED',
        recipientsAttempted: 2,
        recipientsAccepted: 2,
        createdAt: T1,
      }),
      row({
        purpose: 'request-opened',
        kind: 'CLIENT_CONTACTS',
        status: 'NO_RECIPIENT',
        recipientsAttempted: 0,
        recipientsAccepted: 0,
      }),
    ];
    expect(summarizeMailDelivery(replies)).toEqual([
      { purpose: 'request-staff-replied', state: 'accepted', accepted: 2, attempted: 2 },
      { purpose: 'request-opened', state: 'no-recipient', accepted: 0, attempted: 0 },
    ]);
  });

  it('zeigt verworfene Aufträge nur, wenn der ganze Anlass verworfen wurde', () => {
    const skipped = row({
      status: 'SKIPPED',
      recipientsAttempted: null,
      recipientsAccepted: null,
      lastError: 'Nicht versendet: Die GwG-Einladung wurde zurückgezogen.',
    });
    expect(summarizeMailDelivery([skipped])).toEqual([
      {
        purpose: 'invoice-sent',
        state: 'skipped',
        accepted: 0,
        attempted: 0,
        skippedReason: 'Die GwG-Einladung wurde zurückgezogen.',
      },
    ]);
    // Neben einer angenommenen Einzelmail zählt der verworfene Auftrag nicht mit.
    expect(summarizeMailDelivery([row({}), skipped])).toEqual([
      { purpose: 'invoice-sent', state: 'accepted', accepted: 1, attempted: 1 },
    ]);
    // Bei Kontaktmails entscheidet weiterhin der jüngste Auftrag.
    expect(
      summarizeMailDelivery([
        row({ kind: 'CLIENT_CONTACTS', purpose: 'request-opened', createdAt: T0 }),
        { ...skipped, kind: 'CLIENT_CONTACTS', purpose: 'request-opened', createdAt: T1 },
      ])[0]?.state,
    ).toBe('skipped');
    expect(MAIL_DELIVERY_STATE_LABELS.skipped).toBe('nicht versendet – Vorgang nicht mehr aktuell');
  });

  it('meldet unklare und gescheiterte Zustellung deutlich', () => {
    expect(
      summarizeMailDelivery([row({ status: 'UNKNOWN', recipientsAccepted: 0 })])[0]?.state,
    ).toBe('unknown');
    expect(
      summarizeMailDelivery([row({ status: 'FAILED', recipientsAccepted: 0 })])[0]?.state,
    ).toBe('failed');
    expect(MAIL_DELIVERY_STATE_LABELS.failed).toContain('fehlgeschlagen');
    expect(MAIL_DELIVERY_STATE_LABELS.accepted).toBe('vom Versanddienst angenommen');
  });

  it('C4: bietet erneut sendbare Aufträge nur mit Vorgang und erhaltenem Inhalt an', () => {
    const resource = { resourceType: 'invoice', resourceId: 'invoice-1' };
    const accepted = row({ id: 'outbox-1' });
    const failed = row({
      id: 'outbox-2',
      status: 'FAILED',
      recipientsAccepted: 0,
      resendable: true,
    });
    const cleared = row({ id: 'outbox-3', status: 'FAILED', recipientsAccepted: 0 });

    expect(summarizeMailDelivery([accepted, failed, cleared], resource)).toEqual([
      {
        purpose: 'invoice-sent',
        state: 'partial',
        accepted: 1,
        attempted: 3,
        resend: {
          purpose: 'invoice-sent',
          resourceType: 'invoice',
          resourceId: 'invoice-1',
          outboxIds: ['outbox-2'],
          uncertain: false,
        },
      },
    ]);
    // Ohne Vorgang (reine Anzeige) kein Ziel.
    expect(summarizeMailDelivery([failed])[0]).not.toHaveProperty('resend');
    expect(
      summarizeMailDelivery(
        [row({ id: 'outbox-4', status: 'UNKNOWN', recipientsAccepted: 0, resendable: true })],
        resource,
      )[0]?.resend,
    ).toEqual({
      purpose: 'invoice-sent',
      resourceType: 'invoice',
      resourceId: 'invoice-1',
      outboxIds: ['outbox-4'],
      uncertain: true,
    });
  });

  it('C4: bietet bei Kontaktmails nur den jüngsten Auftrag zum Neuversand an', () => {
    const contacts = (overrides: Partial<MailOutboxStatusRow>) =>
      row({ purpose: 'request-staff-replied', kind: 'CLIENT_CONTACTS', ...overrides });
    const summaries = summarizeMailDelivery(
      [
        contacts({ id: 'old', status: 'FAILED', resendable: true, createdAt: T0 }),
        contacts({ id: 'new', status: 'PROVIDER_ACCEPTED', createdAt: T1 }),
      ],
      { resourceType: 'request', resourceId: 'request-1' },
    );

    expect(summaries[0]?.state).toBe('accepted');
    expect(summaries[0]).not.toHaveProperty('resend');
  });
});
