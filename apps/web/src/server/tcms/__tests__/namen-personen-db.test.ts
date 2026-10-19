// Fachkatalog: TCMS-AKTEUR-001, ACCESS-CLIENT-MODE-001, ACCESS-TENANT-RLS-001
// TCMS Stufe 3: Daten der kanzleikonsole für TCMS-Seiten und -Aktionen gegen
// echtes PostgreSQL über die App-Rolle (RLS): Namensauflösung nur im Tenant
// und Kontakte nur des Mandanten; Personen aus Formularen nur mit Zugriff auf
// den Mandanten (OPEN/RESTRICTED/vertraulich) bzw. als Kontakt genau dieses
// Mandanten; Stammdaten des Ankers aus Mandant und verifizierter GwG-Prüfung.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TxClient } from '@taxtronik/db';
import { MandantAnkerBodySchema } from '@taxtronik/tcms-contract';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../packages/db/src/__tests__/gwg-test-fixture';

vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => null }));
vi.mock('@/server/auth/portal', () => ({ portalAuth: async () => null }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { ActionError } from '@/server/actions/action-error';
import { mandantAnkerTx } from '../mandant';
import { tcmsNamen, UNBEKANNTE_PERSON } from '../namen';
import {
  kanzleiPersonenFuerMandantTx,
  kontakteDesMandantenTx,
  mandantKontakteTx,
  TcmsPersonUnzulaessig,
} from '../personen';

const enabled = process.env.TCMS_SEITE_DB_TEST === '1' || process.env.DB_TESTS === '1';
if (!enabled && process.env.CI === 'true') {
  throw new Error(
    'TCMS_SEITE_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}

(enabled ? describe : describe.skip)('TCMS-Daten der kanzleikonsole (TCMS Stufe 3)', () => {
  const owner = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
  });
  const app = new PrismaClient({
    adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
  });
  const tenants: string[] = [];
  let tenantId = '';
  let fremderTenant = '';
  const staff: Record<string, string> = {};
  const mandant: Record<string, string> = {};
  const kontakt: Record<string, string> = {};

  async function neuerTenant(name: string): Promise<string> {
    const id = (await owner.tenant.create({ data: { slug: `tcms-s3a-${randomUUID()}`, name } })).id;
    tenants.push(id);
    return id;
  }

  async function person(key: string, tenant: string, daten: { active?: boolean } = {}) {
    staff[key] = (
      await owner.staffUser.create({
        data: {
          tenantId: tenant,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: `  Person ${key}  `,
          passwordHash: 'synthetic',
          roles: { create: [{ role: 'EMPLOYEE' }] },
          ...daten,
        },
      })
    ).id;
  }

  async function neuerKontakt(key: string, tenant: string, clientKey: string, active = true) {
    kontakt[key] = (
      await owner.clientContact.create({
        data: {
          tenantId: tenant,
          clientId: mandant[clientKey]!,
          email: `${key}-${randomUUID()}@example.test`,
          fullName: `Kontakt ${key}`,
          active,
        },
      })
    ).id;
  }

  beforeAll(async () => {
    tenantId = await neuerTenant('TCMS S3a');
    fremderTenant = await neuerTenant('TCMS S3a fremd');
    await person('mitarbeiter', tenantId);
    await person('zugeordnet', tenantId);
    await person('inaktiv', tenantId, { active: false });
    await person('fremd', fremderTenant);
    const neu = async (key: string, tenant: string, daten: Record<string, unknown> = {}) => {
      mandant[key] = (
        await owner.client.create({
          data: { tenantId: tenant, kind: 'JURPERS', name: `Mandant ${key}`, ...daten },
        })
      ).id;
    };
    await neu('offen', tenantId, { datevNo: '10001', name: '  Talwind\tGmbH  ' });
    await neu('vertraulich', tenantId, { vertraulich: true, datevNo: 'D-7' });
    await neu('person', tenantId, { kind: 'NATPERS' });
    await neu('fremd', fremderTenant);
    await owner.clientResponsibility.create({
      data: {
        tenantId,
        clientId: mandant.vertraulich!,
        staffId: staff.zugeordnet!,
        role: 'HAUPTBEARBEITER',
      },
    });
    await createVerifiedLegalEntityGwgFixture(owner as never, {
      tenantId,
      clientId: mandant.offen!,
      verifiedBy: staff.mitarbeiter!,
      legalForm: 'GmbH & Co. KG',
      registerNumber: `HRB-${randomUUID().slice(0, 8)}`,
    });
    // Jüngere, nicht verifizierte Prüfung mit anderer Rechtsform: zählt nicht.
    await owner.gwgCheck.create({
      data: { tenantId, clientId: mandant.offen!, status: 'DRAFT', legalForm: 'AG (Entwurf)' },
    });
    await neuerKontakt('aktiv', tenantId, 'offen');
    await neuerKontakt('inaktiv', tenantId, 'offen', false);
    await neuerKontakt('andererMandant', tenantId, 'vertraulich');
    await neuerKontakt('fremd', fremderTenant, 'fremd');
  });

  afterAll(async () => {
    try {
      for (const id of tenants) await owner.tenant.delete({ where: { id } });
    } finally {
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    }
  }, 60_000);

  /** Transaktion der App-Rolle im Tenant-Kontext, wie withTenantContext. */
  function imTenant<T>(tenant: string, run: (tx: TxClient) => Promise<T>): Promise<T> {
    return app.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenant}, true),
        set_config('app.current_actor_id', ${staff.mitarbeiter!}, true),
        set_config('app.current_actor_type', 'STAFF', true)`;
      return run(tx as TxClient);
    });
  }

  describe('tcmsNamen', () => {
    it('löst Mitarbeiter des Tenants (auch inaktive) und Kontakte nur des Mandanten auf', async () => {
      const ids = [
        staff.mitarbeiter!,
        staff.inaktiv!,
        staff.fremd!,
        kontakt.aktiv!,
        kontakt.andererMandant!,
        kontakt.fremd!,
        'kein-uuid',
      ];
      const namen = await imTenant(tenantId, (tx) =>
        tcmsNamen(tx, {
          tenantId,
          staffIds: ids,
          kontakte: { mandantId: mandant.offen!, ids },
        }),
      );
      expect(namen.name(staff.mitarbeiter)).toBe('Person mitarbeiter');
      expect(namen.name(staff.inaktiv)).toBe('Person inaktiv');
      expect(namen.name(kontakt.aktiv)).toBe('Kontakt aktiv');
      // Fremder Tenant, anderer Mandant: nie ein Name.
      expect(namen.name(staff.fremd)).toBe(UNBEKANNTE_PERSON);
      expect(namen.name(kontakt.andererMandant)).toBe(UNBEKANNTE_PERSON);
      expect(namen.name(kontakt.fremd)).toBe(UNBEKANNTE_PERSON);
      expect(namen.name('kein-uuid')).toBe(UNBEKANNTE_PERSON);
      expect(namen.bekannt(kontakt.andererMandant)).toBe(false);
    });

    it('ohne Mandant keine Kontakte, auch nicht des eigenen Tenants', async () => {
      const namen = await imTenant(tenantId, (tx) =>
        tcmsNamen(tx, { tenantId, staffIds: [kontakt.aktiv!] }),
      );
      expect(namen.name(kontakt.aktiv)).toBe(UNBEKANNTE_PERSON);
    });

    it('der Tenant-Filter greift zusätzlich zu RLS', async () => {
      // Kontext des eigenen Tenants, aber Anfrage für den fremden: keine Treffer.
      const namen = await imTenant(tenantId, (tx) =>
        tcmsNamen(tx, { tenantId: fremderTenant, staffIds: [staff.mitarbeiter!] }),
      );
      expect(namen.name(staff.mitarbeiter)).toBe(UNBEKANNTE_PERSON);
    });
  });

  describe('Personen aus Formularen', () => {
    const bezug = (key: string) => ({ tenantId, mandantId: mandant[key]! });

    it('Kanzleipersonen mit Zugriff auf den Mandanten, Namen aus der Datenbank', async () => {
      const ergebnis = await imTenant(tenantId, (tx) =>
        kanzleiPersonenFuerMandantTx(tx, bezug('offen'), [staff.mitarbeiter!, staff.mitarbeiter!]),
      );
      expect(ergebnis).toEqual([{ id: staff.mitarbeiter, name: 'Person mitarbeiter' }]);
    });

    it('weist Personen ohne Zugriff, inaktive und tenantfremde ab', async () => {
      for (const [mandantKey, staffKey] of [
        ['vertraulich', 'mitarbeiter'],
        ['offen', 'inaktiv'],
        ['offen', 'fremd'],
      ] as const) {
        await expect(
          imTenant(tenantId, (tx) =>
            kanzleiPersonenFuerMandantTx(tx, bezug(mandantKey), [staff[staffKey]!], {
              feld: 'durchfuehrendId',
            }),
          ),
          `${staffKey} @ ${mandantKey}`,
        ).rejects.toMatchObject({ name: 'TcmsPersonUnzulaessig', feld: 'durchfuehrendId' });
      }
      // Zugeordnete Hauptbearbeitung am vertraulichen Mandanten: zulässig.
      await expect(
        imTenant(tenantId, (tx) =>
          kanzleiPersonenFuerMandantTx(tx, bezug('vertraulich'), [staff.zugeordnet!]),
        ),
      ).resolves.toEqual([{ id: staff.zugeordnet, name: 'Person zugeordnet' }]);
      await expect(
        imTenant(tenantId, (tx) => kanzleiPersonenFuerMandantTx(tx, bezug('offen'), ['x'])),
      ).rejects.toBeInstanceOf(TcmsPersonUnzulaessig);
    });

    it('Kontakte nur dieses Mandanten; inaktive nur auf ausdrücklichen Wunsch', async () => {
      await expect(
        imTenant(tenantId, (tx) => mandantKontakteTx(tx, bezug('offen'), [kontakt.aktiv!])),
      ).resolves.toEqual([{ id: kontakt.aktiv, name: 'Kontakt aktiv', aktiv: true }]);
      for (const key of ['andererMandant', 'fremd', 'inaktiv'] as const) {
        await expect(
          imTenant(tenantId, (tx) => mandantKontakteTx(tx, bezug('offen'), [kontakt[key]!])),
          key,
        ).rejects.toBeInstanceOf(TcmsPersonUnzulaessig);
      }
      await expect(
        imTenant(tenantId, (tx) =>
          mandantKontakteTx(tx, bezug('offen'), [kontakt.inaktiv!], { auchInaktive: true }),
        ),
      ).resolves.toEqual([{ id: kontakt.inaktiv, name: 'Kontakt inaktiv', aktiv: false }]);
    });

    it('listet für die Anzeige nur Kontakte dieses Mandanten', async () => {
      const kontakte = await imTenant(tenantId, (tx) => kontakteDesMandantenTx(tx, bezug('offen')));
      expect(kontakte.map((k) => k.id).sort()).toEqual([kontakt.aktiv, kontakt.inaktiv].sort());
      expect(kontakte[0]!.aktiv).toBe(true);
    });
  });

  describe('mandantAnkerTx', () => {
    it('nimmt Name und DATEV-Nr. aus dem Mandanten, die Rechtsform aus der verifizierten GwG-Prüfung', async () => {
      const anker = await imTenant(tenantId, (tx) => mandantAnkerTx(tx, tenantId, mandant.offen!));
      expect(anker).toEqual({
        name: 'Talwind GmbH',
        rechtsform: 'GmbH & Co. KG',
        datevNr: '10001',
      });
      expect(MandantAnkerBodySchema.safeParse(anker).success).toBe(true);
    });

    it('ohne Prüfung die Art des Mandanten; nicht numerische DATEV-Nr. entfällt', async () => {
      expect(
        await imTenant(tenantId, (tx) => mandantAnkerTx(tx, tenantId, mandant.vertraulich!)),
      ).toEqual({ name: 'Mandant vertraulich', rechtsform: 'Juristische Person', datevNr: null });
      expect(
        (await imTenant(tenantId, (tx) => mandantAnkerTx(tx, tenantId, mandant.person!)))
          .rechtsform,
      ).toBe('Natürliche Person');
    });

    it('kein Anker für Mandanten eines anderen Tenants', async () => {
      await expect(
        imTenant(tenantId, (tx) => mandantAnkerTx(tx, tenantId, mandant.fremd!)),
      ).rejects.toBeInstanceOf(ActionError);
    });
  });
});
