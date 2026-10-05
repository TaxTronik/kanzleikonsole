// Fachkatalog: MAIL-INBOX-001
import { describe, it, expect, vi } from 'vitest';
import type { TxClient } from '@taxtronik/db';
import { inboundAddresses, suggestInboundClientsTx } from '../suggestions';

const ACCESS_WHERE = { OR: [{ vertraulich: false }, { responsibilities: { some: {} } }] };

type ContactRow = { email: string; client: { id: string; name: string } };

/** Simuliert die DB-Zuordnung (citext = ohne Groß-/Kleinschreibung) über einen Kontaktbestand. */
function fakeTx(contacts: ContactRow[]) {
  const findMany = vi.fn(async ({ where }: { where: { email: { in: string[] } } }) =>
    contacts.filter((c) => where.email.in.includes(c.email.toLowerCase())),
  );
  return { tx: { clientContact: { findMany } } as unknown as TxClient, findMany };
}

describe('untrusted mailbox suggestions', () => {
  it('erkennt exakte Absender- und Empfängeradressen, ohne Anzeigenamen oder Domainteile', () => {
    expect(inboundAddresses('Client <CLIENT@example.test>', 'alias@example.test')).toEqual([
      'client@example.test',
      'alias@example.test',
    ]);
    expect(inboundAddresses('client@example.test.evil', 'Client')).toEqual([
      'client@example.test.evil',
    ]);
  });

  it('ordnet per Datenbankabfrage je Nachricht zu, ohne selbst einen Mandanten zu wählen', async () => {
    const { tx, findMany } = fakeTx([
      { email: 'Client@Example.test', client: { id: 'one', name: 'One' } },
      { email: 'alias@example.test', client: { id: 'two', name: 'Two' } },
      { email: 'client@example.test', client: { id: 'one', name: 'One' } },
    ]);
    const result = await suggestInboundClientsTx(
      tx,
      { tenantId: 't-1', accessWhere: ACCESS_WHERE },
      [
        { id: 'm1', sender: 'Client <CLIENT@example.test>', recipients: 'alias@example.test' },
        { id: 'm2', sender: 'client@example.test.evil', recipients: 'Client' },
      ],
    );
    expect(result.get('m1')).toEqual([
      { id: 'one', name: 'One' },
      { id: 'two', name: 'Two' },
    ]);
    expect(result.get('m2')).toEqual([]);
    // Eine Abfrage für alle Nachrichten der Seite, nicht je Nachricht.
    expect(findMany).toHaveBeenCalledOnce();
  });

  it('fragt nur aktive Kontakte zugänglicher, aktiver Mandate im Tenant ab', async () => {
    const { tx, findMany } = fakeTx([]);
    await suggestInboundClientsTx(tx, { tenantId: 't-1', accessWhere: ACCESS_WHERE }, [
      { id: 'm1', sender: 'a@example.test', recipients: '' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        active: true,
        email: { in: ['a@example.test'] },
        client: {
          AND: [
            ACCESS_WHERE,
            { tenantId: 't-1', allowActive: true, anonymizedAt: null, mandateEndedAt: null },
          ],
        },
      },
      select: { email: true, client: { select: { id: true, name: true } } },
    });
  });

  it('never suggests an inaccessible client absent from the scoped query result', async () => {
    // Die Datenbank liefert unter der Zugriffsregel nur „two" — „one" fehlt.
    const { tx } = fakeTx([{ email: 'alias@example.test', client: { id: 'two', name: 'Two' } }]);
    const result = await suggestInboundClientsTx(
      tx,
      { tenantId: 't-1', accessWhere: ACCESS_WHERE },
      [{ id: 'm1', sender: 'client@example.test', recipients: 'alias@example.test' }],
    );
    expect(result.get('m1')).toEqual([{ id: 'two', name: 'Two' }]);
  });

  it('stellt ohne Adressen keine Abfrage und teilt sehr lange Listen auf', async () => {
    const empty = fakeTx([]);
    const none = await suggestInboundClientsTx(empty.tx, { tenantId: 't', accessWhere: {} }, [
      { id: 'm1', sender: 'Unbekannt', recipients: '' },
    ]);
    expect(none.get('m1')).toEqual([]);
    expect(empty.findMany).not.toHaveBeenCalled();

    const many = fakeTx([]);
    const recipients = Array.from({ length: 1001 }, (_, i) => `r${i}@example.test`).join(', ');
    await suggestInboundClientsTx(many.tx, { tenantId: 't', accessWhere: {} }, [
      { id: 'm1', sender: '', recipients },
    ]);
    expect(many.findMany).toHaveBeenCalledTimes(3);
  });
});
