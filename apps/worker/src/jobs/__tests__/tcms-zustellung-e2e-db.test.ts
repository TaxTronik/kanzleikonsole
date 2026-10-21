// =============================================================================
// kk-tcms-s11: „Zugestellt“ heißt zugestellt – Ende zu Ende gegen echtes
// PostgreSQL und eine lokale SMTP-Senke (Muster aus der Integration kk-int3).
//
// Echt sind: der Zustell-Worker (tcms-nachrichten), die Mail-Outbox
// (processMailOutbox mit Aktualitätsprüfung, Claim, Endstatus und
// Inhalts-Leerung) und der Versand über @taxtronik/mail (nodemailer, SMTP aus
// der ENV, mit Pflicht-STARTTLS wie in Produktion). Das Tax-CMS ist ein
// In-Memory-Postausgang; die Senke ist ein minimaler SMTP-Server in diesem
// Test, der annimmt oder jeden Empfänger abweist.
//
// Belegt:
//   - Annahme durch den Mailserver: Die Mail mit dem Code erreicht die Senke
//     (Code im Text, nie im Betreff, nur nach STARTTLS übertragen), der
//     Auftrag endet PROVIDER_ACCEPTED ohne Inhalt, erst danach meldet der
//     Worker „zugestellt“ (vorher nichts).
//   - Ablehnung durch den Mailserver: Nach dem letzten Versuch FAILED, der
//     Worker meldet „unzustellbar“ (SONSTIGES), nie „zugestellt“; der Code
//     liegt danach nirgends mehr in der Datenbank.
//   - Verworfen vor dem Versand (Kontakt deaktiviert): SKIPPED, die Senke
//     erhält nichts, gemeldet wird „unzustellbar“ (KEIN_PORTALZUGANG).
//   - Logs ohne Code, Adresse und Personen-IDs.
//
// Läuft mit der Worker-DB-Suite (DB_TESTS=1 bzw. WORKER_DB_TEST=1). Die Senke
// lauscht auf einem freien Port von 127.0.0.1, nicht auf 1025: Im Host-Netz des
// CI-Runners belegt der MailHog des parallel laufenden E2E-Jobs 1025 (Lauf
// 3894). Abseits von 1025 verlangt @taxtronik/mail STARTTLS (requireTLS); die
// Senke bietet es mit einem Einmal-Zertifikat (openssl), dem nur dieser
// Testprozess vertraut.
//
// Fachkatalog: MAIL-OUTBOX-001
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo, Server, Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const senkeBasis = await vi.hoisted(async () => {
  // Vor dem ersten Import der Konfiguration: Versand an die Senke dieses Tests.
  process.env['SMTP_HOST'] = '127.0.0.1';
  process.env['SMTP_FROM'] = 'kanzlei@example.test';
  process.env['SMTP_PORT'] = '1025';
  if (process.env['WORKER_DB_TEST'] !== '1' && process.env['DB_TESTS'] !== '1') return null;
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const net = await import('node:net');
  const tls = await import('node:tls');
  // Selbstsigniertes Einmal-Zertifikat für 127.0.0.1; der Schlüssel liegt nur
  // im Speicher dieses Prozesses, das Verzeichnis wird sofort gelöscht.
  const ordner = mkdtempSync(join(tmpdir(), 'smtp-senke-'));
  let schluessel: string;
  let zertifikat: string;
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:prime256v1',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=senke.test',
        '-addext',
        'subjectAltName=IP:127.0.0.1',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,digitalSignature,keyCertSign',
        '-keyout',
        join(ordner, 'schluessel.pem'),
        '-out',
        join(ordner, 'zertifikat.pem'),
      ],
      { stdio: 'ignore' },
    );
    schluessel = readFileSync(join(ordner, 'schluessel.pem'), 'utf8');
    zertifikat = readFileSync(join(ordner, 'zertifikat.pem'), 'utf8');
  } finally {
    rmSync(ordner, { recursive: true, force: true });
  }
  // Nur dieser Testprozess vertraut der Senke; rejectUnauthorized bleibt an.
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), zertifikat]);
  // Den Server hier binden (Port 0 = frei) und offen an die Senke übergeben:
  // kein Fenster, in dem ein anderer Prozess den Port nehmen könnte.
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  server.unref();
  process.env['SMTP_PORT'] = String((server.address() as AddressInfo).port);
  return { server, schluessel, zertifikat };
});

