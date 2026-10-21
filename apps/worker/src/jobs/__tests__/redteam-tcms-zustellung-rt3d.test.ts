// =============================================================================
// Angriffsdurchlauf RT3D (kk-tcms-s11 Punkt 2): Zustell-Zustandsmaschine der
// Tax-CMS-Mitteilungen. Reine Abbildung (keine DB): „zugestellt“ darf nie ohne
// Annahme durch den Mailserver gemeldet werden, der gueltigBis-Fensterschluss
// ist fail closed, und ein Drift-Status endet als unklar, nicht als zugestellt.
//
// Der Ablauf samt Zeilensperre, Rückwärts-Sperre (where status=EINGEPLANT) und
// 5xx-Wiederholung ist in tcms-nachrichten-db.test.ts / tcms-zustellung-e2e-db
// belegt; dieses File fixiert die sicherheitskritischen Invarianten der reinen
// Funktionen und dokumentiert die bewusst in Kauf genommenen Lücken (offener
// Punkt 3: UNKNOWN/PARTIAL_FAILURE werden als unzustellbar gemeldet, obwohl die
// Mail angekommen sein kann).
//
// Fachkatalog: MAIL-OUTBOX-001
// =============================================================================
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../notify', () => ({ notify: vi.fn() }));
vi.mock('../../notification-recipients', () => ({ resolveClientWarningRecipientsTx: vi.fn() }));
vi.mock('../../tcms/systemakteur', () => ({ beanspruche: vi.fn() }));
vi.mock('@taxtronik/db/staff-client-access', () => ({ canStaffAccessClientTx: vi.fn() }));
vi.mock('@taxtronik/mail/outbox', async (original) => ({
  ...(await original<typeof import('@taxtronik/mail/outbox')>()),
  enqueueDirectMailTx: vi.fn(),
}));

import type { MailOutboxStatus } from '@prisma/client';
import type { OffeneNachricht } from '@taxtronik/tcms-client';
import { auftragsAbschluss, gueltigBis, meldungAus } from '../tcms-nachrichten';

const ALLE_STATUS: MailOutboxStatus[] = [
  'QUEUED',
  'SENDING',
  'RETRY_PENDING',
  'PROVIDER_ACCEPTED',
  'FAILED',
  'NO_RECIPIENT',
  'PARTIAL_FAILURE',
  'UNKNOWN',
  'SKIPPED',
];

describe('RT3D: Zustell-Zustandsmaschine', () => {
  it('„zugestellt“ (ANGENOMMEN) nur bei PROVIDER_ACCEPTED – jeder andere Endstatus ist gescheitert', () => {
    for (const status of ALLE_STATUS) {
      const a = auftragsAbschluss({ status, lastError: null });
      if (status === 'PROVIDER_ACCEPTED') {
        expect(a).toEqual({ status: 'ANGENOMMEN', grund: null });
      } else if (['QUEUED', 'SENDING', 'RETRY_PENDING'].includes(status)) {
        // Versand läuft noch: offen, nichts gemeldet.
        expect(a).toBeNull();
      } else {
        expect(a?.status, status).toBe('GESCHEITERT');
      }
    }
  });

  it('ein fehlender Versandauftrag ist gescheitert (fail closed), nie zugestellt', () => {
    expect(auftragsAbschluss(null)).toEqual({ status: 'GESCHEITERT', grund: 'AUFTRAG_FEHLT' });
  });

  it('ein unbekannter (Drift-)Status endet als unklar, nicht als zugestellt', () => {
    const a = auftragsAbschluss({ status: 'ERFUNDEN' as MailOutboxStatus, lastError: null });
    expect(a).toEqual({ status: 'GESCHEITERT', grund: 'VERSAND_UNKLAR' });
  });

  it('nur ANGENOMMEN meldet ZUGESTELLT; GESCHEITERT/UNZUSTELLBAR melden UNZUSTELLBAR; offen meldet nichts', () => {
    expect(meldungAus({ status: 'ANGENOMMEN', grund: null })).toEqual({ art: 'ZUGESTELLT' });
    expect(meldungAus({ status: 'GESCHEITERT', grund: 'VERSAND_GESCHEITERT' })).toMatchObject({
      art: 'UNZUSTELLBAR',
    });
    expect(meldungAus({ status: 'UNZUSTELLBAR', grund: 'ABGELAUFEN' })).toMatchObject({
      art: 'UNZUSTELLBAR',
    });
    expect(meldungAus({ status: 'EINGEPLANT', grund: null })).toBeNull();
    expect(meldungAus({ status: 'ZURUECKGESTELLT', grund: 'KONTAKT_INAKTIV' })).toBeNull();
  });

  it('offener Punkt 3: UNKNOWN/PARTIAL_FAILURE werden als unzustellbar gemeldet (Mail kann angekommen sein)', () => {
    // Bewusst in Kauf genommen (dokumentiert): keine „zugestellt“-Meldung ohne
    // nachgewiesene Annahme. Hier als grüne Regression fixiert, nicht als Befund.
    expect(auftragsAbschluss({ status: 'UNKNOWN', lastError: null })?.grund).toBe('VERSAND_UNKLAR');
    expect(auftragsAbschluss({ status: 'PARTIAL_FAILURE', lastError: null })?.grund).toBe(
      'VERSAND_GESCHEITERT',
    );
    expect(meldungAus(auftragsAbschluss({ status: 'UNKNOWN', lastError: null })!)).toMatchObject({
      art: 'UNZUSTELLBAR',
    });
  });

  it('gueltigBis ist fail closed: unlesbares Code-Gültigkeitsende gilt als sofort abgelaufen', () => {
    const code = (gueltigBisWert: string): OffeneNachricht =>
      ({
        id: 'n1',
        mandantId: 'm1',
        empfaengerArt: 'KONTAKT',
        empfaengerId: 'k1',
        erstelltAm: '2026-10-21T10:00:00.000Z',
        zweck: 'FREIGABE_CODE',
        daten: {
          art: 'FREIGABE',
          titel: 'T',
          version: '1',
          code: '000000',
          sha256: null,
          gueltigBis: gueltigBisWert,
        },
      }) as unknown as OffeneNachricht;
    expect(gueltigBis(code('unlesbar'))!.getTime()).toBe(0);
    expect(gueltigBis(code('2099-01-01T00:00:00.000Z'))!.toISOString()).toBe(
      '2099-01-01T00:00:00.000Z',
    );
    // Ein gemeldetes Ereignis an die Kanzlei hat kein Fenster (unbegrenzt).
    const ereignis = {
      id: 'n2',
      mandantId: 'm1',
      empfaengerArt: 'KANZLEI',
      empfaengerId: 's1',
      erstelltAm: '2026-10-21T10:00:00.000Z',
      zweck: 'EREIGNIS_GEMELDET',
      daten: { nummer: '2026-E-1', titel: 'X' },
    } as unknown as OffeneNachricht;
    expect(gueltigBis(ereignis)).toBeNull();
  });
});
