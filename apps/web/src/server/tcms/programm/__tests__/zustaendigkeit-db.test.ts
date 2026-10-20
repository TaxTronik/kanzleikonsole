// Fachkatalog: TCMS-AKTEUR-001, ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001
// TCMS Stufe 3, Bereich A: Personen der kanzleikonsole für Einrichtung,
// Profil und Beschreibung gegen echtes PostgreSQL über die App-Rolle (RLS,
// `withTenantContext` wie im Request); Fixtures über den Owner-Client des
// Pakets (`prismaOwner`, kein eigener PrismaClient).
//   - Zuständigkeit: Berufsträger:in nur aktiv, qualifiziert und mit Rolle;
//     Hauptbearbeitung nur aktiv; Kanzleipersonen nur aktiv und mit Zugriff
//     auf den Mandanten (OPEN/vertraulich); deterministische Reihenfolge.
//   - Namen für den eingefrorenen Inhalt: alle Mitarbeitenden des Tenants
//     (auch inaktive) und Kontakte genau dieses Mandanten; über der Grenze
//     des Vertrags Abbruch statt Kürzung.
//   - Personen aus dem Formular (Zuständigkeiten, Empfänger der Zielfreigabe)
//     nur mit Zugriff bzw. als aktiver Kontakt genau dieses Mandanten.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as db from '@taxtronik/db';
import type { TxClient } from '@taxtronik/db';
import type { EntwurfKontrolle } from '@taxtronik/tcms-contract';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { ActionError } from '@/server/actions/action-error';
import { TcmsPersonUnzulaessig } from '../../personen';
import { pruefeFreigabeEmpfaengerTx, pruefeKontrollPersonenTx } from '../einrichtung';
import {
  freigabeNamenTx,
  MAX_PERSONEN_JE_AUFRUF,
  tcmsZustaendigkeitTx,
  ZU_VIELE_PERSONEN,
} from '../zustaendigkeit';
import { erwarteAnwendungsfehler } from '@taxtronik/db/testing/db-fehler';

const enabled = process.env.TCMS_SEITE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_SEITE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

