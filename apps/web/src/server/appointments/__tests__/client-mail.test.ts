// Fachkatalog: MAIL-OUTBOX-001
// Welle 15: Empfänger der Mandanten-Mail bei Terminänderung oder -absage nach
// der Regel der Entscheidungsmail (aktiv, Benachrichtigungen an), Gründe für
// eine deaktivierte Checkbox und Gleichlauf von Ersatztext und System-Vorlage.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/mail/outbox', () => ({ enqueueDirectMailTx: vi.fn() }));

import {
  APPOINTMENT_MAIL_FALLBACK,
  APPOINTMENT_MAIL_UNAVAILABLE,
  appointmentMailRecipients,
  loadAppointmentMailOptionsTx,
  type AppointmentRecipientSource,
} from '../client-mail';

function contact(overrides: Record<string, unknown> = {}) {
  return {
    id: 'contact-1',
    fullName: 'Erika Muster',
    email: 'erika@example.test',
    active: true,
    notificationsEnabled: true,
    ...overrides,
  };
}

function source(overrides: Partial<AppointmentRecipientSource> = {}): AppointmentRecipientSource {
  return {
    clientId: 'client-1',
    clientAnonymized: false,
    fromRequest: false,
    requestContact: null,
    clientContacts: [contact()],
    ...overrides,
  };
}

const ERIKA = { contactId: 'contact-1', fullName: 'Erika Muster', email: 'erika@example.test' };

describe('appointmentMailRecipients', () => {
  it('nimmt bei Terminen aus einer Anfrage nur den anfragenden Kontakt', () => {
    expect(
      appointmentMailRecipients(
        source({
          fromRequest: true,
          requestContact: contact(),
          clientContacts: [contact(), contact({ id: 'contact-2', email: 'b@example.test' })],
        }),
      ),
    ).toEqual({ recipients: [ERIKA], unavailableReason: null });
  });

  it.each([
    ['inaktiv', contact({ active: false })],
    ['ohne Benachrichtigungen', contact({ notificationsEnabled: false })],
    ['nicht mehr vorhanden', null],
  ])('sendet nicht, wenn der anfragende Kontakt %s ist', (_case, requestContact) => {
    expect(appointmentMailRecipients(source({ fromRequest: true, requestContact }))).toEqual({
      recipients: [],
      unavailableReason: APPOINTMENT_MAIL_UNAVAILABLE.requestContact,
    });
  });

  it('nimmt sonst jeden aktiven Kontakt mit Benachrichtigungen', () => {
    expect(
      appointmentMailRecipients(
        source({
          clientContacts: [
            contact(),
            contact({ id: 'off', notificationsEnabled: false }),
            contact({ id: 'inactive', active: false }),
            contact({ id: 'blank', email: '  ' }),
          ],
        }),
      ),
    ).toEqual({ recipients: [ERIKA], unavailableReason: null });
    expect(appointmentMailRecipients(source({ clientContacts: [] }))).toEqual({
      recipients: [],
      unavailableReason: APPOINTMENT_MAIL_UNAVAILABLE.noContact,
    });
  });

  it('bietet ohne Mandantenbezug und bei anonymisiertem Mandanten keine Mail an', () => {
    expect(appointmentMailRecipients(source({ clientId: null }))).toEqual({
      recipients: [],
      unavailableReason: APPOINTMENT_MAIL_UNAVAILABLE.noClient,
    });
    expect(appointmentMailRecipients(source({ clientAnonymized: true }))).toEqual({
      recipients: [],
      unavailableReason: APPOINTMENT_MAIL_UNAVAILABLE.anonymized,
    });
  });
});

describe('loadAppointmentMailOptionsTx', () => {
  it('ordnet Kontakte und Anfragen den Terminen zu, ein umgehängter Termin informiert den neuen Mandanten', async () => {
    const tx = {
      client: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'client-1', anonymizedAt: null },
          { id: 'client-2', anonymizedAt: null },
        ]),
      },
      clientContact: {
        findMany: vi.fn().mockResolvedValue([
          { ...contact(), clientId: 'client-1' },
          {
            ...contact({ id: 'contact-2', fullName: 'Max', email: 'max@example.test' }),
            clientId: 'client-2',
          },
        ]),
      },
      appointmentRequest: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: 'request-1', clientId: 'client-1', createdByContactRel: contact() },
          ]),
      },
    };

    const options = await loadAppointmentMailOptionsTx(tx as never, [
      { id: 'a-request', clientId: 'client-1', fromRequestId: 'request-1' },
      { id: 'a-moved', clientId: 'client-2', fromRequestId: 'request-1' },
      { id: 'a-internal', clientId: null, fromRequestId: null },
    ]);

    expect(options.get('a-request')).toEqual({ recipients: [ERIKA], unavailableReason: null });
    expect(options.get('a-moved')).toEqual({
      recipients: [{ contactId: 'contact-2', fullName: 'Max', email: 'max@example.test' }],
      unavailableReason: null,
    });
    expect(options.get('a-internal')?.unavailableReason).toBe(
      APPOINTMENT_MAIL_UNAVAILABLE.noClient,
    );
    expect(tx.clientContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { clientId: { in: ['client-1', 'client-2'] } } }),
    );
  });
});

describe('System-Vorlagen der Terminmitteilungen', () => {
  const migration = readFileSync(
    new URL(
      '../../../../../../packages/db/prisma/migrations/20261012110100_appointment_change_mail_templates/migration.sql',
      import.meta.url,
    ),
    'utf8',
  );

  it.each(Object.entries(APPOINTMENT_MAIL_FALLBACK))(
    'seedet für %s denselben Text wie den Ersatztext',
    (slug, fallback) => {
      expect(migration).toContain(`('${slug}',`);
      expect(migration).toContain(`'${fallback.subject}'`);
      expect(migration).toContain(`E'${fallback.bodyMd.replace(/\n/g, '\\n')}'`);
      // Keine internen Notizen in der Vorlage.
      expect(fallback.bodyMd).not.toContain('notes');
    },
  );
});
