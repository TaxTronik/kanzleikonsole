// =============================================================================
// TCMS Stufe 4: Zustellung des Postausgangs des Tax-CMS gegen echtes
// PostgreSQL (Owner wie im Worker, Tenant-Transaktionen, Trigger, CHECKs,
// eindeutige Schlüssel). Der Dienst ist ein In-Memory-Postausgang bzw. für den
// Endpunkt-Nachweis ein lokaler HTTP-Server mit echtem Client.
//
// Belegt: Empfänger nur aus der kanzleikonsole (Kontakt genau dieses
// Mandanten, aktiv, bestätigt; Kanzleiperson mit Zugriff), Code nur
// verschlüsselt und nach dem Versand weg, Meldung erst nach dem Commit, 404 =
// erledigt, keine Doppelzustellung (zweiter Lauf, zwei gleichzeitige
// Einplanungen, zwei gleichzeitige Läufe), einmaliger Admin-Hinweis ohne
// Inhalt, Abschluss als unzustellbar mit Meldung „unzustellbar“ und festem
// Grund (TCMS s6; Wiederholung mit demselben Grund, 409 = erledigt),
// Gültigkeitsfenster, fester Systemakteur je Tenant (unveränderlich, für die
// App-Rolle unsichtbar), nur die drei Nachrichten-Endpunkte. Nie Code, Text,
// Betreff, Titel, Namen oder Adressen im Log.
//
// Fachkatalog: MAIL-OUTBOX-001
// =============================================================================

import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

