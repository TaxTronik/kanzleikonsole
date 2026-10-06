// F-08: Vertrag der Mail-Outbox zwischen Web-App (Enqueue im fachlichen Commit)
// und Worker (Zustellung). Ein Auftrag muss exakt die bisherigen Versandoptionen
// zurückliefern; geheime Variablen liegen nur Secret-Box-gebunden im Auftrag.
import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import {
  enqueueClientContactsMailTx,
  enqueueDirectMailTx,
  mailOutboxDispatch,
  MailOutboxPayloadError,
  openMailOutboxSecretVars,
  parseMailOutboxPayload,
  type MailOutboxTarget,
} from '../outbox';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const INVOICE = '33333333-3333-4333-8333-333333333333';
const VERSION = '44444444-4444-4444-8444-444444444444';

const target: MailOutboxTarget = {
  tenantId: TENANT,
  clientId: CLIENT,
  purpose: 'invoice-external',
  resource: { type: 'invoice', id: INVOICE },
  staffHref: `/staff/invoices/${INVOICE}`,
};

type Created = Record<string, unknown> & {
  id: string;
  tenantId: string;
  clientId: string;
  kind: 'DIRECT' | 'CLIENT_CONTACTS';
  payload: unknown;
  secretVarsEnc: string | null;
};