const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  TcmsKonflikt,
  type NachrichtUnzustellbarGrund,
  type OffeneNachricht,
  type TcmsAkteurAngaben,
} from '@taxtronik/tcms-client';
import { prismaOwner } from '../../prisma-owner';
import {
  createActiveClientFixture,
  createTenantFixture,
  deleteTenantFixtures,
} from '../../__tests__/app-role-db';
import { withWorkerTenantContext } from '../../tenant-context';
import { notify } from '../../notify';
import { sendTemplateMail, notifyClientContacts } from '../../mail';
import type { TcmsPostausgang } from '../../tcms/dienst';
import {
  MAIL_OUTBOX_MAX_ATTEMPTS,
  processMailOutbox,
  type MailOutboxDeliveryDeps,
} from '../mail-outbox';
import { stelleTcmsNachrichtenZu, type TcmsZustellDeps } from '../tcms-nachrichten';

const describeDb = enabled ? describe : describe.skip;

const CODE = '739128';
const TITEL = 'Beschreibung Seestern 2026';

/** Eine angenommene oder abgewiesene Sitzung der Senke. */
interface Sitzung {
  von: string | null;
  an: string[];
  daten: string | null;
  /** Nach STARTTLS (TLS-Handshake abgeschlossen). */
  verschluesselt: boolean;
}

/**
 * Minimaler SMTP-Server (RFC 5321 mit STARTTLS nach RFC 3207, ohne AUTH):
 * EHLO/HELO, STARTTLS, MAIL, RCPT, DATA, RSET, NOOP, QUIT. `ablehnen`: jeder
 * Empfänger 550 (eindeutige Ablehnung des Providers).
 */
class SmtpSenke {
  readonly sitzungen: Sitzung[] = [];
  ablehnen = false;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly basis: { server: Server; schluessel: string; zertifikat: string } | null,
  ) {}

  starte(): void {
    if (!this.basis) throw new Error('SMTP-Senke: ohne DB-Suite nicht vorbereitet.');
    this.basis.server.on('connection', (socket: Socket) => this.bediene(socket));
  }

  async stoppe(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) =>
      this.basis?.server.listening ? this.basis.server.close(() => resolve()) : resolve(),
    );
  }

  private bediene(socket: Socket, bestehend?: Sitzung): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.setEncoding('utf8');
    const sitzung: Sitzung = bestehend ?? { von: null, an: [], daten: null, verschluesselt: false };
    if (!bestehend) this.sitzungen.push(sitzung);
    let puffer = '';
    let imDaten = false;
    const antworte = (zeile: string) => socket.write(`${zeile}\r\n`);
    if (!bestehend) antworte('220 senke.test ESMTP');
    socket.on('data', (teil: string) => {
      puffer += teil;
      for (;;) {
        if (imDaten) {
          const ende = puffer.indexOf('\r\n.\r\n');
          if (ende < 0) return;
          sitzung.daten = puffer.slice(0, ende);
          puffer = puffer.slice(ende + 5);
          imDaten = false;
          antworte('250 2.0.0 angenommen');
          continue;
        }
        const zeilenende = puffer.indexOf('\r\n');
        if (zeilenende < 0) return;
        const zeile = puffer.slice(0, zeilenende);
        puffer = puffer.slice(zeilenende + 2);
        const befehl = zeile.slice(0, 4).toUpperCase();
        if (befehl === 'EHLO') {
          socket.write(
            sitzung.verschluesselt
              ? '250-senke.test\r\n250 8BITMIME\r\n'
              : '250-senke.test\r\n250-8BITMIME\r\n250 STARTTLS\r\n',
          );
        } else if (befehl === 'STAR' && !sitzung.verschluesselt) {
          // STARTTLS: ab hier spricht der Client TLS auf demselben Socket.
          antworte('220 2.0.0 TLS bereit');
          socket.removeAllListeners('data');
          const sicher = new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext({
              key: this.basis!.schluessel,
              cert: this.basis!.zertifikat,
              minVersion: 'TLSv1.2',
            }),
          });
          sicher.once('secure', () => {
            sitzung.verschluesselt = true;
          });
          this.bediene(sicher, sitzung);
          return;
        } else if (befehl === 'HELO') {
          antworte('250 senke.test');
        } else if (befehl === 'MAIL') {
          sitzung.von = zeile.slice(10).trim();
          antworte('250 2.1.0 ok');
        } else if (befehl === 'RCPT') {
          if (this.ablehnen) {
            antworte('550 5.1.1 Empfänger abgelehnt');
          } else {
            sitzung.an.push(zeile.slice(8).trim());
            antworte('250 2.1.5 ok');
          }
        } else if (befehl === 'DATA') {
          imDaten = true;
          antworte('354 Daten senden');
        } else if (befehl === 'QUIT') {
          antworte('221 2.0.0 tschüss');
          socket.end();
          return;
        } else {
          antworte('250 ok');
        }
      }
    });
  }

  /** Sitzungen mit übertragener Nachricht. */
  get nachrichten(): Sitzung[] {
    return this.sitzungen.filter((s) => s.daten !== null);
  }
}

