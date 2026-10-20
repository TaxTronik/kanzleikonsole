// =============================================================================
// Red Team kk-tcms-redteam3b (TCMS Stufe 4): ausgeführte Angriffe auf die
// Zustellung des Postausgangs mit einem BÖSARTIGEN Dienst – ein lokaler
// HTTP-Server auf TCMS_URL, der schemanahe, aber feindliche Antworten liefert –
// und dem echten Client, PostgreSQL (Owner wie im Worker, Tenant-
// Transaktionen), der echten Mail-Outbox und der echten Vorlagen-Zustellung
// (`sendTemplateMail`/`sendMail`); ersetzt ist nur der SMTP-Transport
// (nodemailer), der die fertige Nachricht protokolliert.
//
// Angriffe:
//   Z1 Empfänger anderer Mandanten/Tenants (auch dieselbe Person als Kontakt
//      zweier Mandanten), Kanzleipersonen ohne Zugriff bzw. fremder Tenants.
//   Z2 Protokoll: Weiterleitung, falscher Typ, übergroße Antwort, unbekanntes
//      Feld (z. B. eine E-Mail-Adresse), CR/LF im Titel, zu viele
//      Mitteilungen, langsame Antwort.
//   Z3 Inhalt: Titel mit Links, HTML, Markdown und Encoded-Word; Betreff und
//      Text des Dienstes mit Code und Phishing-Link – bis in die gesendete Mail.
//   Z4 Empfänger zwischen Einplanung und Versand geändert: Adresse, Mandant,
//      Portalzugang, Mandat beendet.
//   Z5 zwei Läufe gleichzeitig gegen denselben Dienst.
//   Z6 Code in allen Persistenzen (jede Tabelle mit tenant_id) und Logs,
//      auch wenn der Provider den Inhalt im Fehlertext zurückgibt.
//
//   DB_TESTS=1 (db_suite_env) pnpm exec vitest run --config vitest.db.config.ts \
//     src/jobs/__tests__/redteam-zustellung-db.test.ts
// Fachkatalog: MAIL-OUTBOX-001, TCMS-AKTEUR-001
// =============================================================================

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

/** Fertige SMTP-Nachrichten und ein optionaler Providerfehler. */
const smtp = vi.hoisted(() => ({
  versendet: [] as Array<Record<string, unknown>>,
  fehler: null as Error | null,
}));
const modulLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../logger', () => ({ log: modulLog }));
vi.mock('nodemailer', () => {
  const createTransport = () => ({
    sendMail: async (nachricht: Record<string, unknown>) => {
      if (smtp.fehler) throw smtp.fehler;
      smtp.versendet.push(nachricht);
      return { accepted: [String(nachricht['to'])], rejected: [], response: '250 OK' };
    },
    close: () => undefined,
    verify: async () => true,
  });
  return { default: { createTransport }, createTransport };
});

import { sendTemplateMail, setMailLogger } from '@taxtronik/mail';
import { NUR_SYSTEMAKTEUR, TcmsClient, type OffeneNachricht } from '@taxtronik/tcms-client';
import { prismaOwner } from '../../prisma-owner';
import {
  createActiveClientFixture,
  createTenantFixture,
  deleteTenantFixtures,
} from '../../__tests__/app-role-db';
import { withWorkerTenantContext } from '../../tenant-context';
import { notify } from '../../notify';
import { postausgangUeber } from '../../tcms/dienst';
import { processMailOutbox } from '../mail-outbox';
import { stelleTcmsNachrichtenZu, type TcmsZustellDeps } from '../tcms-nachrichten';

const describeDb = enabled ? describe : describe.skip;

const CODE = '739154';
const BOESER_BETREFF = `Dringend: Code ${CODE} unter https://evil.example/login bestätigen`;
const BOESER_TEXT = `Ihr Code lautet ${CODE}. Freigabe: https://evil.example/freigabe`;
const PORTAL = 'https://portal.example.test';
const JANA_MAIL = 'jana@talwind.example';
const UNGUELTIGE_GRUENDE = [
  'KONTAKT_ANDERER_MANDANT',
  'KONTAKT_UNBEKANNT',
  'MANDANT_UNBEKANNT',
  'PERSON_UNBEKANNT',
  'PERSON_OHNE_ZUGRIFF',
];