(enabled ? describe : describe.skip)('TCMS Bereich A: Personen der kanzleikonsole', () => {
  // Owner nur für synthetische Fixtures (wie tickets-db.test.ts); geprüft wird über die App-Rolle.
  const owner = db.prismaOwner;
  const tenants: string[] = [];
  let tenantId = '';
  let fremderTenant = '';
  const staff: Record<string, string> = {};
  const mandant: Record<string, string> = {};
  const kontakt: Record<string, string> = {};
  let zeit = Date.parse('2026-01-01T00:00:00Z');

  async function neuerTenant(name: string): Promise<string> {
    const id = (await owner.tenant.create({ data: { slug: `tcms-s3a-a-${randomUUID()}`, name } }))
      .id;
    tenants.push(id);
    return id;
  }

  async function person(
    key: string,
    tenant: string,
    name: string,
    daten: { active?: boolean; isProfessional?: boolean; rolle?: 'EMPLOYEE' | 'ADMIN' | null } = {},
  ) {
    const { rolle = 'EMPLOYEE', ...rest } = daten;
    staff[key] = (
      await owner.staffUser.create({
        data: {
          tenantId: tenant,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: name,
          passwordHash: 'synthetic',
          ...(rolle ? { roles: { create: [{ role: rolle }] } } : {}),
          ...rest,
        },
      })
    ).id;
  }

  async function zuordnen(
    clientKey: string,
    staffKey: string,
    role: 'BERUFSTRAEGER' | 'HAUPTBEARBEITER',
  ) {
    zeit += 60_000;
    await owner.clientResponsibility.create({
      data: {
        tenantId,
        clientId: mandant[clientKey]!,
        staffId: staff[staffKey]!,
        role,
        createdAt: new Date(zeit),
      },
    });
  }

  async function neuerKontakt(key: string, tenant: string, clientKey: string, active = true) {
    kontakt[key] = (
      await owner.clientContact.create({
        data: {
          tenantId: tenant,
          clientId: mandant[clientKey]!,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: `  Kontakt ${key} `,
          active,
        },
      })
    ).id;
  }

  beforeAll(async () => {
    tenantId = await neuerTenant('TCMS S3a Bereich A');
    fremderTenant = await neuerTenant('TCMS S3a Bereich A fremd');
    await person('btUnqualifiziert', tenantId, 'Ulla Unqualifiziert');
    await person('btInaktiv', tenantId, 'Ida Inaktiv', { isProfessional: true, active: false });
    await person('btOhneRolle', tenantId, 'Otto Ohnerolle', { isProfessional: true, rolle: null });
    await person('bt', tenantId, '  StB Berta Beruf ', { isProfessional: true });
    await person('hbInaktiv', tenantId, 'Hans Inaktiv', { active: false });
    await person('hb', tenantId, 'Hanna Haupt');
    await person('mitarbeiter', tenantId, 'Mia Mitarbeit');
    await person('admin', tenantId, 'Adam Admin', { rolle: 'ADMIN' });
    await person('fremd', fremderTenant, 'Fritz Fremd', { isProfessional: true });
    const neu = async (key: string, tenant: string, daten: Record<string, unknown> = {}) => {
      mandant[key] = (
        await owner.client.create({
          data: { tenantId: tenant, kind: 'JURPERS', name: `Mandant ${key}`, ...daten },
        })
      ).id;
    };
    await neu('vertraulich', tenantId, { vertraulich: true });
    await neu('offen', tenantId);
    await neu('fremd', fremderTenant);
    // Ältere, nicht berücksichtigte Zuordnungen zuerst: Reihenfolge allein entscheidet nicht.
    await zuordnen('vertraulich', 'btUnqualifiziert', 'BERUFSTRAEGER');
    await zuordnen('vertraulich', 'btInaktiv', 'BERUFSTRAEGER');
    await zuordnen('vertraulich', 'btOhneRolle', 'BERUFSTRAEGER');
    await zuordnen('vertraulich', 'bt', 'BERUFSTRAEGER');
    await zuordnen('vertraulich', 'hbInaktiv', 'HAUPTBEARBEITER');
    await zuordnen('vertraulich', 'hb', 'HAUPTBEARBEITER');
    await neuerKontakt('aktiv', tenantId, 'vertraulich');
    await neuerKontakt('inaktiv', tenantId, 'vertraulich', false);
    await neuerKontakt('andererMandant', tenantId, 'offen');
    await neuerKontakt('fremd', fremderTenant, 'fremd');
  });

  afterAll(async () => {
    try {
      for (const id of tenants) await owner.tenant.delete({ where: { id } });
    } finally {
      await Promise.all([owner.$disconnect(), db.prisma.$disconnect()]);
    }
  }, 120_000);

  /** Transaktion der App-Rolle im Tenant-Kontext (wie im Request). */
  function imTenant<T>(tenant: string, run: (tx: TxClient) => Promise<T>): Promise<T> {
    return db.withTenantContext({ tenantId: tenant, actorId: null, actorType: 'STAFF' }, run);
  }

  const bezug = (key: string) => ({ tenantId, mandantId: mandant[key]! });
  const eintrag = (key: string, name: string) => ({ id: staff[key]!, name });

  describe('tcmsZustaendigkeitTx', () => {
    it('vertraulicher Mandant: nur qualifizierte, aktive Zuständige und Personen mit Zugriff', async () => {
      const z = await imTenant(tenantId, (tx) => tcmsZustaendigkeitTx(tx, bezug('vertraulich')));
      expect(z.berufstraeger).toEqual(eintrag('bt', 'StB Berta Beruf'));
      expect(z.bearbeitung).toEqual(eintrag('hb', 'Hanna Haupt'));
      // Mia ohne Zuordnung sieht den vertraulichen Mandanten nicht; Admin immer.
      expect(z.kanzlei).toEqual([
        eintrag('admin', 'Adam Admin'),
        eintrag('hb', 'Hanna Haupt'),
        eintrag('btOhneRolle', 'Otto Ohnerolle'),
        eintrag('bt', 'StB Berta Beruf'),
        eintrag('btUnqualifiziert', 'Ulla Unqualifiziert'),
      ]);
      expect(z.vertretung).toEqual(eintrag('admin', 'Adam Admin'));
    });

    it('offener Mandant ohne Zuordnung: keine Zuständigkeit, alle Aktiven mit Zugriff', async () => {
      const z = await imTenant(tenantId, (tx) => tcmsZustaendigkeitTx(tx, bezug('offen')));
      expect(z.berufstraeger).toBeNull();
      expect(z.bearbeitung).toBeNull();
      const ids = z.kanzlei.map((p) => p.id);
      expect(ids).toContain(staff.mitarbeiter);
      expect(ids).not.toContain(staff.btInaktiv);
      expect(ids).not.toContain(staff.hbInaktiv);
      expect(ids).not.toContain(staff.fremd);
      expect(z.vertretung?.id).toBe(z.kanzlei[0]!.id);
    });

    it('fremder Mandant: niemand (Tenant-Filter und RLS)', async () => {
      const z = await imTenant(tenantId, (tx) =>
        tcmsZustaendigkeitTx(tx, { tenantId, mandantId: mandant.fremd! }),
      );
      expect(z).toEqual({ berufstraeger: null, bearbeitung: null, kanzlei: [], vertretung: null });
    });
  });

  describe('freigabeNamenTx', () => {
    it('alle Mitarbeitenden des Tenants (auch inaktive) und nur Kontakte dieses Mandanten', async () => {
      const namen = await imTenant(tenantId, (tx) => freigabeNamenTx(tx, bezug('vertraulich')));
      const nach = new Map(namen.map((n) => [n.id, n.name]));
      expect(nach.get(staff.btInaktiv!)).toBe('Ida Inaktiv');
      expect(nach.get(staff.mitarbeiter!)).toBe('Mia Mitarbeit');
      expect(nach.get(staff.bt!)).toBe('StB Berta Beruf');
      expect(nach.get(kontakt.aktiv!)).toBe('Kontakt aktiv');
      expect(nach.get(kontakt.inaktiv!)).toBe('Kontakt inaktiv');
      expect(nach.has(kontakt.andererMandant!)).toBe(false);
      expect(nach.has(kontakt.fremd!)).toBe(false);
      expect(nach.has(staff.fremd!)).toBe(false);
    });
  });

  describe('Personen aus dem Formular', () => {
    const kontrolle = (k: Partial<EntwurfKontrolle>): EntwurfKontrolle => ({
      partei: 'KANZLEI',
      durchfuehrendId: null,
      vertretungId: null,
      gegenzeichnerId: null,
      ...k,
    });

    it('zulässig: Kanzlei mit Zugriff, Kontakt dieses Mandanten (auch als Gegenzeichnung)', async () => {
      await expect(
        imTenant(tenantId, (tx) =>
          pruefeKontrollPersonenTx(tx, bezug('vertraulich'), {
            'K-EC-01': kontrolle({
              durchfuehrendId: staff.hb!,
              vertretungId: staff.bt!.toUpperCase(),
              gegenzeichnerId: kontakt.aktiv!,
            }),
            'K-EC-02': kontrolle({
              partei: 'MANDANT',
              durchfuehrendId: kontakt.aktiv!,
              gegenzeichnerId: staff.admin!,
            }),
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it.each([
      [
        'Kanzleiperson ohne Zugriff auf den vertraulichen Mandanten',
        { durchfuehrendId: 'mitarbeiter' },
      ],
      ['inaktive Kanzleiperson', { vertretungId: 'btInaktiv' }],
      ['Person eines fremden Tenants als Gegenzeichnung', { gegenzeichnerId: 'fremd' }],
      [
        'Kontakt eines anderen Mandanten als Gegenzeichnung',
        { gegenzeichnerId: '@andererMandant' },
      ],
      ['inaktiver Kontakt (Partei Mandant)', { partei: 'MANDANT', durchfuehrendId: '@inaktiv' }],
      ['Kanzleiperson als Partei Mandant', { partei: 'MANDANT', durchfuehrendId: 'hb' }],
      ['keine UUID', { durchfuehrendId: '!kein-uuid' }],
    ] as Array<[string, Record<string, string>]>)(
      '%s: abgewiesen (Feld „kontrollen“)',
      async (_n, roh) => {
        const aufloesen = (v: string) =>
          v.startsWith('@')
            ? kontakt[v.slice(1)]!
            : v.startsWith('!')
              ? v.slice(1)
              : (staff[v] ?? v);
        const k = Object.fromEntries(
          Object.entries(roh).map(([f, v]) => [f, f === 'partei' ? v : aufloesen(v)]),
        ) as Partial<EntwurfKontrolle>;
        const fehler = await imTenant(tenantId, (tx) =>
          pruefeKontrollPersonenTx(tx, bezug('vertraulich'), { 'K-EC-01': kontrolle(k) }),
        ).catch((e: unknown) => e);
        expect(fehler).toBeInstanceOf(TcmsPersonUnzulaessig);
        expect((fehler as TcmsPersonUnzulaessig).feld).toBe('kontrollen');
      },
    );

    it('Empfänger der Zielfreigabe: nur aktiver Kontakt dieses Mandanten', async () => {
      await expect(
        imTenant(tenantId, (tx) =>
          pruefeFreigabeEmpfaengerTx(tx, bezug('vertraulich'), {
            anfordern: true,
            empfaengerId: kontakt.aktiv!,
          }),
        ),
      ).resolves.toBeUndefined();
      await expect(
        imTenant(tenantId, (tx) =>
          pruefeFreigabeEmpfaengerTx(tx, bezug('vertraulich'), {
            anfordern: false,
            empfaengerId: null,
          }),
        ),
      ).resolves.toBeUndefined();
      for (const id of [kontakt.andererMandant!, kontakt.inaktiv!, staff.bt!]) {
        const fehler = await imTenant(tenantId, (tx) =>
          pruefeFreigabeEmpfaengerTx(tx, bezug('vertraulich'), {
            anfordern: true,
            empfaengerId: id,
          }),
        ).catch((e: unknown) => e);
        expect(fehler).toBeInstanceOf(TcmsPersonUnzulaessig);
        expect((fehler as TcmsPersonUnzulaessig).feld).toBe('freigabe');
      }
    });
  });

  describe('Grenze des Vertrags (fail closed)', () => {
    let gross = '';
    let grossMandant = '';

    beforeAll(async () => {
      gross = await neuerTenant('TCMS S3a Bereich A gross');
      grossMandant = (
        await owner.client.create({
          data: { tenantId: gross, kind: 'JURPERS', name: 'Gross GmbH' },
        })
      ).id;
      await owner.staffUser.createMany({
        data: Array.from({ length: MAX_PERSONEN_JE_AUFRUF + 1 }, (_, i) => ({
          tenantId: gross,
          email: `p${i}-${randomUUID()}@example.test`,
          fullName: `Person ${i}`,
          passwordHash: 'synthetic',
        })),
      });
    }, 120_000);

    it('mehr Personen als der Vertrag annimmt: Abbruch mit fester Meldung statt Kürzung', async () => {
      const b = { tenantId: gross, mandantId: grossMandant };
      const laeufe: Array<(tx: TxClient) => Promise<unknown>> = [
        (tx) => tcmsZustaendigkeitTx(tx, b),
        (tx) => freigabeNamenTx(tx, b),
      ];
      for (const lauf of laeufe) {
        const fehler = await imTenant(gross, lauf).catch((e: unknown) => e);
        expect(erwarteAnwendungsfehler(fehler, { klasse: ActionError }).message).toBe(
          ZU_VIELE_PERSONEN,
        );
      }
    }, 60_000);
  });
});
