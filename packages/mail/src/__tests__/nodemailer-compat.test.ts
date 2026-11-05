import { describe, expect, it } from 'vitest';
import nodemailer, { createTransport, type Transporter } from 'nodemailer';
import { simpleParser, type EmailAddress } from 'mailparser';

const addressesOf = (entries: EmailAddress[] = []): Array<string | undefined> =>
  entries.flatMap((entry) => (entry.group ? addressesOf(entry.group) : [entry.address]));

describe('Nodemailer and mailparser runtime compatibility', () => {
  it('round-trips MIME text, HTML, addresses and attachment bytes without SMTP', async () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    // Production code stores SMTP transports behind the plain Transporter type.
    const closeable: Transporter = transport;
    const attachment = Buffer.from([0x00, 0x01, 0x7f, 0x80, 0xff]);

    try {
      const result = await transport.sendMail({
        from: { name: 'Kanzlei Müller', address: 'kanzlei@example.test' },
        to: { name: 'Erika Muster', address: 'erika@example.test' },
        replyTo: 'antwort@example.test',
        subject: 'Unterlagen für die Prüfung',
        text: 'Bitte prüfen Sie die Unterlagen.',
        html: '<p>Bitte prüfen Sie die <strong>Unterlagen</strong>.</p>',
        attachments: [{ filename: 'prüfdaten.bin', content: attachment }],
      });

      expect(Buffer.isBuffer(result.message)).toBe(true);
      const parsed = await simpleParser(result.message);
      expect(result.envelope).toEqual({
        from: 'kanzlei@example.test',
        to: ['erika@example.test'],
      });
      expect(parsed.from?.value).toEqual([
        { name: 'Kanzlei Müller', address: 'kanzlei@example.test' },
      ]);
      expect(parsed.to).toMatchObject({
        value: [{ name: 'Erika Muster', address: 'erika@example.test' }],
      });
      expect(parsed.replyTo?.value[0]?.address).toBe('antwort@example.test');
      expect(parsed.subject).toBe('Unterlagen für die Prüfung');
      expect(parsed.text?.trim()).toBe('Bitte prüfen Sie die Unterlagen.');
      expect(parsed.html).toBe('<p>Bitte prüfen Sie die <strong>Unterlagen</strong>.</p>');
      expect(parsed.attachments).toHaveLength(1);
      expect(parsed.attachments[0]?.filename).toBe('prüfdaten.bin');
      expect(parsed.attachments[0]?.content).toEqual(attachment);
    } finally {
      closeable.close();
    }
  });

  it('keeps comment suffixes out of quoted recipient addresses (GHSA-g57g-f23g-4646)', async () => {
    const transport = createTransport({ streamTransport: true, buffer: true });
    try {
      const result = await transport.sendMail({
        from: 'kanzlei@example.test',
        to: '"erika"@example.test(comment)unexpected.test',
        subject: 'Recipient parsing regression',
        text: 'Local MIME generation only.',
      });
      expect(result.envelope.to).toEqual(['erika@example.test']);

      // mailparser loads Nodemailer's addressparser through CommonJS. Exercise
      // that transitive copy with the original header, before MIME normalizes it.
      const parsed = await simpleParser(
        'From: kanzlei@example.test\r\n' +
          'To: "erika"@example.test(comment)unexpected.test\r\n' +
          'Subject: Recipient parsing regression\r\n\r\nLocal fixture.',
      );
      expect(parsed.to).toMatchObject({ value: [{ address: 'erika@example.test' }] });
    } finally {
      transport.close();
    }
  });

  // Dependency Audit 4230: Diese Schreibweisen nennen nach RFC 5322 nur den
  // Empfänger bei victim.example; der Text davor ist Kommentar oder Anzeigename.
  // Ausgehend wäre sonst an evil.example zugestellt worden, eingehend hätte
  // Mailparser dort einen anderen Absender gemeldet als ein konformer Parser.
  it.each([
    ['GHSA-8c8m-p3m8-cjg8', 'Victim (x(y) <evil@evil.example>) <v@victim.example>'],
    ['GHSA-m943-m63m-w62w', 'G: (a; <evil@evil.example>) <v@victim.example>;'],
    ['GHSA-m943-m63m-w62w', 'G: "a;" "<evil@evil.example>" <v@victim.example>;'],
  ])('does not read a recipient out of comments or display text (%s): %s', async (_id, address) => {
    const transport = createTransport({ streamTransport: true, buffer: true });
    try {
      const result = await transport.sendMail({
        from: 'kanzlei@example.test',
        to: address,
        subject: 'Recipient parsing regression',
        text: 'Local MIME generation only.',
      });
      expect(result.envelope.to).toEqual(['v@victim.example']);

      const parsed = await simpleParser(
        `From: ${address}\r\nTo: kanzlei@example.test\r\nSubject: Sender regression\r\n\r\nFixture.`,
      );
      // Der Kommentartext darf im Anzeigenamen stehen, nur nicht als Adresse.
      expect(addressesOf(parsed.from?.value)).toEqual(['v@victim.example']);
    } finally {
      transport.close();
    }
  });

  it('keeps the domain of a quoted local part holding ">" (GHSA-85x2-q946-cp5h)', async () => {
    const transport = createTransport({ streamTransport: true, buffer: true });
    try {
      const result = await transport.sendMail({
        from: 'kanzlei@example.test',
        to: '<"a@evil.example>"@good.example>',
        subject: 'Recipient parsing regression',
        text: 'Local MIME generation only.',
      });
      expect(result.envelope.to).toHaveLength(1);
      expect(result.envelope.to[0]).toMatch(/@good\.example$/);
    } finally {
      transport.close();
    }
  });

  it('strips a comment inside an angle-addr (GHSA-g73g-hqqh-jr95)', async () => {
    const transport = createTransport({ streamTransport: true, buffer: true });
    try {
      const result = await transport.sendMail({
        from: 'kanzlei@example.test',
        to: 'Legit User <user@good.example(x)>',
        subject: 'Recipient parsing regression',
        text: 'Local MIME generation only.',
      });
      expect(result.envelope.to).toEqual(['user@good.example']);
    } finally {
      transport.close();
    }
  });
});
