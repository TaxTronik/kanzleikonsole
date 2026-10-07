// Fachkatalog: ACCESS-TENANT-RLS-001
//
// Review-Befund F-08: mail_outbox hält Versandaufträge für Mandanten-Mails im
// fachlichen Commit. Geprüft gegen die migrierte Datenbank: Tenant-Isolation
// und Paar-Guard wie bei den übrigen Mandantentabellen, die App-Rolle darf nur
// schreiben (INSERT) und lesen, Statuswechsel und Löschung bleiben dem Worker
// (Owner) vorbehalten, und die CHECKs erzwingen Zeitplan und das Entfernen
// geheimer Variablen im Terminalstatus. Der Versandauftrag wird zusammen mit
// dem fachlichen Vorgang zurückgerollt.
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '../prisma-adapter';
import type { TxClient } from '../tenant-context';

const migration = readFileSync(
  new URL('../../prisma/migrations/20261006120000_mail_outbox/migration.sql', import.meta.url),
  'utf8',
);
const skippedMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20261007120000_mail_outbox_skipped/migration.sql',
    import.meta.url,
  ),
  'utf8',
);
const resendMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20261007120100_mail_outbox_resend/migration.sql',
    import.meta.url,
  ),
  'utf8',
);

describe('Mail-Outbox: Migration', () => {
  it('ist zeilenweise LF, transaktional und nennt die Fachkatalog-Regel', () => {
    for (const source of [migration, skippedMigration, resendMigration]) {
      expect(source).not.toContain('\r');
      expect(source).toMatch(/^-- Fachkatalog: ACCESS-TENANT-RLS-001\b/m);
      expect(source).toMatch(/^BEGIN;$/m);
      expect(source.trimEnd().endsWith('COMMIT;')).toBe(true);
    }
    // Folgebefund F-08: der neue Terminalstatus steht allein in seiner Migration.
    expect(skippedMigration).toMatch(
      /ALTER TYPE public\.mail_outbox_status\s+ADD VALUE IF NOT EXISTS 'SKIPPED';/,
    );
    // C4: Neuversand nur über die Funktion; App- und Owner-Rolle (Parität).
    for (const role of ['taxtronik_app', 'taxtronik_owner']) {
      expect(resendMigration).toContain(
        `GRANT EXECUTE ON FUNCTION app.mail_outbox_resend(UUID, public.mail_outbox_status, TEXT)\n  TO ${role};`,
      );
    }
    expect(resendMigration).toMatch(
      /REVOKE ALL ON FUNCTION app\.mail_outbox_resend\(.*\) FROM PUBLIC;/,
    );
  });
});

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Mail-Outbox-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const owner = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_URL'])),
});
const app = new PrismaClient({
  adapter: createPostgresAdapter(optionalDatabaseUrl(process.env['DATABASE_APP_URL'])),
});

let tenantA: string;
let tenantB: string;
let staffA: string;
let clientA: string;
let clientB: string;

async function asStaff<T>(tenantId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', ${staffA}, true),
        set_config('app.current_actor_type', 'STAFF', true)
    `;
    return work(tx);
  });
}

function outboxData(tenantId: string, clientId: string) {
  return {
    tenantId,
    clientId,
    kind: 'DIRECT' as const,
    purpose: 'handover-ready',
    resourceType: 'client_handover',
    resourceId: clientId,
    staffHref: `/staff/clients/${clientId}`,
    payload: { v: 1, slug: 'handover-ready', to: 'max@example.test', vars: {} },
    secretVarsEnc: 'v3:synthetic',
  };
}

async function asSystem<T>(tenantId: string, work: (tx: TxClient) => Promise<T>): Promise<T> {
  return app.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT
        set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_id', '', true),
        set_config('app.current_actor_type', 'SYSTEM', true)
    `;
    return work(tx);
  });
}

async function resend(
  tx: TxClient,
  id: string,
  expected: string,
  reason: string | null = null,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<Array<{ ok: boolean }>>`
    SELECT app.mail_outbox_resend(
      ${id}::uuid, ${expected}::public.mail_outbox_status, ${reason}::text
    ) AS ok
  `;
  return row!.ok;
}

