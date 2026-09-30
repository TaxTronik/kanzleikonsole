import { describe, expect, it } from 'vitest';
import nodemailer, { createTransport, type Transporter } from 'nodemailer';
import { simpleParser } from 'mailparser';

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
});
