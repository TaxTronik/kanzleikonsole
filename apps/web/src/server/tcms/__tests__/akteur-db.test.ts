// Fachkatalog: ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001, GWG-RISK-REVIEW-001
// TCMS Stufe 2: Akteursabbildung kanzleikonsole → TCMS gegen echtes PostgreSQL
// über die App-Rolle (RLS). Jede Regel positiv und negativ: Mandantenbezug nur
// mit Zugriff nach den Regeln der kanzleikonsole (OPEN/RESTRICTED/vertraulich),
// bt/hb aus den Zuständigkeiten, Rollen und Qualifikation frisch aus der DB,
// deaktivierte/gesperrte Personen, abgelaufene/veraltete Sitzungen, fremder
// Tenant, Portal-Kontakte nur mit Portalzugang beim eigenen Mandanten, Listen
// deckungsgleich mit den Einzelprüfungen. Nur die Request-Authentisierung
// (Cookie/JWT) fehlt; sie liefert in Produktion die geprüfte Sitzung.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TxClient } from '@taxtronik/db';
import { canStaffAccessClientTx } from '@taxtronik/db/staff-client-access';
import { AkteurClaimsSchema, MAX_MANDANTEN_JE_ANFRAGE } from '@taxtronik/tcms-contract';
import type { TcmsAkteurAngaben } from '@taxtronik/tcms-client';
import type { StaffSession } from '@/server/auth/staff';
import type { PortalSession } from '@/server/auth/portal';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { canStaffReviewGwgTx } from '@/server/gwg/professional-review';
import {
  TcmsAkteurVerweigert,
  kanzleiAkteurTx,
  kanzleiMandantenListeTx,
  portalAkteurTx,
  type TcmsVerweigerungsGrund,
} from '../akteur';

// Quality hat Platzhalter-URLs, aber keine Datenbank: lokal TCMS_AKTEUR_DB_TEST=1,
// im db-CI-Job DB_TESTS=1. In CI scheitert die Suite ohne Opt-in.
const enabled = process.env.TCMS_AKTEUR_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_AKTEUR_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`TCMS_AKTEUR_DB_TEST requires a valid ${name}.`);
    }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname.length < 2) {
      throw new Error(`TCMS_AKTEUR_DB_TEST requires a PostgreSQL ${name}.`);
    }
  }
}

const IN_EINER_STUNDE = () => new Date(Date.now() + 3_600_000).toISOString();

type Rolle = 'EMPLOYEE' | 'PARTNER' | 'ADMIN';

