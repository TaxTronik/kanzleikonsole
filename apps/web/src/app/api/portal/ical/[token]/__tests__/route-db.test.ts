// Fachkatalog: ACCESS-TENANT-RLS-001, CLIENT-MANDATE-LIFECYCLE-001
// =============================================================================
// S-01 (Folgearbeit): iCal-Feed über die App-Rolle.
//
// Die Route löst über den Owner-Client nur den Tenant des Token-Kontakts auf;
// Kontakt, Mandant, Modulschalter, Fristen und Termine liest sie im
// SYSTEM-Kontext dieses Tenants über taxtronik_app (RLS). Belegt gegen
// PostgreSQL: derselbe Feed wie bisher (Frist und Termin des Mandanten), kein
// weiterer Owner-Zugriff, und Fristen und Termine eines fremden Tenants bleiben
// im Kontext von Tenant A unsichtbar.
//
// Wie CI: DATABASE_URL ist die Owner-Rolle (nur Fixtures), DATABASE_APP_URL
// die App-Rolle. Nur mit ausdrücklichem Opt-in (PORTAL_ICAL_DB_TEST=1); die
// Tenants behalten ihre aufbewahrungspflichtigen GwG-Prüfungen in der
// Wegwerf-Datenbank.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { createVerifiedLegalEntityGwgFixture } from '../../../../../../../../../packages/db/src/__tests__/gwg-test-fixture';

// B-02: lokal per PORTAL_ICAL_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['PORTAL_ICAL_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'PORTAL_ICAL_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`PORTAL_ICAL_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`PORTAL_ICAL_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const owner = vi.hoisted(() => ({ calls: [] as Array<{ path: string; args: unknown[] }> }));

vi.mock('@taxtronik/config', () => ({ env: { AUTH_SECRET: 'synthetic-ical-regression-secret' } }));
// Der Owner-Client der Route darf nur den Kontakt zur Tenant-Auflösung lesen.
vi.mock('@/server/db/prisma-owner', async () => {
  const actual = await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db');
  const prismaOwner = new Proxy(actual.prismaOwner, {
    get(target, model) {
      if (typeof model !== 'string' || model === 'then') return undefined;
      return new Proxy(Reflect.get(target, model) as object, {
        get(delegate, method) {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (...args: unknown[]) => {
            const path = `${model}.${method}`;
            owner.calls.push({ path, args });
            if (path !== 'clientContact.findFirst') {
              throw new Error(`S-01: Owner-Client für ${path} benutzt`);
            }
            return (Reflect.get(delegate, method) as (...a: unknown[]) => unknown).apply(
              delegate,
              args,
            );
          };
        },
      });
    },
  });
  return { prismaOwner };
});

import * as db from '@taxtronik/db';
import { signIcalToken } from '@/server/ical/feed';
import { GET } from '../route';

const { withSystemContext } = db;
// Fixtures legt die echte Owner-Verbindung an (nicht der überwachte Client der Route).
const fixtures = db.prismaOwner;

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 portal iCal feed via the app role', () => {
  type Fixture = {
    tenant: string;
    client: string;
    contact: string;
    deadline: string;
    appt: string;
  };
  const a = {} as Fixture;
  const b = {} as Fixture;
  const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  async function seed(fixture: Fixture, label: string) {
    const suffix = randomUUID();
    fixture.tenant = (
      await fixtures.tenant.create({
        data: { slug: `s01-ical-${label}-${suffix}`, name: `S-01 iCal ${label}` },
      })
    ).id;
    const staff = (
      await fixtures.staffUser.create({
        data: {
          tenantId: fixture.tenant,
          email: `s01-ical-${label}-${suffix}@example.test`,
          fullName: `Synthetic ${label}`,
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    fixture.client = (
      await fixtures.client.create({
        data: { tenantId: fixture.tenant, kind: 'JURPERS', name: `Mandant ${label}` },
      })
    ).id;
    await createVerifiedLegalEntityGwgFixture(fixtures, {
      tenantId: fixture.tenant,
      clientId: fixture.client,
      verifiedBy: staff,
      registerNumber: `HRB-ICAL-${suffix}`,
    });
    await fixtures.client.update({ where: { id: fixture.client }, data: { allowActive: true } });
    fixture.contact = (
      await fixtures.clientContact.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          email: `s01-ical-contact-${label}-${suffix}@example.test`,
          fullName: `Kontakt ${label}`,
        },
      })
    ).id;
    fixture.deadline = (
      await fixtures.taxDeadline.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          kind: 'USTA_MONATLICH',
          period: `2026-${label}`,
          dueDate: soon,
        },
      })
    ).id;
    fixture.appt = (
      await fixtures.appointment.create({
        data: {
          tenantId: fixture.tenant,
          clientId: fixture.client,
          ownerStaffId: staff,
          createdByStaff: staff,
          title: `Besprechung ${label}`,
          startsAt: soon,
          endsAt: new Date(soon.getTime() + 60 * 60 * 1000),
        },
      })
    ).id;
  }

  beforeAll(async () => {
    await seed(a, 'a');
    await seed(b, 'b');
    const [role] = await withSystemContext(
      a.tenant,
      (tx) =>
        tx.$queryRaw<Array<{ role: string; bypass: boolean; superuser: boolean }>>`
        SELECT current_user::text AS role, rolbypassrls AS bypass, rolsuper AS superuser
          FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({ role: 'taxtronik_app', bypass: false, superuser: false });
  });

  it('liefert denselben Feed und nutzt den Owner nur für die Tenant-Auflösung', async () => {
    owner.calls.length = 0;
    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ token: signIcalToken(a.contact, 1) }),
    });

    expect(response.status).toBe(200);
    const ics = await response.text();
    expect(ics).toContain(`UID:dl-${a.deadline}`);
    expect(ics).toContain(`UID:appt-${a.appt}`);
    expect(ics).not.toContain(b.deadline);
    expect(ics).not.toContain(b.appt);
    expect(owner.calls).toEqual([
      {
        path: 'clientContact.findFirst',
        args: [{ where: { id: a.contact, active: true }, select: { tenantId: true } }],
      },
    ]);
  });

  it('widerruft weiterhin über die Token-Version (404 im Tenant-Kontext)', async () => {
    const response = await GET({} as NextRequest, {
      params: Promise.resolve({ token: signIcalToken(a.contact, 2) }),
    });
    expect(response.status).toBe(404);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Fristen und Termine von Tenant B', async () => {
    const foreign = await withSystemContext(a.tenant, async (tx) => ({
      contacts: await tx.clientContact.findMany({ where: { id: b.contact } }),
      deadlines: await tx.taxDeadline.findMany({ where: { clientId: b.client } }),
      appointments: await tx.appointment.findMany({ where: { clientId: b.client } }),
    }));
    expect(foreign).toEqual({ contacts: [], deadlines: [], appointments: [] });
  });
});
