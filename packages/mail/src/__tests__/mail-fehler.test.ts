// Fachkatalog: MAIL-OUTBOX-001
//
// RT3B-K-03: Versandfehler erscheinen in Log und Persistenz nur als
// Fehlerklasse, Code und SMTP-Antwortcode – nie mit dem Text des Providers,
// der den Inhalt der Mail (Code, Link, Adresse) zurückgeben kann.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  sendMail: vi.fn(),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock('../send', () => ({ sendMail: m.sendMail }));
vi.mock('../n8n-emitter', () => ({
  emitViaConfiguredN8n: vi.fn(),
  assertN8nEmitterRegistered: vi.fn(),
}));
vi.mock('../dispatch-settings', () => ({
  readMailDispatch: vi.fn().mockResolvedValue({ mode: 'APP' }),
}));
vi.mock('@taxtronik/db', () => ({
  withSystemContext: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({
      emailTemplate: {
        findFirst: vi.fn().mockResolvedValue({
          subject: 'Bestätigungscode',
          bodyMd: 'Ihr Code lautet {{code}}.',
        }),
      },
      clientContact: { findMany: vi.fn().mockResolvedValue([]) },
      client: { findFirst: vi.fn().mockResolvedValue(null) },
    }),
}));
vi.mock('../logger', () => ({ mailLog: () => m.log }));

import { sendTemplateMail } from '../dispatch';
import { mailFehlerFelder, mailFehlerVermerk } from '../mail-fehler';

const CODE = '739154';
const ADRESSE = 'jana@talwind.example';

/** Fehler, wie ihn Nodemailer für eine ausdrückliche Ablehnung liefert. */
function providerFehler() {
  return Object.assign(
    new Error(
      `Message failed: 550 5.7.1 <${ADRESSE}>: content rejected: "Ihr Code lautet ${CODE}"`,
    ),
    {
      code: 'EMESSAGE',
      responseCode: 550,
      response: `550 5.7.1 <${ADRESSE}> Ihr Code lautet ${CODE}`,
      command: 'DATA',
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Versandfehler ohne Text des Providers (RT3B-K-03)', () => {
  it('übernimmt nur Klasse, Code und SMTP-Antwortcode', () => {
    expect(mailFehlerFelder(providerFehler())).toEqual({
      errName: 'Error',
      code: 'EMESSAGE',
      responseCode: 550,
    });
    expect(mailFehlerVermerk(providerFehler())).toBe(
      'Versand gescheitert (Error, EMESSAGE, SMTP 550).',
    );
  });

  it('verwirft Werte außerhalb ihrer erwarteten Form', () => {
    const fremd = Object.assign(new Error('x'), {
      name: `Fehler ${CODE} <${ADRESSE}>`,
      code: `E ${ADRESSE}`,
      responseCode: 5501,
    });
    expect(mailFehlerFelder(fremd)).toEqual({ errName: 'Error', code: null, responseCode: null });
    expect(mailFehlerFelder(`Text ${CODE}`)).toEqual({
      errName: 'string',
      code: null,
      responseCode: null,
    });
    expect(mailFehlerFelder({ code: 'ECONNECTION', responseCode: 421.5 })).toEqual({
      errName: 'Objekt',
      code: 'ECONNECTION',
      responseCode: null,
    });
    expect(mailFehlerVermerk(null)).toBe('Versand gescheitert (object).');
  });

  it('sendTemplateMail protokolliert eine Ablehnung ohne Text, Code oder Adresse und bleibt eindeutig abgelehnt', async () => {
    m.sendMail.mockRejectedValueOnce(providerFehler());

    const ergebnis = await sendTemplateMail({
      tenantId: 'tenant-1',
      slug: 'tcms-code',
      to: ADRESSE,
      subjectSuffix: '',
      vars: { code: CODE },
    });

    expect(ergebnis).toEqual({ ok: false, sentViaTemplate: true, uncertainFailure: false });
    expect(m.log.error).toHaveBeenCalledWith(
      { slug: 'tcms-code', errName: 'Error', code: 'EMESSAGE', responseCode: 550 },
      'mail: template send failed',
    );
    const protokoll = JSON.stringify([m.log.error.mock.calls, m.log.warn.mock.calls]);
    expect(protokoll).not.toContain(CODE);
    expect(protokoll).not.toContain(ADRESSE);
  });
});