/** Ein im Worker endgültig gescheiterter Auftrag mit erhaltenem Inhalt (C4). */
async function failedWithContent(tenantId: string, clientId: string, status = 'FAILED') {
  const { id } = await owner.mailOutbox.create({
    data: outboxData(tenantId, clientId),
    select: { id: true },
  });
  await owner.mailOutbox.update({
    where: { id },
    data: {
      status: status as 'FAILED' | 'UNKNOWN',
      nextAttemptAt: null,
      attemptCount: 6,
      escalatedAt: new Date(),
      recipientsAttempted: 1,
      recipientsAccepted: 0,
      lastError: 'Versuch 6 von 6; kein weiterer automatischer Versuch.',
    },
  });
  return id;
}

async function rejection(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('Erwarteter Datenbankfehler blieb aus.');
}

beforeAll(async () => {
  if (!hasDatabase) return;
  const seed = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  tenantA = (await owner.tenant.create({ data: { name: 'Outbox A', slug: `outbox-a-${seed}` } }))
    .id;
  tenantB = (await owner.tenant.create({ data: { name: 'Outbox B', slug: `outbox-b-${seed}` } }))
    .id;
  staffA = (
    await owner.staffUser.create({
      data: {
        tenantId: tenantA,
        email: `outbox-${seed}@example.test`,
        fullName: 'Outbox',
        passwordHash: 'synthetic',
        roles: { create: { role: 'ADMIN' } },
      },
    })
  ).id;
  clientA = (
    await owner.client.create({ data: { tenantId: tenantA, kind: 'NATPERS', name: 'Mandant A' } })
  ).id;
  clientB = (
    await owner.client.create({ data: { tenantId: tenantB, kind: 'NATPERS', name: 'Mandant B' } })
  ).id;
});