function writer() {
  const rows: Created[] = [];
  const tx = {
    mailOutbox: {
      create: async ({ data }: { data: Created }) => {
        rows.push({ ...data, secretVarsEnc: data.secretVarsEnc ?? null });
        return data;
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, rows };
}

function roundTrip(row: Created) {
  return mailOutboxDispatch(
    row,
    parseMailOutboxPayload(JSON.parse(JSON.stringify(row.payload))),
    openMailOutboxSecretVars(row),
    [],
  );
}

describe('Mail-Outbox-Vertrag', () => {
  it('liefert die Optionen einer Einzelmail unverändert zurück, ergänzt um den n8n-Dedupe-Schlüssel', async () => {
    const { tx, rows } = writer();
    const id = await enqueueDirectMailTx(tx, target, {
      slug: 'invoice-sent',
      to: 'buchhaltung@example.test',
      vars: {
        contact: { fullName: 'Rey Koxha', email: 'buchhaltung@example.test' },
        invoice: { number: 'RE-1', totalAmount: 119.5, subject: undefined },
        flags: [true, null],
      },
      n8nEvent: 'invoice.due',
      n8nPayload: { tenantId: TENANT, invoiceId: INVOICE },
      fallback: { subject: 'Ihre Rechnung {{invoice.number}}', bodyMd: 'Anbei.' },
      attachments: [{ documentVersionId: VERSION, filename: 'Rechnung-RE-1.pdf' }],
    });

    expect(rows[0]).toMatchObject({
      id,
      kind: 'DIRECT',
      purpose: 'invoice-external',
      resourceType: 'invoice',
      resourceId: INVOICE,
      staffHref: `/staff/invoices/${INVOICE}`,
      secretVarsEnc: null,
    });
    const dispatch = roundTrip(rows[0]!);
    expect(dispatch).toEqual({
      kind: 'DIRECT',
      options: {
        tenantId: TENANT,
        clientId: CLIENT,
        slug: 'invoice-sent',
        to: 'buchhaltung@example.test',
        vars: {
          contact: { fullName: 'Rey Koxha', email: 'buchhaltung@example.test' },
          invoice: { number: 'RE-1', totalAmount: 119.5 },
          flags: [true, null],
        },
        fallback: { subject: 'Ihre Rechnung {{invoice.number}}', bodyMd: 'Anbei.' },
        n8nEvent: 'invoice.due',
        n8nPayload: { tenantId: TENANT, invoiceId: INVOICE },
        n8nDedupeKey: `mail-outbox:${id}`,
      },
    });
    expect(parseMailOutboxPayload(rows[0]!.payload).attachments).toEqual([
      { documentVersionId: VERSION, filename: 'Rechnung-RE-1.pdf' },
    ]);
  });

  it('bindet geheime Variablen an Tenant und Auftrag', async () => {
    const { tx, rows } = writer();
    await enqueueDirectMailTx(tx, target, {
      slug: 'gwg-onboarding',
      to: 'max@example.test',
      vars: { inviteName: 'Max' },
      secretVars: { link: 'https://portal.example.test/gwg-onboarding?token=t0k3n' },
    });
    const row = rows[0]!;
    expect(JSON.stringify(row)).not.toContain('t0k3n');
    expect(openMailOutboxSecretVars(row)).toEqual({
      link: 'https://portal.example.test/gwg-onboarding?token=t0k3n',
    });
    expect(roundTrip(row).options.vars).toEqual({
      inviteName: 'Max',
      link: 'https://portal.example.test/gwg-onboarding?token=t0k3n',
    });

    // In einen anderen Auftrag kopiert, ist der Wert nicht lesbar.
    expect(() =>
      openMailOutboxSecretVars({ ...row, id: '55555555-5555-4555-8555-555555555555' }),
    ).toThrow(MailOutboxPayloadError);
  });

  it('löst Kontaktmails ohne Einzeladresse und ohne Anhang auf', async () => {
    const { tx, rows } = writer();
    const id = await enqueueClientContactsMailTx(
      tx,
      { ...target, purpose: 'request-opened', resource: { type: 'request', id: INVOICE } },
      {
        slug: 'gwg-activated',
        vars: { portalUrl: 'https://portal.example.test/portal/dashboard' },
      },
    );
    expect(roundTrip(rows[0]!)).toEqual({
      kind: 'CLIENT_CONTACTS',
      options: {
        tenantId: TENANT,
        clientId: CLIENT,
        slug: 'gwg-activated',
        vars: { portalUrl: 'https://portal.example.test/portal/dashboard' },
      },
    });
    expect(id).toBe(rows[0]!.id);

    const tampered = parseMailOutboxPayload({ ...(rows[0]!.payload as object), to: 'x@y.test' });
    expect(() => mailOutboxDispatch(rows[0]!, tampered, {}, [])).toThrow(MailOutboxPayloadError);
  });

  it('weist Werte ab, die nach dem Speichern anders gerendert würden', async () => {
    const { tx } = writer();
    await expect(
      enqueueDirectMailTx(tx, target, {
        slug: 'x',
        to: 'a@example.test',
        vars: { faellig: new Date('2026-10-06T00:00:00Z') },
      }),
    ).rejects.toThrow(/vars.faellig/);
    await expect(
      enqueueDirectMailTx(tx, target, { slug: 'x', to: 'a@example.test', vars: { n: Number.NaN } }),
    ).rejects.toThrow(/nicht endlich/);
  });

  it('weist ungültige Ziele, kollidierende Geheimnisse und fremde n8n-Ereignisse ab', async () => {
    const { tx } = writer();
    const mail = { slug: 'x', to: 'a@example.test', vars: { link: 'offen' } };
    await expect(
      enqueueDirectMailTx(tx, { ...target, resource: { type: 'invoice', id: 'kein-uuid' } }, mail),
    ).rejects.toThrow(/UUID/);
    await expect(
      enqueueDirectMailTx(tx, { ...target, staffHref: 'https://evil.example' }, mail),
    ).rejects.toThrow(/staff/);
    await expect(
      enqueueDirectMailTx(tx, target, { ...mail, secretVars: { link: 'geheim' } }),
    ).rejects.toThrow(/kollidiert/);
    await expect(
      enqueueDirectMailTx(tx, target, {
        ...mail,
        n8nEvent: 'nicht.freigegeben' as never,
      }),
    ).rejects.toThrow(/nicht freigegeben/);
  });

  it('lehnt einen geleerten oder fremden Payload ab', () => {
    expect(() => parseMailOutboxPayload({})).toThrow(MailOutboxPayloadError);
    expect(() => parseMailOutboxPayload({ v: 1, slug: 'x', vars: [] })).toThrow(
      MailOutboxPayloadError,
    );
    expect(() =>
      parseMailOutboxPayload({
        v: 1,
        slug: 'x',
        vars: {},
        attachments: [{ documentVersionId: 'x', filename: 'a.pdf' }],
      }),
    ).toThrow(/Anhangsverweis/);
  });
});