const enabled = process.env['WORKER_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'WORKER_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { withSystemContext } from '@taxtronik/db';
import { TCMS_MAIL_VORLAGEN } from '@taxtronik/mail/tcms-vorlagen';
import {
  NUR_SYSTEMAKTEUR,
  TcmsClient,
  TcmsKonflikt,
  TcmsNichtGefunden,
  TcmsNichtVerfuegbar,
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
import { postausgangUeber, type TcmsPostausgang } from '../../tcms/dienst';
import { TCMS_SYSTEMAKTEUR_NAME } from '../../tcms/systemakteur';
import { processMailOutbox, type MailOutboxDeliveryDeps } from '../mail-outbox';
import {
  planeTcmsNachrichtEin,
  stelleTcmsNachrichtenZu,
  TCMS_NICHT_VERSENDET_VERWORFEN,
  TCMS_UNZUSTELLBAR_NACH_TAGEN,
  type TcmsZustellDeps,
} from '../tcms-nachrichten';

const describeDb = enabled ? describe : describe.skip;

const vorlagenMigration = readFileSync(
  new URL(
    '../../../../../packages/db/prisma/migrations/20261019150200_tcms_mail_templates/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
/** INSERT der Migration, auf die Tenants dieses Tests begrenzt (parallele Suiten bleiben unberührt). */
const vorlagenInsert = vorlagenMigration
  .slice(vorlagenMigration.indexOf('INSERT INTO'), vorlagenMigration.lastIndexOf('COMMIT;'))
  .trimEnd()
  .replace(/;$/, ' AND t."id" = ANY($1::uuid[]);');
const CODE = '482913';
const TITEL = 'Vertrauliche Beschreibung Talwind';
const BETREFF = 'Betreff mit Geheimnis';
const TEXT = `Ihr Code lautet ${CODE}`;
const PORTAL = 'https://portal.example.test';

/**
 * In-Memory-Postausgang: liefert nicht gemeldete Mitteilungen, zählt
 * Meldungen; „unzustellbar“ wie der Dienst idempotent nur mit demselben Grund.
 */
class Postausgang implements TcmsPostausgang {
  nachrichten: OffeneNachricht[] = [];
  gemeldet = new Set<string>();
  unzustellbarMit = new Map<string, NachrichtUnzustellbarGrund>();
  akteure: TcmsAkteurAngaben[] = [];
  meldenFehler: Error | null = null;
  unzustellbarFehler: Error | null = null;
  beimMelden: ((id: string) => Promise<void>) | null = null;
  holen = vi.fn(async (akteur: TcmsAkteurAngaben, limit: number) => {
    this.akteure.push(akteur);
    return this.nachrichten
      .filter((n) => !this.gemeldet.has(n.id) && !this.unzustellbarMit.has(n.id))
      .slice(0, limit);
  });
  melden = vi.fn(async (akteur: TcmsAkteurAngaben, id: string) => {
    this.akteure.push(akteur);
    await this.beimMelden?.(id);
    if (this.meldenFehler) throw this.meldenFehler;
    if (this.unzustellbarMit.has(id)) throw new TcmsKonflikt({ status: 409 });
    this.gemeldet.add(id);
  });
  unzustellbar = vi.fn(
    async (akteur: TcmsAkteurAngaben, id: string, grund: NachrichtUnzustellbarGrund) => {
      this.akteure.push(akteur);
      await this.beimMelden?.(id);
      if (this.unzustellbarFehler) throw this.unzustellbarFehler;
      const vorher = this.unzustellbarMit.get(id);
      if (this.gemeldet.has(id) || (vorher && vorher !== grund)) {
        throw new TcmsKonflikt({ status: 409 });
      }
      this.unzustellbarMit.set(id, grund);
    },
  );
}

describeDb('TCMS Stufe 4: tcms-nachrichten-zustellen gegen PostgreSQL', () => {
  let tenantId = '';
  let mandantId = '';
  let andererMandantId = '';
  let kontaktId = '';
  let fremdKontaktId = '';
  let adminId = '';
  let bearbeiterId = '';
  let jetzt = new Date();
  let postausgang: Postausgang;
  type LogFn = (obj: Record<string, unknown>, msg: string) => void;
  let log: { info: Mock<LogFn>; warn: Mock<LogFn>; error: Mock<LogFn> };
  let kickMail: Mock<() => void>;

  function deps(p: TcmsPostausgang = postausgang): TcmsZustellDeps {
    return {
      db: prismaOwner,
      runAtomic: (t, fn) => withWorkerTenantContext(t, fn),
      istAktiv: async () => true,
      postausgang: () => p,
      notify: (tx, input, options) => notify(tx, input, options),
      kickMail,
      portalBaseUrl: PORTAL,
      log,
    };
  }

  function lauf(p?: TcmsPostausgang) {
    return stelleTcmsNachrichtenZu(deps(p), { tenantId, jetzt: () => jetzt });
  }

  function code(overrides: Partial<OffeneNachricht> = {}, gueltigBis?: Date): OffeneNachricht {
    return {
      id: `cm${randomBytes(8).toString('hex')}`,
      mandantId,
      empfaengerId: kontaktId,
      empfaengerArt: 'KONTAKT',
      zweck: 'FREIGABE_CODE',
      betreff: BETREFF,
      text: TEXT,
      erstelltAm: jetzt.toISOString(),
      daten: {
        freigabeId: 'cmfreigabe0001',
        art: 'BESCHREIBUNG',
        titel: TITEL,
        version: '1.2',
        code: CODE,
        gueltigBis: (gueltigBis ?? new Date(jetzt.getTime() + 7 * 86_400_000)).toISOString(),
        sha256: 'a'.repeat(64),
      },
      ...overrides,
    } as OffeneNachricht;
  }

  function anforderung(overrides: Partial<OffeneNachricht> = {}): OffeneNachricht {
    return {
      id: `cm${randomBytes(8).toString('hex')}`,
      mandantId,
      empfaengerId: kontaktId,
      empfaengerArt: 'KONTAKT',
      zweck: 'FREIGABE_ANGEFORDERT',
      betreff: BETREFF,
      text: 'Im Portal wartet eine Freigabe.',
      erstelltAm: jetzt.toISOString(),
      daten: { freigabeId: 'cmfreigabe0002', art: 'KENNTNISNAHME', titel: TITEL, version: null },
      ...overrides,
    } as OffeneNachricht;
  }

  function ereignis(empfaengerId: string): OffeneNachricht {
    return {
      id: `cm${randomBytes(8).toString('hex')}`,
      mandantId,
      empfaengerId,
      empfaengerArt: 'KANZLEI',
      zweck: 'EREIGNIS_GEMELDET',
      betreff: BETREFF,
      text: 'Meldung',
      erstelltAm: jetzt.toISOString(),
      daten: {
        ereignisId: 'cmereignis0001',
        nummer: 'E-2026-007',
        titel: 'Neuer Marktplatz',
        typ: 'Sonstiges',
        gemeldetVonId: kontaktId,
      },
    };
  }

  async function zeile(nachrichtId: string) {
    return prismaOwner.tcmsNachrichtZustellung.findFirst({ where: { tenantId, nachrichtId } });
  }

  async function auftraege() {
    return prismaOwner.mailOutbox.findMany({
      where: { tenantId, resourceType: 'tcms_nachricht' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function hinweise(kind: 'TCMS_ZUSTELLUNG_GESCHEITERT' | 'TCMS_EREIGNIS_GEMELDET') {
    return prismaOwner.notification.findMany({ where: { tenantId, kind } });
  }

  /** Kein Code, Text, Betreff, Titel, Name, keine Adresse und keine Personen-ID im Log. */
  function logOhneInhalt() {
    const alles = JSON.stringify([
      ...log.info.mock.calls,
      ...log.warn.mock.calls,
      ...log.error.mock.calls,
    ]);
    for (const verboten of [
      CODE,
      TEXT,
      BETREFF,
      TITEL,
      'Jana',
      'jana@',
      kontaktId,
      fremdKontaktId,
      mandantId,
      bearbeiterId,
    ]) {
      expect(alles).not.toContain(verboten);
    }
  }

  beforeAll(async () => {
    const suffix = randomUUID();
    tenantId = await createTenantFixture(prismaOwner, 'tcms-s4');
    adminId = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `admin-${suffix}@example.test`,
          fullName: 'Anna Roth',
          passwordHash: 'synthetic',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    bearbeiterId = (
      await prismaOwner.staffUser.create({
        data: {
          tenantId,
          email: `leon-${suffix}@example.test`,
          fullName: 'Leon Brandt',
          passwordHash: 'synthetic',
          roles: { create: { role: 'EMPLOYEE' } },
        },
      })
    ).id;
    // Portal und Code-Mails verlangen einen zugelassenen Mandanten (allow_active mit GwG).
    mandantId = await createActiveClientFixture(
      prismaOwner,
      tenantId,
      adminId,
      'Talwind Outdoor GmbH',
    );
    andererMandantId = await createActiveClientFixture(
      prismaOwner,
      tenantId,
      adminId,
      'Seestern GmbH',
    );
    kontaktId = (
      await prismaOwner.clientContact.create({
        data: {
          tenantId,
          clientId: mandantId,
          email: 'jana@talwind.example',
          fullName: 'Jana Weller',
          lastLoginAt: new Date('2026-10-01T08:00:00Z'),
          notificationsEnabled: false,
        },
      })
    ).id;
    fremdKontaktId = (
      await prismaOwner.clientContact.create({
        data: {
          tenantId,
          clientId: andererMandantId,
          email: 'ole@seestern.example',
          fullName: 'Ole Seestern',
          lastLoginAt: new Date('2026-10-01T08:00:00Z'),
        },
      })
    ).id;
  });

  afterAll(async () => {
    // GwG-Prüfungen sind aufbewahrungspflichtig: der Tenant bleibt dann in der Test-DB.
    await deleteTenantFixtures(prismaOwner, [tenantId]);
    await prismaOwner.$disconnect();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    jetzt = new Date();
    postausgang = new Postausgang();
    log = { info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };
    kickMail = vi.fn<() => void>();
    await prismaOwner.mailOutbox.deleteMany({ where: { tenantId } });
    await prismaOwner.notification.deleteMany({ where: { tenantId } });
    await prismaOwner.tcmsNachrichtZustellung.deleteMany({ where: { tenantId } });
    await prismaOwner.clientContact.update({
      where: { id: kontaktId },
      data: {
        active: true,
        lastLoginAt: new Date('2026-10-01T08:00:00Z'),
        email: 'jana@talwind.example',
      },
    });
    await prismaOwner.client.update({
      where: { id: mandantId },
      data: { vertraulich: false, mandateEndedAt: null },
    });
  });

  it('plant den Code an den bestätigten Kontakt ein: nur verschlüsselt, Meldung nach dem Commit', async () => {
    const n = code();
    postausgang.nachrichten = [n];
    let beimMeldenSichtbar = 0;
    // Die Meldung darf erst kommen, wenn die Einplanung für andere sichtbar committet ist.
    postausgang.beimMelden = async () => {
      beimMeldenSichtbar = await prismaOwner.mailOutbox.count({
        where: { tenantId, resourceType: 'tcms_nachricht' },
      });
    };

    const ergebnis = await lauf();

    expect(ergebnis).toMatchObject({ abgerufen: 1, eingeplant: 1, gemeldet: 1, fehler: 0 });
    expect(beimMeldenSichtbar).toBe(1);
    const z = await zeile(n.id);
    expect(z).toMatchObject({ status: 'EINGEPLANT', grund: null, zweck: 'FREIGABE_CODE' });
    expect(z?.gemeldetAm).toBeInstanceOf(Date);
    const [auftrag] = await auftraege();
    expect(auftrag).toMatchObject({
      purpose: 'tcms-freigabe-code',
      resourceType: 'tcms_nachricht',
      resourceId: z!.id,
      clientId: mandantId,
      kind: 'DIRECT',
      status: 'QUEUED',
      staffHref: `/staff/clients/${mandantId}/tcms`,
    });
    // Adresse aus der kanzleikonsole; Code nur verschlüsselt; kein Text des Dienstes.
    const payload = auftrag!.payload as Record<string, unknown>;
    expect(payload['to']).toBe('jana@talwind.example');
    expect(JSON.stringify(payload)).not.toContain(CODE);
    expect(JSON.stringify(payload)).not.toContain(BETREFF);
    expect(JSON.stringify(payload)).not.toContain('Ihr Code lautet');
    expect(auftrag!.secretVarsEnc).toEqual(expect.any(String));
    expect(auftrag!.secretVarsEnc).not.toContain(CODE);
    expect(payload['vars']).toMatchObject({
      contact: { fullName: 'Jana Weller' },
      client: { name: 'Synthetic Talwind Outdoor GmbH' },
      link: `${PORTAL}/portal/tcms/freigaben`,
    });
    expect(postausgang.akteure[0]).toMatchObject({ tnt: tenantId, knd: 'SYSTEM' });
    expect(kickMail).toHaveBeenCalledOnce();
    logOhneInhalt();

    // Versand durch die Mail-Outbox: Code eingesetzt, danach kein Inhalt mehr in der DB.
    const sendTemplateMail = vi.fn().mockResolvedValue({
      ok: true,
      sentViaTemplate: false,
      uncertainFailure: false,
    });
    const outboxDeps: MailOutboxDeliveryDeps = {
      db: prismaOwner,
      runAtomic: (t, fn) => withWorkerTenantContext(t, fn),
      sendTemplateMail,
      notifyClientContacts: vi.fn(),
      loadAttachment: vi.fn(),
      notifyStaff: (tx, input) => notify(tx, input),
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
    await processMailOutbox(outboxDeps, { tenantId, now: new Date() });
    expect(sendTemplateMail).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'tcms-freigabe-code',
        to: 'jana@talwind.example',
        vars: expect.objectContaining({ code: CODE }),
      }),
    );
    const danach = await prismaOwner.mailOutbox.findUniqueOrThrow({ where: { id: auftrag!.id } });
    expect(danach).toMatchObject({ status: 'PROVIDER_ACCEPTED', payload: {}, secretVarsEnc: null });
  });

  it('stellt nie doppelt zu: zweiter Lauf, nicht angekommene Meldung, 404', async () => {
    const n = code();
    postausgang.nachrichten = [n];
    postausgang.meldenFehler = new TcmsNichtVerfuegbar('TRANSPORT');

    const erster = await lauf();
    expect(erster).toMatchObject({ eingeplant: 1, gemeldet: 0, fehler: 1 });
    expect((await zeile(n.id))?.gemeldetAm).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ fehler: 'TcmsNichtVerfuegbar', grund: 'TRANSPORT' }),
      'tcms-nachrichten: Zustellung nicht gemeldet, nächster Lauf',
    );

    // Der Dienst liefert dieselbe Mitteilung erneut: nur melden, nicht neu einplanen.
    postausgang.meldenFehler = new TcmsNichtGefunden({ status: 404 });
    const zweiter = await lauf();
    expect(zweiter).toMatchObject({ eingeplant: 0, gemeldet: 1, fehler: 0 });
    expect(await auftraege()).toHaveLength(1);
    expect((await zeile(n.id))?.gemeldetAm).toBeInstanceOf(Date);
    logOhneInhalt();
  });

  it('zwei gleichzeitige Einplanungen derselben Mitteilung ergeben genau einen Auftrag', async () => {
    const n = code();
    const ergebnisse = await Promise.all([
      planeTcmsNachrichtEin(deps(), tenantId, n, jetzt),
      planeTcmsNachrichtEin(deps(), tenantId, n, jetzt),
      planeTcmsNachrichtEin(deps(), tenantId, n, jetzt),
    ]);
    expect(ergebnisse.filter((e) => e.art === 'eingeplant')).toHaveLength(1);
    expect(ergebnisse.every((e) => ['eingeplant', 'bereits', 'konkurrenz'].includes(e.art))).toBe(
      true,
    );
    expect(await auftraege()).toHaveLength(1);
  });

  it('zwei gleichzeitige Läufe: einer hält den Lease, eine Zustellung', async () => {
    const n = code();
    postausgang.nachrichten = [n];
    const [a, b] = await Promise.all([lauf(), lauf()]);
    expect(a.gesperrt + b.gesperrt).toBeLessThanOrEqual(1);
    expect(a.eingeplant + b.eingeplant).toBe(1);
    expect(await auftraege()).toHaveLength(1);
    // Nach dem Lauf ist der Lease frei.
    const akteur = await prismaOwner.tcmsSystemakteur.findUniqueOrThrow({ where: { tenantId } });
    expect(akteur.laufHalter).toBeNull();
  });

  it.each([
    ['einen Kontakt eines anderen Mandanten', 'KONTAKT_ANDERER_MANDANT'],
    ['einen deaktivierten Kontakt', 'KONTAKT_INAKTIV'],
    ['einen nie angemeldeten Kontakt', 'KONTAKT_UNBESTAETIGT'],
    ['einen unbekannten Kontakt', 'KONTAKT_UNBEKANNT'],
    ['einen unbekannten Mandanten', 'MANDANT_UNBEKANNT'],
    ['einen beendeten Mandanten', 'MANDANT_INAKTIV'],
  ])('stellt nicht an %s zu: zurückgestellt, nicht gemeldet, ein Hinweis', async (_l, grund) => {
    const n = code(
      grund === 'KONTAKT_ANDERER_MANDANT'
        ? { empfaengerId: fremdKontaktId }
        : grund === 'KONTAKT_UNBEKANNT'
          ? { empfaengerId: randomUUID() }
          : grund === 'MANDANT_UNBEKANNT'
            ? { mandantId: randomUUID() }
            : {},
    );
    if (grund === 'KONTAKT_INAKTIV') {
      await prismaOwner.clientContact.update({ where: { id: kontaktId }, data: { active: false } });
    }
    if (grund === 'KONTAKT_UNBESTAETIGT') {
      await prismaOwner.clientContact.update({
        where: { id: kontaktId },
        data: { lastLoginAt: null },
      });
    }
    if (grund === 'MANDANT_INAKTIV') {
      await prismaOwner.client.update({
        where: { id: mandantId },
        data: { mandateEndedAt: jetzt },
      });
    }
    postausgang.nachrichten = [n];

    const erster = await lauf();
    // Gelesen markieren: Ein zweiter Hinweis entstünde sonst neu statt zusammengeführt.
    await prismaOwner.notification.updateMany({ where: { tenantId }, data: { readAt: jetzt } });
    const zweiter = await lauf();

    expect(erster).toMatchObject({ zurueckgestellt: 1, eingeplant: 0, gemeldet: 0 });
    expect(zweiter).toMatchObject({ zurueckgestellt: 1, eingeplant: 0, gemeldet: 0 });
    expect(postausgang.melden).not.toHaveBeenCalled();
    expect(await auftraege()).toHaveLength(0);
    expect(await zeile(n.id)).toMatchObject({ status: 'ZURUECKGESTELLT', grund, gemeldetAm: null });
    // Einmal je Mitteilung, nur an Admin/Partner, ohne Inhalt, Code und Namen.
    const h = await hinweise('TCMS_ZUSTELLUNG_GESCHEITERT');
    expect(h).toHaveLength(1);
    expect(h[0]!.staffId).toBe(adminId);
    const text = JSON.stringify(h);
    for (const verboten of [CODE, TITEL, BETREFF, 'Jana', 'jana@', 'Ole']) {
      expect(text).not.toContain(verboten);
    }
    expect(h[0]!.body).toContain('Bestätigungscode:');
    expect(h[0]!.body).toContain(`nach ${TCMS_UNZUSTELLBAR_NACH_TAGEN} Tagen`);
    logOhneInhalt();
  });

  it('stellt nach Korrektur der Kontaktdaten zu und schließt sonst nach N Tagen ab', async () => {
    await prismaOwner.clientContact.update({
      where: { id: kontaktId },
      data: { lastLoginAt: null },
    });
    const korrigiert = anforderung();
    // Ereignisse haben kein Gültigkeitsfenster: hier greift allein die N-Tage-Frist.
    const nie = ereignis(randomUUID());
    postausgang.nachrichten = [korrigiert, nie];
    expect(await lauf()).toMatchObject({ zurueckgestellt: 2, eingeplant: 0 });
    expect(await auftraege()).toHaveLength(0);

    // Kontakt bestätigt sich (Portal-Anmeldung): der nächste Lauf stellt zu.
    await prismaOwner.clientContact.update({
      where: { id: kontaktId },
      data: { lastLoginAt: jetzt },
    });
    const danach = await lauf();
    expect(danach).toMatchObject({ eingeplant: 1, gemeldet: 1, zurueckgestellt: 1 });
    expect(await zeile(korrigiert.id)).toMatchObject({ status: 'EINGEPLANT', grund: null });
    expect(await auftraege()).toHaveLength(1);

    const start = jetzt.getTime();
    jetzt = new Date(start + TCMS_UNZUSTELLBAR_NACH_TAGEN * 86_400_000 - 60_000);
    expect(await lauf()).toMatchObject({ zurueckgestellt: 1, unzustellbar: 0, gemeldet: 0 });
    jetzt = new Date(start + TCMS_UNZUSTELLBAR_NACH_TAGEN * 86_400_000);
    expect(await lauf()).toMatchObject({ unzustellbar: 1, gemeldet: 1 });
    expect(await zeile(nie.id)).toMatchObject({
      status: 'UNZUSTELLBAR',
      grund: 'PERSON_UNBEKANNT',
    });
    expect((await zeile(nie.id))?.gemeldetAm).toBeInstanceOf(Date);
    // Dem Tax-CMS als unzustellbar gemeldet (fester Grund), nie als zugestellt.
    expect(postausgang.unzustellbar).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ knd: 'SYSTEM' }),
      nie.id,
      'EMPFAENGER_UNGUELTIG',
    );
    expect(postausgang.melden).not.toHaveBeenCalledWith(expect.anything(), nie.id);
    expect(await auftraege()).toHaveLength(1);
    // Je Mitteilung einmal; beide betreffen denselben Mandanten: ein ungelesener Eintrag je Admin.
    expect(await hinweise('TCMS_ZUSTELLUNG_GESCHEITERT')).toHaveLength(1);
    expect(await hinweise('TCMS_EREIGNIS_GEMELDET')).toHaveLength(0);
  });

  it('schließt abgelaufene Mitteilungen ohne Versand ab und meldet sie', async () => {
    const abgelaufenerCode = code({}, new Date(jetzt.getTime() - 1_000));
    const alteAnforderung = anforderung({
      erstelltAm: new Date(jetzt.getTime() - 8 * 86_400_000).toISOString(),
    });
    postausgang.nachrichten = [abgelaufenerCode, alteAnforderung];

    const ergebnis = await lauf();

    expect(ergebnis).toMatchObject({ unzustellbar: 2, gemeldet: 2, eingeplant: 0 });
    expect(await auftraege()).toHaveLength(0);
    for (const n of [abgelaufenerCode, alteAnforderung]) {
      expect(await zeile(n.id)).toMatchObject({ status: 'UNZUSTELLBAR', grund: 'ABGELAUFEN' });
      expect(postausgang.unzustellbarMit.get(n.id)).toBe('ABGELAUFEN');
    }
    expect(postausgang.melden).not.toHaveBeenCalled();
    const [h] = await hinweise('TCMS_ZUSTELLUNG_GESCHEITERT');
    expect(h?.body).toContain('Sie wird nicht zugestellt.');
    expect(JSON.stringify(h)).not.toContain(CODE);
  });

  it('unzustellbar: Grund steht vor dem Senden fest, Wiederholung mit demselben Grund', async () => {
    await prismaOwner.clientContact.update({
      where: { id: kontaktId },
      data: { lastLoginAt: null },
    });
    // Code mit langer Gültigkeit: Abschluss nach N Tagen wegen des Empfängers, nicht der Frist.
    const n = code({}, new Date(jetzt.getTime() + 30 * 86_400_000));
    postausgang.nachrichten = [n];
    expect(await lauf()).toMatchObject({ zurueckgestellt: 1 });
    const start = jetzt.getTime();
    jetzt = new Date(start + TCMS_UNZUSTELLBAR_NACH_TAGEN * 86_400_000);
    let sichtbar: unknown = null;
    // Gemeldet wird erst, wenn der Abschluss mit Grund committet ist.
    postausgang.beimMelden = async (id) => {
      sichtbar = await prismaOwner.tcmsNachrichtZustellung.findFirst({
        where: { tenantId, nachrichtId: id },
        select: { status: true, grund: true },
      });
    };
    postausgang.unzustellbarFehler = new TcmsNichtVerfuegbar('TRANSPORT');
    expect(await lauf()).toMatchObject({ unzustellbar: 1, gemeldet: 0, fehler: 1 });
    expect(sichtbar).toEqual({ status: 'UNZUSTELLBAR', grund: 'KONTAKT_UNBESTAETIGT' });
    expect((await zeile(n.id))?.gemeldetAm).toBeNull();

    // Inzwischen gehört der Kontakt zu einem anderen Mandanten: Der nächste Lauf
    // prüft nicht neu, sondern meldet denselben Grund wie beim ersten Versuch.
    await prismaOwner.clientContact.update({
      where: { id: kontaktId },
      data: { clientId: andererMandantId },
    });
    postausgang.unzustellbarFehler = null;
    try {
      expect(await lauf()).toMatchObject({ unzustellbar: 0, gemeldet: 1, fehler: 0 });
    } finally {
      await prismaOwner.clientContact.update({
        where: { id: kontaktId },
        data: { clientId: mandantId },
      });
    }
    expect(postausgang.unzustellbar.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [n.id, 'KEIN_PORTALZUGANG'],
      [n.id, 'KEIN_PORTALZUGANG'],
    ]);
    expect(postausgang.melden).not.toHaveBeenCalled();
    expect((await zeile(n.id))?.gemeldetAm).toBeInstanceOf(Date);
    expect(await auftraege()).toHaveLength(0);
    logOhneInhalt();
  });

  it('409 bei „unzustellbar“ (im Tax-CMS schon abgeschlossen) gilt als erledigt, Log ohne Inhalt', async () => {
    const n = code({}, new Date(jetzt.getTime() - 1_000));
    postausgang.nachrichten = [n];
    // Der Dienst kennt die Nachricht schon als abgeschlossen (z. B. Meldung eines früheren Laufs).
    postausgang.unzustellbarFehler = new TcmsKonflikt({ status: 409, requestId: 'req-409' });

    expect(await lauf()).toMatchObject({ unzustellbar: 1, gemeldet: 1, fehler: 0 });
    expect((await zeile(n.id))?.gemeldetAm).toBeInstanceOf(Date);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        meldung: 'UNZUSTELLBAR',
        fehler: 'TcmsKonflikt',
        status: 409,
        tcmsRequestId: 'req-409',
      }),
      'tcms-nachrichten: Mitteilung im Tax-CMS bereits abgeschlossen',
    );
    expect(log.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'tcms-nachrichten: Zustellung nicht gemeldet, nächster Lauf',
    );
    // Ein weiterer Lauf ohne die Mitteilung meldet nichts erneut.
    postausgang.nachrichten = [];
    await lauf();
    expect(postausgang.unzustellbar).toHaveBeenCalledOnce();
    logOhneInhalt();
  });

  it('409 bei „zugestellt“ (TCMS s8: verworfen, bevor ausgeliefert): erledigt, nicht wiederholt, nicht versendet', async () => {
    const n = code();
    postausgang.nachrichten = [n];
    postausgang.meldenFehler = new TcmsKonflikt({ status: 409, requestId: 'req-409z' });

    expect(await lauf()).toMatchObject({ eingeplant: 1, gemeldet: 1, fehler: 0 });
    expect((await zeile(n.id))?.gemeldetAm).toBeInstanceOf(Date);
    // Der wartende Auftrag endet ohne Versand; Inhalt und Code sind entfernt.
    const [auftrag] = await auftraege();
    expect(auftrag).toMatchObject({
      status: 'SKIPPED',
      payload: {},
      secretVarsEnc: null,
      lastError: TCMS_NICHT_VERSENDET_VERWORFEN,
    });
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ meldung: 'ZUGESTELLT', fehler: 'TcmsKonflikt', status: 409 }),
      'tcms-nachrichten: Mitteilung im Tax-CMS bereits abgeschlossen',
    );
    const sendTemplateMail = vi.fn();
    await processMailOutbox(
      {
        db: prismaOwner,
        runAtomic: (t, fn) => withWorkerTenantContext(t, fn),
        sendTemplateMail,
        notifyClientContacts: vi.fn(),
        loadAttachment: vi.fn(),
        notifyStaff: (tx, input) => notify(tx, input),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      { tenantId, now: new Date() },
    );
    expect(sendTemplateMail).not.toHaveBeenCalled();
    // Weitere Läufe melden nichts erneut und planen nichts neu ein.
    postausgang.nachrichten = [];
    expect(await lauf()).toMatchObject({ eingeplant: 0, gemeldet: 0, fehler: 0 });
    expect(postausgang.melden).toHaveBeenCalledOnce();
    expect(await auftraege()).toHaveLength(1);
    logOhneInhalt();
  });

  it('409 bei „zugestellt“ lässt einen bereits laufenden oder angenommenen Versand unberührt', async () => {
    const n = code();
    postausgang.nachrichten = [n];
    // Erster Lauf: Meldung scheitert vorübergehend; der Auftrag wird inzwischen versendet.
    postausgang.meldenFehler = new TcmsNichtVerfuegbar('TRANSPORT');
    await lauf();
    const [auftrag] = await auftraege();
    await prismaOwner.mailOutbox.update({
      where: { id: auftrag!.id },
      data: { status: 'PROVIDER_ACCEPTED', payload: {}, secretVarsEnc: null, nextAttemptAt: null },
    });
    postausgang.meldenFehler = new TcmsKonflikt({ status: 409 });
    expect(await lauf()).toMatchObject({ eingeplant: 0, gemeldet: 1, fehler: 0 });
    expect(await auftraege()).toEqual([expect.objectContaining({ status: 'PROVIDER_ACCEPTED' })]);
  });

  it('meldet ein Ereignis nur der Kanzleiperson mit Zugriff (Nummer und Titel)', async () => {
    const zuBearbeiter = ereignis(bearbeiterId);
    postausgang.nachrichten = [zuBearbeiter];
    expect(await lauf()).toMatchObject({ eingeplant: 1, gemeldet: 1 });
    const [h] = await hinweise('TCMS_EREIGNIS_GEMELDET');
    expect(h).toMatchObject({
      staffId: bearbeiterId,
      clientId: mandantId,
      title: 'Ereignis im Tax-CMS gemeldet',
      body: 'E-2026-007 · Neuer Marktplatz',
      href: `/staff/clients/${mandantId}/tcms/ereignisse`,
    });
    expect(kickMail).not.toHaveBeenCalled();

    // Vertraulicher Mandant ohne Zuständigkeit: kein Zugriff, keine Zustellung.
    await prismaOwner.client.update({ where: { id: mandantId }, data: { vertraulich: true } });
    const ohneZugriff = ereignis(bearbeiterId);
    postausgang.nachrichten = [ohneZugriff];
    expect(await lauf()).toMatchObject({ zurueckgestellt: 1, gemeldet: 0 });
    expect(await zeile(ohneZugriff.id)).toMatchObject({ grund: 'PERSON_OHNE_ZUGRIFF' });
    expect(await hinweise('TCMS_EREIGNIS_GEMELDET')).toHaveLength(1);
    // Ein Kontakt ist keine Kanzleiperson.
    const anKontakt = ereignis(kontaktId);
    postausgang.nachrichten = [anKontakt];
    await lauf();
    expect(await zeile(anKontakt.id)).toMatchObject({ grund: 'PERSON_UNBEKANNT' });
  });

  it('der Systemakteur ist fest je Tenant, unveränderlich und für die App-Rolle unsichtbar', async () => {
    postausgang.nachrichten = [];
    await lauf();
    await lauf();
    const akteur = await prismaOwner.tcmsSystemakteur.findUniqueOrThrow({ where: { tenantId } });
    expect(akteur.akteurId).not.toBe(tenantId);
    expect(postausgang.akteure).toHaveLength(2);
    for (const a of postausgang.akteure) {
      expect(a).toEqual({
        tnt: tenantId,
        sub: akteur.akteurId,
        knd: 'SYSTEM',
        nam: TCMS_SYSTEMAKTEUR_NAME,
      });
    }
    await expect(
      prismaOwner.tcmsSystemakteur.update({
        where: { tenantId },
        data: { akteurId: randomUUID() },
      }),
    ).rejects.toThrow(/TCMS_SYSTEMAKTEUR_UNVERAENDERLICH/);
    // Die Web-App (App-Rolle) kann den Systemakteur nicht lesen.
    await expect(
      withSystemContext(tenantId, (tx) => tx.tcmsSystemakteur.findMany()),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withSystemContext(tenantId, (tx) => tx.tcmsNachrichtZustellung.findMany()),
    ).rejects.toThrow(/permission denied/i);
  });

  it('die Datenbank lässt keinen zweiten Auftrag je Mitteilung und keinen Code nach Endstatus zu', async () => {
    const n = code();
    postausgang.nachrichten = [n];
    await lauf();
    const [auftrag] = await auftraege();
    await expect(
      prismaOwner.mailOutbox.create({
        data: {
          tenantId,
          clientId: mandantId,
          kind: 'DIRECT',
          purpose: 'tcms-freigabe-code',
          resourceType: 'tcms_nachricht',
          resourceId: auftrag!.resourceId,
          staffHref: `/staff/clients/${mandantId}/tcms`,
          payload: {},
        },
      }),
    ).rejects.toThrow();
    await expect(
      prismaOwner.mailOutbox.update({
        where: { id: auftrag!.id },
        data: { status: 'FAILED', nextAttemptAt: null },
      }),
    ).rejects.toThrow(/mail_outbox_tcms_content_check/);
  });

  it('ruft über den echten Client nur die drei Nachrichten-Endpunkte mit dem Systemakteur', async () => {
    const n = code();
    const abgelaufen = code({}, new Date(jetzt.getTime() - 1_000));
    const targets: string[] = [];
    const bodies: string[] = [];
    const claims: Array<Record<string, unknown>> = [];
    const server: Server = createServer((req, res) => {
      targets.push(`${req.method} ${req.url}`);
      const token = String(req.headers['x-tcms-akteur'] ?? '');
      claims.push(JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')));
      const teile: Buffer[] = [];
      req.on('data', (c: Buffer) => teile.push(c));
      req.on('end', () => {
        bodies.push(Buffer.concat(teile).toString('utf8'));
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') {
          res.end(JSON.stringify({ ok: true, daten: { nachrichten: [n, abgelaufen] } }));
        } else if (req.url?.endsWith('/unzustellbar')) {
          res.end(
            JSON.stringify({
              ok: true,
              daten: { nachrichtId: abgelaufen.id, unzustellbar: true, grund: 'ABGELAUFEN' },
            }),
          );
        } else {
          res.end(JSON.stringify({ ok: true, daten: { nachrichtId: n.id, zugestellt: true } }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { port } = server.address() as AddressInfo;
      const client = new TcmsClient({
        config: {
          url: `http://127.0.0.1:${port}`,
          serviceToken: randomBytes(32).toString('base64url'),
          actorKeyId: 'kk-test',
          actorPrivateKey: generateKeyPairSync('ed25519').privateKey,
        },
        akteurArten: NUR_SYSTEMAKTEUR,
      });
      expect(await lauf(postausgangUeber(client))).toMatchObject({
        eingeplant: 1,
        unzustellbar: 1,
        gemeldet: 2,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(targets).toEqual([
      'GET /v1/nachrichten/offen?limit=50',
      `POST /v1/nachrichten/${n.id}/zugestellt`,
      `POST /v1/nachrichten/${abgelaufen.id}/unzustellbar`,
    ]);
    expect(bodies.slice(1)).toEqual(['', JSON.stringify({ grund: 'ABGELAUFEN' })]);
    const akteur = await prismaOwner.tcmsSystemakteur.findUniqueOrThrow({ where: { tenantId } });
    for (const c of claims) {
      expect(c).toMatchObject({ knd: 'SYSTEM', tnt: tenantId, sub: akteur.akteurId });
      expect(c).not.toHaveProperty('rol');
      expect(c).not.toHaveProperty('cli');
    }
  });

  it('seedet die System-Vorlagen gleichlautend mit dem Ersatztext, idempotent', async () => {
    await prismaOwner.$transaction(async (tx) => {
      expect(await tx.$executeRawUnsafe(vorlagenInsert, [tenantId])).toBe(3);
      expect(await tx.$executeRawUnsafe(vorlagenInsert, [tenantId])).toBe(0);
    });
    try {
      const seeded = await prismaOwner.emailTemplate.findMany({
        where: { tenantId, slug: { startsWith: 'tcms-' } },
        select: {
          slug: true,
          name: true,
          subject: true,
          bodyMd: true,
          category: true,
          active: true,
        },
        orderBy: { slug: 'asc' },
      });
      expect(seeded).toEqual(
        Object.values(TCMS_MAIL_VORLAGEN)
          .map((v) => ({
            slug: v.slug,
            name: v.name,
            subject: v.subject,
            bodyMd: v.bodyMd,
            category: 'System',
            active: true,
          }))
          .sort((a, b) => (a.slug < b.slug ? -1 : 1)),
      );
      for (const v of seeded) expect(v.subject).not.toContain('{{code}}');
    } finally {
      await prismaOwner.emailTemplate.deleteMany({ where: { tenantId } });
    }
  });
});