afterAll(async () => {
  for (const id of [tenantA, tenantB]) {
    if (id) await owner.tenant.delete({ where: { id } });
  }
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

describeWithDatabase('Mail-Outbox gegen PostgreSQL (F-08)', () => {
  it('legt Aufträge im Tenant-Kontext an und liest sie nur dort', async () => {
    const created = await asStaff(tenantA, (tx) =>
      tx.mailOutbox.create({ data: outboxData(tenantA, clientA), select: { id: true } }),
    );
    const own = await asStaff(tenantA, (tx) =>
      tx.mailOutbox.findUnique({ where: { id: created.id }, select: { status: true } }),
    );
    const foreign = await asStaff(tenantB, (tx) =>
      tx.mailOutbox.findUnique({ where: { id: created.id }, select: { id: true } }),
    );

    expect(own).toEqual({ status: 'QUEUED' });
    expect(foreign).toBeNull();
    const row = await owner.mailOutbox.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.attemptCount).toBe(0);
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('weist fremde Tenants und Cross-Tenant-Mandanten ab', async () => {
    // Der Paar-Guard sieht den fremden Mandanten unter RLS nicht (23503),
    // die Isolation-Policy weist den fremden Tenant ab.
    expect(
      await rejection(
        asStaff(tenantA, (tx) => tx.mailOutbox.create({ data: outboxData(tenantB, clientB) })),
      ),
    ).toMatch(/Foreign key constraint|row-level security/);
    expect(
      await rejection(
        asStaff(tenantA, (tx) => tx.mailOutbox.create({ data: outboxData(tenantA, clientB) })),
      ),
    ).toMatch(/Foreign key constraint/);
    expect(
      await rejection(
        asStaff(
          tenantA,
          (tx) =>
            tx.$executeRaw`
            INSERT INTO public.mail_outbox
              (tenant_id, client_id, kind, purpose, resource_type, resource_id, staff_href, payload)
            VALUES (${tenantB}::uuid, ${clientA}::uuid, 'DIRECT', 'handover-ready', 'client',
                    ${clientA}::uuid, '/staff/clients', '{}'::jsonb)`,
        ),
      ),
    ).toMatch(/tenant_id und client_id|row-level security|23503|42501/);
    expect(await owner.mailOutbox.count({ where: { clientId: clientB } })).toBe(0);
  });

  it('erlaubt der App-Rolle weder Statuswechsel noch Löschung', async () => {
    const { id } = await owner.mailOutbox.create({
      data: outboxData(tenantA, clientA),
      select: { id: true },
    });

    expect(
      await rejection(
        asStaff(tenantA, (tx) =>
          tx.mailOutbox.updateMany({
            where: { id },
            data: { status: 'SENDING', nextAttemptAt: null },
          }),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await rejection(asStaff(tenantA, (tx) => tx.mailOutbox.deleteMany({ where: { id } }))),
    ).toMatch(/permission denied/);
  });

  it('rollt den Versandauftrag mit dem fachlichen Vorgang zurück', async () => {
    const marker = `/staff/clients/${clientA}/rollback`;
    await rejection(
      asStaff(tenantA, async (tx) => {
        await tx.mailOutbox.create({
          data: { ...outboxData(tenantA, clientA), staffHref: marker },
        });
        throw new Error('fachlicher Fehler nach dem Enqueue');
      }),
    );

    expect(await owner.mailOutbox.count({ where: { staffHref: marker } })).toBe(0);
  });

  it('erzwingt Zeitplan und das Entfernen geheimer Variablen im Terminalstatus', async () => {
    const { id } = await owner.mailOutbox.create({
      data: outboxData(tenantA, clientA),
      select: { id: true },
    });

    // Terminal mit Secret: verboten.
    expect(
      await rejection(
        owner.mailOutbox.update({
          where: { id },
          data: { status: 'PROVIDER_ACCEPTED', nextAttemptAt: null },
        }),
      ),
    ).toMatch(/mail_outbox_secret_check/);
    // Wartend ohne nächsten Versuch: verboten.
    expect(
      await rejection(owner.mailOutbox.update({ where: { id }, data: { nextAttemptAt: null } })),
    ).toMatch(/mail_outbox_schedule_check/);
    // Mehr angenommene als versuchte Empfänger: verboten.
    expect(
      await rejection(
        owner.mailOutbox.update({
          where: { id },
          data: { recipientsAttempted: 1, recipientsAccepted: 2 },
        }),
      ),
    ).toMatch(/mail_outbox_recipients_check/);

    const terminal = await owner.mailOutbox.update({
      where: { id },
      data: {
        status: 'PROVIDER_ACCEPTED',
        nextAttemptAt: null,
        secretVarsEnc: null,
        payload: {},
        recipientsAttempted: 1,
        recipientsAccepted: 1,
      },
      select: { status: true, payload: true, secretVarsEnc: true },
    });
    expect(terminal).toEqual({ status: 'PROVIDER_ACCEPTED', payload: {}, secretVarsEnc: null });
  });

  it('nimmt SKIPPED nur ohne geheime Variablen und ohne nächsten Versuch an', async () => {
    const { id } = await owner.mailOutbox.create({
      data: outboxData(tenantA, clientA),
      select: { id: true },
    });

    expect(
      await rejection(
        owner.mailOutbox.update({
          where: { id },
          data: { status: 'SKIPPED', nextAttemptAt: null },
        }),
      ),
    ).toMatch(/mail_outbox_secret_check/);
    expect(
      await rejection(
        owner.mailOutbox.update({
          where: { id },
          data: { status: 'SKIPPED', secretVarsEnc: null, payload: {} },
        }),
      ),
    ).toMatch(/mail_outbox_schedule_check/);

    const skipped = await owner.mailOutbox.update({
      where: { id },
      data: {
        status: 'SKIPPED',
        nextAttemptAt: null,
        secretVarsEnc: null,
        payload: {},
        lastError: 'Nicht versendet: Die Unterlagen wurden bereits abgeholt.',
      },
      select: { status: true, payload: true, secretVarsEnc: true, nextAttemptAt: true },
    });
    expect(skipped).toEqual({
      status: 'SKIPPED',
      payload: {},
      secretVarsEnc: null,
      nextAttemptAt: null,
    });
  });

  it('nimmt nur Kanzlei-Links und gültige Anlass-Kennungen an', async () => {
    expect(
      await rejection(
        owner.mailOutbox.create({
          data: { ...outboxData(tenantA, clientA), staffHref: 'https://evil.example/' },
        }),
      ),
    ).toMatch(/mail_outbox_staff_href_check/);
    expect(
      await rejection(
        owner.mailOutbox.create({
          data: { ...outboxData(tenantA, clientA), purpose: 'Rechnung versendet' },
        }),
      ),
    ).toMatch(/mail_outbox_purpose_check/);
  });

  it('C4: setzt einen fehlgeschlagenen Auftrag mit Inhalt im Kanzleikontext zurück', async () => {
    const id = await failedWithContent(tenantA, clientA);

    expect(await asStaff(tenantA, (tx) => resend(tx, id, 'FAILED'))).toBe(true);

    const row = await owner.mailOutbox.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({
      status: 'QUEUED',
      attemptCount: 0,
      escalatedAt: null,
      recipientsAttempted: null,
      recipientsAccepted: null,
      lastError: 'Manuell erneut zum Versand vorgemerkt.',
      secretVarsEnc: 'v3:synthetic',
    });
    expect(row.payload).toMatchObject({ slug: 'handover-ready' });
    expect(row.nextAttemptAt).toBeInstanceOf(Date);
    // Ein zweiter Klick trifft den geänderten Status nicht mehr.
    expect(await asStaff(tenantA, (tx) => resend(tx, id, 'FAILED'))).toBe(false);
  });

  it('C4: verweigert fremde Tenants, falschen Status, fehlenden Inhalt und Nicht-Kanzlei', async () => {
    const id = await failedWithContent(tenantA, clientA, 'UNKNOWN');

    expect(await asStaff(tenantB, (tx) => resend(tx, id, 'UNKNOWN'))).toBe(false);
    expect(await asStaff(tenantA, (tx) => resend(tx, id, 'FAILED'))).toBe(false);
    expect(await rejection(asStaff(tenantA, (tx) => resend(tx, id, 'QUEUED')))).toMatch(
      /MAIL_OUTBOX_RESEND_STATUS/,
    );
    expect(await rejection(asSystem(tenantA, (tx) => resend(tx, id, 'UNKNOWN')))).toMatch(
      /MAIL_OUTBOX_RESEND_CONTEXT/,
    );
    await owner.mailOutbox.update({ where: { id }, data: { payload: {}, secretVarsEnc: null } });
    expect(await asStaff(tenantA, (tx) => resend(tx, id, 'UNKNOWN'))).toBe(false);
    expect((await owner.mailOutbox.findUniqueOrThrow({ where: { id } })).status).toBe('UNKNOWN');
  });

  it('C4: verwirft einen nicht mehr aktuellen Auftrag mit Begründung und ohne Inhalt', async () => {
    const id = await failedWithContent(tenantA, clientA);

    expect(await rejection(asStaff(tenantA, (tx) => resend(tx, id, 'FAILED', '  ')))).toMatch(
      /MAIL_OUTBOX_RESEND_REASON/,
    );
    expect(
      await asStaff(tenantA, (tx) =>
        resend(tx, id, 'FAILED', 'Die Unterlagen wurden bereits abgeholt.'),
      ),
    ).toBe(true);

    expect(await owner.mailOutbox.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'SKIPPED',
      payload: {},
      secretVarsEnc: null,
      nextAttemptAt: null,
      lastError: 'Nicht versendet: Die Unterlagen wurden bereits abgeholt.',
    });
  });

  it('C4: erlaubt geheime Variablen nur in FAILED und UNKNOWN zusätzlich', async () => {
    const id = await failedWithContent(tenantA, clientA);
    expect((await owner.mailOutbox.findUniqueOrThrow({ where: { id } })).secretVarsEnc).toBe(
      'v3:synthetic',
    );
    expect(
      await rejection(owner.mailOutbox.update({ where: { id }, data: { status: 'NO_RECIPIENT' } })),
    ).toMatch(/mail_outbox_secret_check/);
  });
});