type LogFn = (obj: Record<string, unknown>, msg: string) => void;

/** Antwort des bösartigen Dienstes auf den Abruf offener Mitteilungen. */
type Abruf =
  | { art: 'json'; nachrichten: unknown[] }
  | { art: 'roh'; status: number; headers: Record<string, string>; body: string | Buffer }
  | { art: 'langsam'; ms: number; nachrichten: unknown[] };

interface Stub {
  client: TcmsClient;
  ziele: string[];
  schliessen(): Promise<void>;
}

/** Bösartiger Dienst: Abruf nach `abruf`, Meldungen werden angenommen und protokolliert. */
async function boeserDienst(abruf: () => Abruf): Promise<Stub> {
  const ziele: string[] = [];
  const server: Server = createServer((req: IncomingMessage, res) => {
    ziele.push(`${req.method} ${req.url}`);
    const teile: Buffer[] = [];
    req.on('data', (c: Buffer) => teile.push(c));
    req.on('end', () => {
      const body = Buffer.concat(teile).toString('utf8');
      const id = /\/v1\/nachrichten\/([^/]+)\//.exec(req.url ?? '')?.[1] ?? '';
      if (req.method !== 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify(
            req.url?.endsWith('/unzustellbar')
              ? {
                  ok: true,
                  daten: {
                    nachrichtId: id,
                    unzustellbar: true,
                    grund: (JSON.parse(body || '{}') as { grund?: string }).grund,
                  },
                }
              : { ok: true, daten: { nachrichtId: id, zugestellt: true } },
          ),
        );
        return;
      }
      const a = abruf();
      if (a.art === 'roh') {
        res.writeHead(a.status, a.headers);
        res.end(a.body);
        return;
      }
      const senden = () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, daten: { nachrichten: a.nachrichten } }));
      };
      if (a.art === 'langsam') setTimeout(senden, a.ms);
      else senden();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const client = new TcmsClient({
    config: {
      url: `http://127.0.0.1:${port}`,
      serviceToken: randomBytes(32).toString('base64url'),
      actorKeyId: 'kk-rt3b',
      actorPrivateKey: generateKeyPairSync('ed25519').privateKey,
    },
    akteurArten: NUR_SYSTEMAKTEUR,
  });
  return {
    client,
    ziele,
    async schliessen() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describeDb('Red Team: Zustellung mit bösartigem Dienst', () => {
  let tenantId = '';
  let fremderTenant = '';
  let mandant = '';
  let mandant2 = '';
  let vertraulich = '';
  let fremderMandant = '';
  let jana = '';
  /** Dieselbe Person (gleiche E-Mail) als Kontakt eines zweiten Mandanten. */
  let janaZwei = '';
  let fremderKontakt = '';
  let admin = '';
  let leon = '';
  let fremdePerson = '';
  let jetzt = new Date();
  let log: { info: Mock<LogFn>; warn: Mock<LogFn>; error: Mock<LogFn> };
  const mailLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  function deps(stub: Stub): TcmsZustellDeps {
    return {
      db: prismaOwner,
      runAtomic: (t, fn) => withWorkerTenantContext(t, fn),
      istAktiv: async () => true,
      postausgang: () => postausgangUeber(stub.client),
      notify: (tx, input, options) => notify(tx, input, options),
      kickMail: vi.fn(),
      portalBaseUrl: PORTAL,
      log,
    };
  }

  const lauf = (stub: Stub) =>
    stelleTcmsNachrichtenZu(deps(stub), { tenantId, jetzt: () => jetzt });

  function versenden() {
    return processMailOutbox(
      {
        db: prismaOwner,
        runAtomic: (t, fn) => withWorkerTenantContext(t, fn),
        sendTemplateMail,
        notifyClientContacts: vi.fn(),
        loadAttachment: vi.fn(),
        notifyStaff: (tx, input) => notify(tx, input),
        log,
      },
      { tenantId, now: new Date() },
    );
  }

  function code(
    overrides: Partial<OffeneNachricht> = {},
    titel = 'Beschreibung 2026',
  ): OffeneNachricht {
    return {
      id: `cm${randomBytes(8).toString('hex')}`,
      mandantId: mandant,
      empfaengerId: jana,
      empfaengerArt: 'KONTAKT',
      zweck: 'FREIGABE_CODE',
      betreff: BOESER_BETREFF,
      text: BOESER_TEXT,
      erstelltAm: jetzt.toISOString(),
      daten: {
        freigabeId: 'cmfreigabe0001',
        art: 'BESCHREIBUNG',
        titel,
        version: '1.2',
        code: CODE,
        gueltigBis: new Date(jetzt.getTime() + 7 * 86_400_000).toISOString(),
        sha256: 'a'.repeat(64),
      },
      ...overrides,
    } as OffeneNachricht;
  }

  function anforderung(overrides: Partial<OffeneNachricht> = {}): OffeneNachricht {
    return {
      id: `cm${randomBytes(8).toString('hex')}`,
      mandantId: mandant,
      empfaengerId: jana,
      empfaengerArt: 'KONTAKT',
      zweck: 'FREIGABE_ANGEFORDERT',
      betreff: BOESER_BETREFF,
      text: BOESER_TEXT,
      erstelltAm: jetzt.toISOString(),
      daten: {
        freigabeId: 'cmfreigabe0002',
        art: 'KENNTNISNAHME',
        titel: 'Kenntnisnahme',
        version: null,
      },
      ...overrides,
    } as OffeneNachricht;
  }

  function ereignis(mandantId: string, empfaengerId: string): OffeneNachricht {
    return {
      id: `cm${randomBytes(8).toString('hex')}`,
      mandantId,
      empfaengerId,
      empfaengerArt: 'KANZLEI',
      zweck: 'EREIGNIS_GEMELDET',
      betreff: BOESER_BETREFF,
      text: BOESER_TEXT,
      erstelltAm: jetzt.toISOString(),
      daten: {
        ereignisId: 'cmereignis0001',
        nummer: 'E-2026-099',
        titel: 'Neuer Marktplatz',
        typ: 'Sonstiges',
        gemeldetVonId: jana,
      },
    };
  }

  const auftraege = () =>
    prismaOwner.mailOutbox.findMany({ where: { tenantId, resourceType: 'tcms_nachricht' } });
  const zustellungen = () => prismaOwner.tcmsNachrichtZustellung.findMany({ where: { tenantId } });

  /** Tabellen mit tenant_id, in deren Zeilen dieses Tenants `text` vorkommt. */
  async function fundstellen(text: string): Promise<string[]> {
    const tabellen = await prismaOwner.$queryRaw<Array<{ t: string }>>`
      SELECT c.table_name AS t
        FROM information_schema.columns c
        JOIN information_schema.tables tb
          ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
         AND tb.table_type = 'BASE TABLE'
       ORDER BY 1`;
    const treffer: string[] = [];
    for (const { t } of tabellen) {
      const [z] = await prismaOwner.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM public."${t.replace(/"/g, '')}" x
          WHERE x.tenant_id = $1::uuid AND to_jsonb(x)::text LIKE $2`,
        tenantId,
        `%${text}%`,
      );
      if ((z?.n ?? 0) > 0) treffer.push(t);
    }
    return treffer;
  }

  /** Alle Log-Aufrufe (Job, Outbox, Modul, Mail-Paket) als Text. */
  function alleLogs(): string {
    return JSON.stringify([
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
      modulLog.info.mock.calls,
      modulLog.warn.mock.calls,
      modulLog.error.mock.calls,
      mailLog.info.mock.calls,
      mailLog.warn.mock.calls,
      mailLog.error.mock.calls,
    ]);
  }

  beforeAll(async () => {
    setMailLogger(mailLog as never);
    const suffix = randomUUID();
    tenantId = await createTenantFixture(prismaOwner, 'tcms-rt3b');
    fremderTenant = await createTenantFixture(prismaOwner, 'tcms-rt3b-fremd');
    const person = async (tenant: string, name: string, role: 'ADMIN' | 'EMPLOYEE') =>
      (
        await prismaOwner.staffUser.create({
          data: {
            tenantId: tenant,
            email: `${randomUUID()}@example.test`,
            fullName: name,
            passwordHash: 'synthetic',
            roles: { create: { role } },
          },
        })
      ).id;
    admin = await person(tenantId, 'Anna Roth', 'ADMIN');
    leon = await person(tenantId, 'Leon Brandt', 'EMPLOYEE');
    fremdePerson = await person(fremderTenant, 'Eve Fremd', 'ADMIN');
    mandant = await createActiveClientFixture(prismaOwner, tenantId, admin, `Talwind ${suffix}`);
    mandant2 = await createActiveClientFixture(prismaOwner, tenantId, admin, `Seestern ${suffix}`);
    vertraulich = await createActiveClientFixture(prismaOwner, tenantId, admin, `Geheim ${suffix}`);
    await prismaOwner.client.update({ where: { id: vertraulich }, data: { vertraulich: true } });
    fremderMandant = await createActiveClientFixture(
      prismaOwner,
      fremderTenant,
      fremdePerson,
      `Fremd ${suffix}`,
    );
    const kontakt = async (tenant: string, clientId: string, email: string, name: string) =>
      (
        await prismaOwner.clientContact.create({
          data: {
            tenantId: tenant,
            clientId,
            email,
            fullName: name,
            lastLoginAt: new Date('2026-10-01T08:00:00Z'),
          },
        })
      ).id;
    jana = await kontakt(tenantId, mandant, JANA_MAIL, 'Jana Weller');
    janaZwei = await kontakt(tenantId, mandant2, JANA_MAIL, 'Jana Weller');
    fremderKontakt = await kontakt(fremderTenant, fremderMandant, 'fritz@fremd.example', 'Fritz');
  });

  afterAll(async () => {
    await deleteTenantFixtures(prismaOwner, [tenantId, fremderTenant]);
    await prismaOwner.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    smtp.versendet.length = 0;
    smtp.fehler = null;
    jetzt = new Date();
    log = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
    await prismaOwner.mailOutbox.deleteMany({ where: { tenantId } });
    await prismaOwner.notification.deleteMany({ where: { tenantId } });
    await prismaOwner.tcmsNachrichtZustellung.deleteMany({ where: { tenantId } });
    await prismaOwner.tcmsSystemakteur.updateMany({
      where: { tenantId },
      data: { laufHalter: null, laufBis: null },
    });
    await prismaOwner.clientContact.update({
      where: { id: jana },
      data: { active: true, email: JANA_MAIL, clientId: mandant },
    });
    await prismaOwner.client.update({ where: { id: mandant }, data: { mandateEndedAt: null } });
  });

  it('RT3B-Z1: Empfänger anderer Mandanten und Tenants, Kanzleipersonen ohne Zugriff – nichts eingeplant, nichts zugestellt gemeldet', async () => {
    const boese = [
      anforderung({ empfaengerId: janaZwei }), // dieselbe Person, Kontakt eines anderen Mandanten
      anforderung({ mandantId: mandant2, empfaengerId: jana }),
      anforderung({ mandantId: fremderMandant, empfaengerId: fremderKontakt }),
      anforderung({ empfaengerId: fremderKontakt }),
      code({ empfaengerId: janaZwei }),
      ereignis(mandant, fremdePerson),
      ereignis(vertraulich, leon),
    ];
    const stub = await boeserDienst(() => ({ art: 'json', nachrichten: boese }));
    try {
      await lauf(stub);
    } finally {
      await stub.schliessen();
    }
    expect(await auftraege()).toEqual([]);
    expect(
      await prismaOwner.notification.count({ where: { tenantId, kind: 'TCMS_EREIGNIS_GEMELDET' } }),
    ).toBe(0);
    expect(stub.ziele.filter((z) => z.endsWith('/zugestellt'))).toEqual([]);
    const zeilen = await zustellungen();
    // Jede Mitteilung wurde geprüft (Zustellzeile), keine eingeplant.
    expect(zeilen).toHaveLength(boese.length);
    for (const z of zeilen) {
      expect(z.status).not.toBe('EINGEPLANT');
      expect(UNGUELTIGE_GRUENDE).toContain(z.grund);
    }
    expect(smtp.versendet).toEqual([]);
    expect(alleLogs()).not.toContain(CODE);
  });

  it.each([
    [
      'Weiterleitung',
      (): Abruf => ({
        art: 'roh',
        status: 302,
        headers: { location: 'http://127.0.0.1:9/v1/nachrichten/offen' },
        body: '',
      }),
    ],
    [
      'falscher Inhaltstyp',
      (): Abruf => ({
        art: 'roh',
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<h1>x</h1>',
      }),
    ],
    [
      'übergroße Antwort (9 MiB)',
      (): Abruf => ({
        art: 'roh',
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.concat([
          Buffer.from('{"ok":true,"daten":{"nachrichten":['),
          Buffer.alloc(9 * 1024 * 1024, 0x20),
          Buffer.from(']}}'),
        ]),
      }),
    ],
    [
      'unbekanntes Feld (Adresse)',
      (): Abruf => ({ art: 'json', nachrichten: [{ ...code(), email: 'evil@evil.example' }] }),
    ],
    [
      'CR/LF im Titel',
      (): Abruf => ({ art: 'json', nachrichten: [code({}, 'Freigabe\r\nBcc: evil@evil.example')] }),
    ],
    [
      '101 Mitteilungen',
      (): Abruf => ({ art: 'json', nachrichten: Array.from({ length: 101 }, () => code()) }),
    ],
    [
      'langsame Antwort (11 s)',
      (): Abruf => ({ art: 'langsam', ms: 11_000, nachrichten: [code()] }),
    ],
  ])(
    'RT3B-Z2: Protokollangriff „%s“ – nichts eingeplant, nichts gemeldet',
    async (_name, abruf) => {
      const stub = await boeserDienst(abruf);
      try {
        await lauf(stub).catch(() => null);
      } finally {
        await stub.schliessen();
      }
      // Der Abruf hat stattgefunden (sonst wäre der Test wertlos) …
      expect(stub.ziele.some((z) => z.startsWith('GET /v1/nachrichten/offen'))).toBe(true);
      // … und nichts davon wurde übernommen.
      expect(await auftraege()).toEqual([]);
      expect(await zustellungen()).toEqual([]);
      expect(stub.ziele.filter((z) => !z.startsWith('GET '))).toEqual([]);
    },
    30_000,
  );

  it('RT3B-Z3: Titel mit Link/HTML/Markdown/Encoded-Word, Betreff und Text des Dienstes mit Code – gesendete Mail aus der kanzleikonsole', async () => {
    const titel =
      'Freigabe https://evil.example/login <a href="https://evil.example">hier</a> [klick](https://evil.example) =?UTF-8?B?QmNjOiBldmls?=';
    const n = code({}, titel);
    const stub = await boeserDienst(() => ({ art: 'json', nachrichten: [n] }));
    try {
      expect(await lauf(stub)).toMatchObject({ eingeplant: 1 });
    } finally {
      await stub.schliessen();
    }
    await versenden();
    expect(smtp.versendet).toHaveLength(1);
    const mail = smtp.versendet[0]!;
    const html = String(mail['html'] ?? '');
    const text = String(mail['text'] ?? '');
    expect(mail['to']).toBe(JANA_MAIL);
    expect(String(mail['subject'])).not.toMatch(/[\r\n]/);
    expect(String(mail['subject'])).not.toContain(CODE);
    // Kein vom Dienst gelieferter Link wird zum Hyperlink, kein HTML des Dienstes.
    expect(html).not.toMatch(/href="https?:\/\/evil\.example/);
    expect(html).not.toContain('<a href="https://evil.example">');
    // Betreff und Text des Dienstes werden nie übernommen.
    for (const teil of [html, text, String(mail['subject'])]) {
      expect(teil).not.toContain('Dringend');
      expect(teil).not.toContain('evil.example/freigabe');
    }
    // Der Code steht genau im Text der Mail (Zweck der Mitteilung).
    expect(text).toContain(CODE);
  });

  it.each([
    [
      'Adresse geändert',
      async () => {
        await prismaOwner.clientContact.update({
          where: { id: jana },
          data: { email: 'neu@talwind.example' },
        });
      },
    ],
    [
      'Kontakt einem anderen Mandanten zugeordnet',
      async () => {
        await prismaOwner.clientContact.update({
          where: { id: jana },
          data: { clientId: vertraulich },
        });
      },
    ],
    [
      'Portalzugang entzogen (Kontakt deaktiviert)',
      async () => {
        await prismaOwner.clientContact.update({ where: { id: jana }, data: { active: false } });
      },
    ],
    [
      'Mandat beendet',
      async () => {
        await prismaOwner.client.update({
          where: { id: mandant },
          data: { mandateEndedAt: new Date() },
        });
      },
    ],
  ])(
    'RT3B-Z4: zwischen Einplanung und Versand „%s“ – nicht versendet, Inhalt und Code verworfen',
    async (_name, aendern) => {
      const stub = await boeserDienst(() => ({ art: 'json', nachrichten: [code()] }));
      try {
        expect(await lauf(stub)).toMatchObject({ eingeplant: 1 });
      } finally {
        await stub.schliessen();
      }
      await aendern();
      await versenden();
      expect(smtp.versendet).toEqual([]);
      const [auftrag] = await auftraege();
      expect(auftrag).toMatchObject({ status: 'SKIPPED', payload: {}, secretVarsEnc: null });
    },
  );

  it('RT3B-Z5: zwei Läufe gleichzeitig gegen denselben Dienst – ein Auftrag, eine Mail', async () => {
    const n = code();
    const stub = await boeserDienst(() => ({ art: 'langsam', ms: 300, nachrichten: [n] }));
    try {
      await Promise.all([lauf(stub), lauf(stub)]);
      await lauf(stub);
    } finally {
      await stub.schliessen();
    }
    expect(await auftraege()).toHaveLength(1);
    await Promise.all([versenden(), versenden()]);
    expect(smtp.versendet).toHaveLength(1);
  });

  it('RT3B-Z6: der Code steht nach Versand, Verwerfen und Providerfehler in keiner Tabelle und keinem Log', async () => {
    // Versendet …
    let stub = await boeserDienst(() => ({ art: 'json', nachrichten: [code()] }));
    try {
      await lauf(stub);
    } finally {
      await stub.schliessen();
    }
    await versenden();
    expect(smtp.versendet).toHaveLength(1);
    // … verworfen (Adresse geändert) …
    stub = await boeserDienst(() => ({ art: 'json', nachrichten: [code()] }));
    try {
      await lauf(stub);
    } finally {
      await stub.schliessen();
    }
    await prismaOwner.clientContact.update({
      where: { id: jana },
      data: { email: 'neu@talwind.example' },
    });
    await versenden();
    await prismaOwner.clientContact.update({ where: { id: jana }, data: { email: JANA_MAIL } });
    // … und ein Providerfehler, dessen Text den Inhalt der Mail zurückgibt
    // (Inhaltsfilter, Bounce-Text): eindeutig abgelehnt.
    smtp.fehler = Object.assign(
      new Error(
        `Message failed: 550 5.7.1 content rejected: "Ihr Bestätigungscode lautet ${CODE}"`,
      ),
      { responseCode: 550, code: 'EMESSAGE' },
    );
    stub = await boeserDienst(() => ({ art: 'json', nachrichten: [code()] }));
    try {
      await lauf(stub);
    } finally {
      await stub.schliessen();
    }
    await versenden();
    expect(await fundstellen(CODE)).toEqual([]);
    // Heute: packages/mail/src/dispatch.ts protokolliert `err: error.message` des
    // Providers wörtlich („mail: template send failed“) – mit dem Code.
    expect(alleLogs()).not.toContain(CODE);
  });
});