/** In-Memory-Postausgang wie der Dienst: gemeldete Mitteilungen liefert der Abruf nicht mehr. */
class Postausgang implements TcmsPostausgang {
  nachrichten: OffeneNachricht[] = [];
  zugestellt = new Set<string>();
  unzustellbarMit = new Map<string, NachrichtUnzustellbarGrund>();
  holen = vi.fn(async (_akteur: TcmsAkteurAngaben, limit: number) =>
    this.nachrichten
      .filter((n) => !this.zugestellt.has(n.id) && !this.unzustellbarMit.has(n.id))
      .slice(0, limit),
  );
  melden = vi.fn(async (_akteur: TcmsAkteurAngaben, id: string) => {
    if (this.unzustellbarMit.has(id)) throw new TcmsKonflikt({ status: 409 });
    this.zugestellt.add(id);
  });
  unzustellbar = vi.fn(
    async (_akteur: TcmsAkteurAngaben, id: string, grund: NachrichtUnzustellbarGrund) => {
      if (this.zugestellt.has(id)) throw new TcmsKonflikt({ status: 409 });
      this.unzustellbarMit.set(id, grund);
    },
  );
}

describeDb('kk-tcms-s11: Zustellung Ende zu Ende mit SMTP-Senke', () => {
  const senke = new SmtpSenke(senkeBasis);
  let tenantId = '';
  let mandantId = '';
  let kontaktId = '';
  let postausgang: Postausgang;
  type LogFn = (obj: Record<string, unknown>, msg: string) => void;
  let log: { info: Mock<LogFn>; warn: Mock<LogFn>; error: Mock<LogFn> };
  const outboxLog = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };

  const tcmsDeps = (): TcmsZustellDeps => ({
    db: prismaOwner,
    runAtomic: (t, fn) => withWorkerTenantContext(t, fn),
    istAktiv: async () => true,
    postausgang: () => postausgang,
    notify: (tx, input, options) => notify(tx, input, options),
    kickMail: () => undefined,
    portalBaseUrl: 'https://portal.example.test',
    log,
  });

  const outboxDeps = (): MailOutboxDeliveryDeps => ({
    db: prismaOwner,
    runAtomic: (t, fn) => withWorkerTenantContext(t, fn),
    sendTemplateMail,
    notifyClientContacts,
    loadAttachment: vi.fn(),
    notifyStaff: (tx, input) => notify(tx, input),
    log: outboxLog,
  });

  const lauf = () => stelleTcmsNachrichtenZu(tcmsDeps(), { tenantId });

  /** Mail-Outbox wie der Worker-Job; `inMinuten` verschiebt die Uhr für fällige Wiederholungen. */
  const versende = (inMinuten = 0) =>
    processMailOutbox(outboxDeps(), {
      tenantId,
      now: new Date(Date.now() + inMinuten * 60_000),
    });

  function codeNachricht(): OffeneNachricht {
    return {
      id: `cm${randomBytes(8).toString('hex')}`,
      mandantId,
      empfaengerId: kontaktId,
      empfaengerArt: 'KONTAKT',
      zweck: 'FREIGABE_CODE',
      betreff: 'Betreff des Dienstes',
      text: `Code ${CODE}`,
      erstelltAm: new Date().toISOString(),
      daten: {
        freigabeId: 'cmfreigabee2e1',
        art: 'BESCHREIBUNG',
        titel: TITEL,
        version: '2.0',
        code: CODE,
        gueltigBis: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        sha256: 'b'.repeat(64),
      },
    } as OffeneNachricht;
  }

  const zeile = (nachrichtId: string) =>
    prismaOwner.tcmsNachrichtZustellung.findFirstOrThrow({ where: { tenantId, nachrichtId } });
  const auftrag = async () =>
    prismaOwner.mailOutbox.findFirstOrThrow({
      where: { tenantId, resourceType: 'tcms_nachricht' },
    });

  /** Kein Code, keine Adresse, keine Personen- oder Mandanten-ID im Log. */
  function logOhneInhalt() {
    const alles = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    for (const verboten of [CODE, 'marta@seestern', kontaktId, mandantId, TITEL]) {
      expect(alles).not.toContain(verboten);
    }
  }

  beforeAll(async () => {
    senke.starte();
    tenantId = await createTenantFixture(prismaOwner, 'tcms-e2e');
    const admin = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `admin-${randomUUID()}@example.test`,
          fullName: 'Anna Roth',
          passwordHash: 'synthetic',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    mandantId = await createActiveClientFixture(prismaOwner, tenantId, admin, 'Seestern GmbH');
    kontaktId = (
      await prismaOwner.clientContact.create({
        data: {
          tenantId,
          clientId: mandantId,
          email: 'marta@seestern.example',
          fullName: 'Marta Seestern',
          lastLoginAt: new Date('2026-10-01T08:00:00Z'),
        },
      })
    ).id;
  });

  afterAll(async () => {
    await senke.stoppe();
    await deleteTenantFixtures(prismaOwner, [tenantId]);
    await prismaOwner.$disconnect();
  });

  beforeEach(async () => {
    postausgang = new Postausgang();
    log = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
    senke.sitzungen.length = 0;
    senke.ablehnen = false;
    await prismaOwner.mailOutbox.deleteMany({ where: { tenantId } });
    await prismaOwner.tcmsNachrichtZustellung.deleteMany({ where: { tenantId } });
    await prismaOwner.clientContact.update({ where: { id: kontaktId }, data: { active: true } });
  });

  it('der Mailserver nimmt an: erst danach „zugestellt“, Code nur im Text und danach nirgends mehr', async () => {
    const n = codeNachricht();
    postausgang.nachrichten = [n];

    expect(await lauf()).toMatchObject({ eingeplant: 1, gemeldet: 0 });
    expect(postausgang.melden).not.toHaveBeenCalled();

    expect(await versende()).toMatchObject({ providerAccepted: 1 });
    const [mail] = senke.nachrichten;
    expect(senke.nachrichten).toHaveLength(1);
    expect(mail!.an).toEqual(['<marta@seestern.example>']);
    // Pflicht-STARTTLS wie in Produktion: der Code ging nur verschlüsselt über die Leitung.
    expect(mail!.verschluesselt).toBe(true);
    const betreff = /^Subject: (.*)$/im.exec(mail!.daten!)?.[1] ?? '';
    expect(betreff).not.toBe('');
    expect(betreff).not.toContain(CODE);
    expect(mail!.daten).toContain(CODE);
    expect(await auftrag()).toMatchObject({
      status: 'PROVIDER_ACCEPTED',
      payload: {},
      secretVarsEnc: null,
    });

    expect(await lauf()).toMatchObject({ angenommen: 1, gemeldet: 1 });
    expect(postausgang.zugestellt.has(n.id)).toBe(true);
    expect(postausgang.unzustellbar).not.toHaveBeenCalled();
    expect(await zeile(n.id)).toMatchObject({ status: 'ANGENOMMEN', grund: null });
    // Kein zweiter Versand, keine zweite Meldung.
    expect(await lauf()).toMatchObject({ eingeplant: 0, gemeldet: 0 });
    expect(await versende()).toMatchObject({ processed: 0 });
    expect(senke.nachrichten).toHaveLength(1);
    logOhneInhalt();
  });

  it('der Mailserver lehnt ab: nach dem letzten Versuch „unzustellbar“, nie „zugestellt“', async () => {
    senke.ablehnen = true;
    const n = codeNachricht();
    postausgang.nachrichten = [n];
    await lauf();

    for (let versuch = 1; versuch <= MAIL_OUTBOX_MAX_ATTEMPTS; versuch += 1) {
      await versende(versuch * 60);
      // Solange wiederholt wird, meldet der Worker nichts.
      if (versuch < MAIL_OUTBOX_MAX_ATTEMPTS) {
        expect((await auftrag()).status, `Versuch ${versuch}`).toBe('RETRY_PENDING');
        expect(await lauf()).toMatchObject({ gescheitert: 0, gemeldet: 0 });
      }
    }
    expect(senke.nachrichten).toHaveLength(0);
    expect(await auftrag()).toMatchObject({ status: 'FAILED', payload: {}, secretVarsEnc: null });

    expect(await lauf()).toMatchObject({ gescheitert: 1, gemeldet: 1 });
    expect(postausgang.unzustellbarMit.get(n.id)).toBe('SONSTIGES');
    expect(postausgang.melden).not.toHaveBeenCalled();
    expect(await zeile(n.id)).toMatchObject({
      status: 'GESCHEITERT',
      grund: 'VERSAND_GESCHEITERT',
    });
    expect(JSON.stringify(await auftrag())).not.toContain(CODE);
    logOhneInhalt();
  });

  it('vor dem Versand verworfen (Kontakt deaktiviert): nichts an die Senke, „unzustellbar“ ohne Portalzugang', async () => {
    const n = codeNachricht();
    postausgang.nachrichten = [n];
    await lauf();
    await prismaOwner.clientContact.update({ where: { id: kontaktId }, data: { active: false } });

    expect(await versende()).toMatchObject({ skipped: 1, providerAccepted: 0 });
    expect(senke.sitzungen).toHaveLength(0);
    expect(await lauf()).toMatchObject({ gescheitert: 1, gemeldet: 1 });
    expect(postausgang.unzustellbarMit.get(n.id)).toBe('KEIN_PORTALZUGANG');
    expect(await zeile(n.id)).toMatchObject({ status: 'GESCHEITERT', grund: 'KONTAKT_INAKTIV' });
    logOhneInhalt();
  });
});