(enabled ? describe : describe.skip)('TCMS-Akteursabbildung (TCMS Stufe 2)', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  const tenants: string[] = [];
  let tenantId = '';
  let fremderTenant = '';
  const staff: Record<string, { id: string; roles: Rolle[] }> = {};
  const mandant: Record<string, string> = {};
  const kontakt: Record<string, { id: string; clientId: string; email: string }> = {};

  async function neuerTenant(name: string): Promise<string> {
    const id = (await owner.tenant.create({ data: { slug: `tcms-akteur-${randomUUID()}`, name } }))
      .id;
    tenants.push(id);
    return id;
  }

  async function person(
    key: string,
    tenant: string,
    roles: Rolle[],
    daten: { isProfessional?: boolean; active?: boolean; lockedUntil?: Date } = {},
  ) {
    const id = (
      await owner.staffUser.create({
        data: {
          tenantId: tenant,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: `  Person ${key}  `,
          passwordHash: 'synthetic',
          roles: { create: roles.map((role) => ({ role })) },
          ...daten,
        },
      })
    ).id;
    staff[key] = { id, roles };
  }

  beforeAll(async () => {
    tenantId = await neuerTenant('TCMS Akteur');
    fremderTenant = await neuerTenant('TCMS Akteur fremd');
    await person('admin', tenantId, ['ADMIN'], { isProfessional: true });
    await person('partner', tenantId, ['PARTNER']);
    await person('bt', tenantId, ['EMPLOYEE'], { isProfessional: true });
    await person('hb', tenantId, ['EMPLOYEE']);
    await person('mitarbeiter', tenantId, ['EMPLOYEE']);
    await person('ohneQualifikation', tenantId, ['EMPLOYEE']);
    await person('inaktiv', tenantId, ['ADMIN'], { active: false });
    await person('gesperrt', tenantId, ['ADMIN'], {
      lockedUntil: new Date(Date.now() + 3_600_000),
    });
    await person('fremd', fremderTenant, ['ADMIN'], { isProfessional: true });

    const neu = async (key: string, tenant: string, vertraulich: boolean) => {
      mandant[key] = (
        await owner.client.create({
          data: { tenantId: tenant, kind: 'JURPERS', name: `Mandant ${key}`, vertraulich },
        })
      ).id;
    };
    await neu('offen', tenantId, false);
    await neu('vertraulich', tenantId, true);
    await neu('zugeordnet', tenantId, true);
    await neu('fremd', fremderTenant, false);
    const zuordnung = (staffKey: string, role: 'BERUFSTRAEGER' | 'HAUPTBEARBEITER' | 'VERTRETER') =>
      owner.clientResponsibility.create({
        data: { tenantId, clientId: mandant.zugeordnet!, staffId: staff[staffKey]!.id, role },
      });
    await zuordnung('bt', 'BERUFSTRAEGER');
    await zuordnung('hb', 'HAUPTBEARBEITER');
    // Zuordnung als Berufsträger ohne (noch gültige) Qualifikation, z. B. nach
    // Widerruf: zählt für den Zugriff, aber nicht als zuständige Berufsträgerin.
    await zuordnung('ohneQualifikation', 'BERUFSTRAEGER');
    await zuordnung('mitarbeiter', 'VERTRETER');

    // Portal: zugelassene Mandanten brauchen eine verifizierte GwG-Prüfung.
    for (const key of ['offen', 'fremd'] as const) {
      const tenant = key === 'fremd' ? fremderTenant : tenantId;
      await createVerifiedLegalEntityGwgFixture(owner as never, {
        tenantId: tenant,
        clientId: mandant[key]!,
        verifiedBy: staff[key === 'fremd' ? 'fremd' : 'admin']!.id,
        registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
      });
      await owner.client.update({ where: { id: mandant[key]! }, data: { allowActive: true } });
    }
    const neuerKontakt = async (key: string, tenant: string, clientKey: string, active = true) => {
      const email = `${key}-${randomUUID()}@example.test`;
      const c = await owner.clientContact.create({
        data: {
          tenantId: tenant,
          clientId: mandant[clientKey]!,
          email,
          fullName: `Kontakt ${key}`,
          active,
        },
      });
      kontakt[key] = { id: c.id, clientId: mandant[clientKey]!, email };
    };
    await neuerKontakt('aktiv', tenantId, 'offen');
    await neuerKontakt('inaktiv', tenantId, 'offen', false);
    await neuerKontakt('nichtZugelassen', tenantId, 'vertraulich');
    await neuerKontakt('fremd', fremderTenant, 'fremd');
  });

  afterAll(async () => {
    try {
      for (const id of tenants) await owner.tenant.delete({ where: { id } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  });

  async function setzeModus(mode: 'OPEN' | 'RESTRICTED') {
    await owner.tenantSetting.upsert({
      where: { tenantId_key: { tenantId, key: 'access' } },
      create: { tenantId, key: 'access', value: { clientAccessMode: mode } },
      update: { value: { clientAccessMode: mode } },
    });
  }

  function sitzung(
    key: string,
    aenderung: { tenantId?: string; roles?: string[]; expires?: string } = {},
  ): StaffSession {
    const s = staff[key]!;
    return {
      user: {
        id: s.id,
        email: `${key}@example.test`,
        name: key,
        fullName: key,
        tenantId: aenderung.tenantId ?? (key === 'fremd' ? fremderTenant : tenantId),
        staffId: s.id,
        roles: aenderung.roles ?? s.roles,
        permissions: [],
      },
      expires: aenderung.expires ?? IN_EINER_STUNDE(),
    } as StaffSession;
  }

  function portalSitzung(
    key: string,
    aenderung: { tenantId?: string; clientId?: string; email?: string; expires?: string } = {},
  ): PortalSession {
    const k = kontakt[key]!;
    return {
      user: {
        id: k.id,
        email: aenderung.email ?? k.email,
        name: key,
        fullName: key,
        tenantId: aenderung.tenantId ?? (key === 'fremd' ? fremderTenant : tenantId),
        contactId: k.id,
        clientId: aenderung.clientId ?? k.clientId,
        sessionIssuedAt: 0,
        sessionOriginContactId: k.id,
      },
      expires: aenderung.expires ?? IN_EINER_STUNDE(),
    } as PortalSession;
  }

  /** Transaktion der App-Rolle im Tenant-Kontext, wie withTenantContext. */
  function imTenant<T>(
    tenant: string,
    actor: { id: string; type: 'STAFF' | 'CLIENT_CONTACT' },
    run: (tx: TxClient) => Promise<T>,
  ): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true),
        set_config('app.current_actor_id', ${actor.id}, true),
        set_config('app.current_actor_type', ${actor.type}, true)`;
      return run(tx as TxClient);
    });
  }

  function kanzlei(s: StaffSession, mandantId?: string) {
    return imTenant(s.user.tenantId, { id: s.user.staffId, type: 'STAFF' }, (tx) =>
      kanzleiAkteurTx(tx, s, mandantId === undefined ? {} : { mandantId }),
    );
  }

  function liste(s: StaffSession) {
    return imTenant(s.user.tenantId, { id: s.user.staffId, type: 'STAFF' }, (tx) =>
      kanzleiMandantenListeTx(tx, s),
    );
  }

  function portal(s: PortalSession) {
    return imTenant(s.user.tenantId, { id: s.user.contactId, type: 'CLIENT_CONTACT' }, (tx) =>
      portalAkteurTx(tx, s),
    );
  }

  async function grund(p: Promise<unknown>): Promise<TcmsVerweigerungsGrund> {
    try {
      await p;
    } catch (error) {
      expect(error).toBeInstanceOf(TcmsAkteurVerweigert);
      expect((error as Error).message).toBe('Kein Zugriff auf das Tax-CMS.');
      return (error as TcmsAkteurVerweigert).grund;
    }
    throw new Error('keine Verweigerung');
  }

  /** Die Abbildung erfüllt das strikte Claims-Schema des Vertrags. */
  function vertragsgemaess(akteur: TcmsAkteurAngaben) {
    const jetzt = Math.floor(Date.now() / 1000);
    return AkteurClaimsSchema.safeParse({
      ...akteur,
      iss: 'kanzleikonsole',
      aud: 'tcms',
      iat: jetzt,
      exp: jetzt + 30,
      jti: 'a'.repeat(32),
      req: { m: 'GET', p: '/v1/ich', b: 'b'.repeat(43) },
    }).success;
  }

  describe('Kanzleiperson', () => {
    it('bildet Tenant, Person, Name und Rollen aus dem aktuellen Datenbestand ab', async () => {
      await setzeModus('OPEN');
      const admin = await kanzlei(sitzung('admin'));
      expect(admin).toEqual({
        tnt: tenantId,
        sub: staff.admin!.id,
        knd: 'KANZLEI',
        nam: 'Person admin',
        rol: { adm: true, bt: true },
      });
      expect(vertragsgemaess(admin)).toBe(true);
      expect((await kanzlei(sitzung('partner'))).rol).toEqual({ adm: true, bt: false });
      expect((await kanzlei(sitzung('bt'))).rol).toEqual({ adm: false, bt: true });
      expect((await kanzlei(sitzung('mitarbeiter'))).rol).toEqual({ adm: false, bt: false });
    });

    it('setzt cli nur mit Mandantenzugriff (OPEN: nicht vertraulich oder Zuordnung)', async () => {
      await setzeModus('OPEN');
      const akteur = await kanzlei(sitzung('mitarbeiter'), mandant.offen);
      expect(akteur.cli).toEqual({ id: mandant.offen, bt: false, hb: false });
      expect(vertragsgemaess(akteur)).toBe(true);
      // Vertraulich ohne Zuordnung, auch mit VERTRETER-Zuordnung: kein Zugriff.
      expect(await grund(kanzlei(sitzung('mitarbeiter'), mandant.vertraulich))).toBe(
        'KEIN_MANDANTENZUGRIFF',
      );
      expect(await grund(kanzlei(sitzung('mitarbeiter'), mandant.zugeordnet))).toBe(
        'KEIN_MANDANTENZUGRIFF',
      );
      // Admin/Partner sehen auch vertrauliche Mandanten (ohne Zuständigkeit).
      expect((await kanzlei(sitzung('partner'), mandant.vertraulich)).cli).toEqual({
        id: mandant.vertraulich,
        bt: false,
        hb: false,
      });
    });

    it('RESTRICTED: cli nur mit Zuordnung als Berufsträger oder Hauptbearbeitung', async () => {
      await setzeModus('RESTRICTED');
      try {
        expect(await grund(kanzlei(sitzung('mitarbeiter'), mandant.offen))).toBe(
          'KEIN_MANDANTENZUGRIFF',
        );
        expect((await kanzlei(sitzung('hb'), mandant.zugeordnet)).cli?.id).toBe(mandant.zugeordnet);
        expect((await kanzlei(sitzung('admin'), mandant.offen)).cli?.id).toBe(mandant.offen);
      } finally {
        await setzeModus('OPEN');
      }
    });

    it('bt nur für die aktuell qualifizierte zuständige Berufsträgerin, hb für die Hauptbearbeitung', async () => {
      await setzeModus('OPEN');
      expect((await kanzlei(sitzung('bt'), mandant.zugeordnet)).cli).toEqual({
        id: mandant.zugeordnet,
        bt: true,
        hb: false,
      });
      expect((await kanzlei(sitzung('hb'), mandant.zugeordnet)).cli).toEqual({
        id: mandant.zugeordnet,
        bt: false,
        hb: true,
      });
      // Zuordnung BERUFSTRAEGER ohne Qualifikation: Zugriff ja, bt nein.
      expect((await kanzlei(sitzung('ohneQualifikation'), mandant.zugeordnet)).cli).toEqual({
        id: mandant.zugeordnet,
        bt: false,
        hb: false,
      });
      // Admin ohne Zuordnung: Zugriff, aber weder bt noch hb.
      expect((await kanzlei(sitzung('admin'), mandant.zugeordnet)).cli).toEqual({
        id: mandant.zugeordnet,
        bt: false,
        hb: false,
      });
    });

    it('verweigert deaktivierte und gesperrte Personen sowie abgelaufene Sitzungen', async () => {
      expect(await grund(kanzlei(sitzung('inaktiv')))).toBe('PERSON_INAKTIV');
      expect(await grund(kanzlei(sitzung('gesperrt'), mandant.offen))).toBe('PERSON_GESPERRT');
      expect(
        await grund(
          kanzlei(sitzung('admin', { expires: new Date(Date.now() - 1000).toISOString() })),
        ),
      ).toBe('SITZUNG_ABGELAUFEN');
      expect(await grund(kanzlei(sitzung('admin', { expires: 'nie' })))).toBe('SITZUNG_ABGELAUFEN');
    });

    it('bestätigt keine Rollen, die die Sitzung behauptet, die DB aber nicht kennt', async () => {
      // Veraltete oder manipulierte Sitzung: Mitarbeiter mit ADMIN-Rolle in der Sitzung.
      expect(await grund(kanzlei(sitzung('mitarbeiter', { roles: ['ADMIN'] })))).toBe(
        'SITZUNG_VERALTET',
      );
      expect(
        await grund(kanzlei(sitzung('mitarbeiter', { roles: ['ADMIN'] }), mandant.vertraulich)),
      ).toBe('SITZUNG_VERALTET');
      // Umgekehrt (Rolle in der DB, nicht in der Sitzung): ebenfalls neu anmelden.
      expect(await grund(kanzlei(sitzung('admin', { roles: ['EMPLOYEE'] })))).toBe(
        'SITZUNG_VERALTET',
      );
    });

    it('Tenant-Wechsel: keine Person, kein Mandant eines anderen Tenants', async () => {
      // Person aus Tenant B mit Sitzung für Tenant A (und umgekehrt).
      expect(await grund(kanzlei(sitzung('fremd', { tenantId })))).toBe('PERSON_INAKTIV');
      expect(await grund(kanzlei(sitzung('admin', { tenantId: fremderTenant })))).toBe(
        'PERSON_INAKTIV',
      );
      // Admin aus Tenant A, Mandant aus Tenant B: kein cli, auch nicht für Admins.
      expect(await grund(kanzlei(sitzung('admin'), mandant.fremd))).toBe('KEIN_MANDANTENZUGRIFF');
      expect(await grund(kanzlei(sitzung('admin'), randomUUID()))).toBe('KEIN_MANDANTENZUGRIFF');
      expect(await grund(kanzlei(sitzung('admin'), 'kein-uuid'))).toBe('KEIN_MANDANTENZUGRIFF');
      expect(await grund(kanzlei({ user: { tenantId: 'x' } } as StaffSession))).toBe(
        'SITZUNG_UNGUELTIG',
      );
    });
  });

  describe('Mandantenliste (mandantenübergreifende Lesepfade)', () => {
    it.each(['admin', 'partner', 'bt', 'hb', 'mitarbeiter', 'ohneQualifikation'])(
      '%s: Liste, bt und hb deckungsgleich mit den Einzelprüfungen der kanzleikonsole',
      async (key) => {
        for (const mode of ['OPEN', 'RESTRICTED'] as const) {
          await setzeModus(mode);
          const s = sitzung(key);
          const { akteur, liste: l } = await liste(s);
          expect(akteur.cli).toBeUndefined();
          expect(vertragsgemaess(akteur)).toBe(true);
          const erwartet = await imTenant(
            tenantId,
            { id: s.user.staffId, type: 'STAFF' },
            async (tx) => {
              const alle = Object.values(mandant).sort();
              const ids: string[] = [];
              const bt: string[] = [];
              const hb: string[] = [];
              for (const id of alle) {
                if (!(await canStaffAccessClientTx(tx, tenantId, s.user.staffId, id))) continue;
                ids.push(id);
                const eingabe = { tenantId, clientId: id, staffId: s.user.staffId };
                if (await canStaffReviewGwgTx(tx, eingabe)) bt.push(id);
                const h = await tx.clientResponsibility.findFirst({
                  where: { ...eingabe, role: 'HAUPTBEARBEITER' },
                });
                if (h) hb.push(id);
              }
              return { mandantIds: ids, bt, hb };
            },
          );
          expect(l, `${key} ${mode}`).toEqual(erwartet);
          expect(l.mandantIds).not.toContain(mandant.fremd);
        }
        await setzeModus('OPEN');
      },
    );

    it('verweigert dieselben Personen und Sitzungen wie der Einzelakteur', async () => {
      expect(await grund(liste(sitzung('inaktiv')))).toBe('PERSON_INAKTIV');
      expect(await grund(liste(sitzung('gesperrt')))).toBe('PERSON_GESPERRT');
      expect(await grund(liste(sitzung('mitarbeiter', { roles: ['ADMIN'] })))).toBe(
        'SITZUNG_VERALTET',
      );
    });

    it(`kürzt nicht still: mehr als ${MAX_MANDANTEN_JE_ANFRAGE} Mandanten → keine Bestätigung`, async () => {
      const gross = await neuerTenant('TCMS Akteur groß');
      await person('grossAdmin', gross, ['ADMIN']);
      const daten = Array.from({ length: MAX_MANDANTEN_JE_ANFRAGE }, (_, i) => ({
        tenantId: gross,
        kind: 'NATPERS' as const,
        name: `M ${i}`,
      }));
      await owner.client.createMany({ data: daten });
      const s = sitzung('grossAdmin', { tenantId: gross });
      expect((await liste(s)).liste.mandantIds).toHaveLength(MAX_MANDANTEN_JE_ANFRAGE);
      await owner.client.create({
        data: { tenantId: gross, kind: 'NATPERS', name: 'eins zu viel' },
      });
      expect(await grund(liste(s))).toBe('ZU_VIELE_MANDANTEN');
    });
  });

  describe('Mandantenkontakt (Portal)', () => {
    it('bildet aktive Kontakte mit Portalzugang auf knd MANDANT beim eigenen Mandanten ab', async () => {
      const akteur = await portal(portalSitzung('aktiv'));
      expect(akteur).toEqual({
        tnt: tenantId,
        sub: kontakt.aktiv!.id,
        knd: 'MANDANT',
        nam: 'Kontakt aktiv',
        cli: { id: mandant.offen, bt: false, hb: false },
      });
      expect(vertragsgemaess(akteur)).toBe(true);
    });

    it('verweigert inaktive Kontakte, nicht zugelassene Mandanten und fremde Mandanten', async () => {
      expect(await grund(portal(portalSitzung('inaktiv')))).toBe('KEIN_PORTALZUGANG');
      expect(await grund(portal(portalSitzung('nichtZugelassen')))).toBe('KEIN_PORTALZUGANG');
      // Kontakt des Mandanten „offen" mit einer Sitzung für einen anderen Mandanten.
      expect(await grund(portal(portalSitzung('aktiv', { clientId: mandant.zugeordnet })))).toBe(
        'KEIN_PORTALZUGANG',
      );
      // Andere E-Mail als die des Kontakts: Identität nicht mehr bestätigt.
      expect(await grund(portal(portalSitzung('aktiv', { email: 'anders@example.test' })))).toBe(
        'KEIN_PORTALZUGANG',
      );
    });

    it('Tenant-Wechsel und Ablauf: keine Bestätigung', async () => {
      expect(await grund(portal(portalSitzung('fremd', { tenantId })))).toBe('KEIN_PORTALZUGANG');
      expect(await grund(portal(portalSitzung('aktiv', { tenantId: fremderTenant })))).toBe(
        'KEIN_PORTALZUGANG',
      );
      expect(
        await grund(
          portal(portalSitzung('aktiv', { expires: new Date(Date.now() - 1).toISOString() })),
        ),
      ).toBe('SITZUNG_ABGELAUFEN');
      expect((await portal(portalSitzung('fremd'))).cli?.id).toBe(mandant.fremd);
    });
  });
});
