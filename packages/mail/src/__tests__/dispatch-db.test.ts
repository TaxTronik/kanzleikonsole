// Fachkatalog: ACCESS-NOTIFICATION-RECIPIENT-001, ACCESS-TENANT-RLS-001
// =============================================================================
// S-01 (Folgearbeit): Mail-Versand liest Vorlage, Mandant und Empfänger über
// die App-Rolle.
//
// sendTemplateMail und notifyClientContacts lesen die Vorlage, den
// Mandantennamen und die (bestätigten) Kontakte im SYSTEM-Kontext des Tenants
// über taxtronik_app (RLS); der Owner-Client ist hier vollständig gesperrt.
// Nur der SMTP-Versand und die Dispatch-Einstellung sind Attrappen. Belegt
// gegen PostgreSQL: dieselben Empfänger, dieselbe Vorlage und derselbe
// Mandantenzusatz im Betreff wie bisher (zwei Mandate derselben Adresse im
// Tenant), und Vorlage und Kontakte eines fremden Tenants mit derselben
// Adresse und demselben Slug bleiben wirkungslos und im Kontext von Tenant A
// unsichtbar.
//
// Wie CI: DATABASE_URL ist die Owner-Rolle (nur Fixtures), DATABASE_APP_URL
// die App-Rolle. Nur mit ausdrücklichem Opt-in (MAIL_DISPATCH_DB_TEST=1); die
// Tenants behalten ihre aufbewahrungspflichtigen GwG-Prüfungen in der
// Wegwerf-Datenbank.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// B-02: lokal per MAIL_DISPATCH_DB_TEST=1, im db-CI-Job per DB_TESTS=1 (Glob über alle
// *-db.test.ts). In CI scheitert die Suite ohne Opt-in, statt still übersprungen zu werden.
const enabled = process.env['MAIL_DISPATCH_DB_TEST'] === '1' || process.env['DB_TESTS'] === '1';
if (!enabled && process.env['CI'] === 'true') {
  throw new Error(
    'MAIL_DISPATCH_DB_TEST=1 oder DB_TESTS=1 fehlt: in CI wird keine DB-Suite übersprungen.',
  );
}
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`MAIL_DISPATCH_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`MAIL_DISPATCH_DB_TEST requires a loopback PostgreSQL ${name}.`);
    }
  }
}

const h = vi.hoisted(() => ({
  sent: [] as Array<{ to: string; subject: string }>,
  ownerCalls: [] as string[],
}));

vi.mock('../send', () => ({
  sendMail: async (input: { to: string; subject: string }) => {
    h.sent.push({ to: input.to, subject: input.subject });
    return {};
  },
}));
vi.mock('../dispatch-settings', () => ({ readMailDispatch: async () => ({ mode: 'APP' }) }));
vi.mock('../logger', () => ({ mailLog: () => ({ error: vi.fn(), warn: vi.fn() }) }));
// Jeder Zugriff auf den Owner-Client wird protokolliert und wirft.
vi.mock('@taxtronik/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@taxtronik/db')>();
  const prismaOwner = new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== 'string' || model === 'then') return undefined;
        h.ownerCalls.push(model);
        throw new Error(`S-01: Owner-Client für ${model} benutzt`);
      },
    },
  );
  return { ...actual, prismaOwner };
});

import * as db from '@taxtronik/db';
import { notifyClientContacts, sendTemplateMail } from '../dispatch';

const { withSystemContext } = db;

const describeDb = enabled ? describe : describe.skip;

describeDb('S-01 mail dispatch reads via the app role', () => {
  let owner: typeof import('@taxtronik/db').prismaOwner;
  const a = { tenant: '', main: '', second: '' };
  const b = { tenant: '', client: '', contact: '' };
  const shared = `s01-mail-${randomUUID()}@example.test`;
  const slug = 's01-dispatch';

  /** Aktiver Mandant hinter der GwG-Schranke (gleiche Folge wie gwg-test-fixture.ts). */
  async function activeClient(tenantId: string, verifiedBy: string, name: string) {
    const clientId = (
      await owner.client.create({
        data: { tenantId, name, kind: 'JURPERS' },
        select: { id: true },
      })
    ).id;
    const confirmedAt = new Date();
    await owner.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT set_config('app.current_tenant_id', ${tenantId}, true),
        set_config('app.current_actor_type', 'STAFF', true),
        set_config('app.current_actor_id', ${verifiedBy}, true)`;
      const check = await tx.gwgCheck.create({
        data: {
          tenantId,
          clientId,
          status: 'DRAFT',
          legalForm: 'GmbH',
          registerNumber: 'HRB TEST',
          registerAuthority: 'Amtsgericht Teststadt',
          representativeNames: ['Test-Vertretung'],
          ownershipStructureNotes: 'Vollstaendiger Test-Snapshot.',
        },
      });
      const representative = await tx.gwgRepresentative.create({
        data: { gwgCheckId: check.id, fullName: 'Test-Vertretung', position: 0 },
        select: { id: true, fullName: true },
      });
      const evidence = await tx.document.create({
        data: {
          tenantId,
          clientId,
          title: `Identitaetsnachweis ${check.id}`,
          classification: 'GWG_EVIDENCE',
          mimeType: 'image/jpeg',
        },
      });
      await tx.documentVersion.create({
        data: {
          documentId: evidence.id,
          versionNo: 1,
          storageBucket: 'gwg-test',
          storageKey: `gwg-test/${evidence.id}/v1`,
          sha256: Buffer.alloc(32, 0x7a),
          sizeBytes: 1n,
          immutable: false,
          scanStatus: 'CLEAN',
          scanCompletedAt: confirmedAt,
          createdById: verifiedBy,
        },
      });
      await tx.gwgIdDocument.create({
        data: {
          gwgCheckId: check.id,
          type: 'PERSONALAUSWEIS',
          ownerName: representative.fullName,
          documentId: evidence.id,
          representativeSubjectId: representative.id,
          identityAssignmentConfirmedAt: confirmedAt,
          identityAssignmentConfirmedBy: verifiedBy,
          number: `TEST-${check.id}`,
          issuedBy: 'Testbehoerde',
          issueDate: new Date('2020-01-01T00:00:00.000Z'),
          expiryDate: new Date('2099-12-31T00:00:00.000Z'),
          verifiedAt: confirmedAt,
        },
      });
      await tx.gwgCheck.update({
        where: { id: check.id },
        data: { status: 'VERIFIED', verifiedAt: confirmedAt, verifiedBy },
      });
    });
    await owner.client.update({ where: { id: clientId }, data: { allowActive: true } });
    return clientId;
  }

  async function tenantWithStaff(label: string) {
    const suffix = randomUUID();
    const tenantId = (
      await owner.tenant.create({
        data: { slug: `s01-mail-${label}-${suffix}`, name: `S-01 Mail ${label}` },
      })
    ).id;
    const staffId = (
      await owner.staffUser.create({
        data: {
          tenantId,
          email: `s01-mail-staff-${label}-${suffix}@example.test`,
          fullName: `Synthetic ${label}`,
          passwordHash: 'x',
          roles: { create: { role: 'ADMIN' } },
        },
      })
    ).id;
    return { tenantId, staffId };
  }

  async function confirmedContact(tenantId: string, clientId: string, fullName: string) {
    return (
      await owner.clientContact.create({
        data: { tenantId, clientId, email: shared, fullName, lastLoginAt: new Date() },
        select: { id: true },
      })
    ).id;
  }

  beforeAll(async () => {
    owner = (await vi.importActual<typeof import('@taxtronik/db')>('@taxtronik/db')).prismaOwner;
    const tenantA = await tenantWithStaff('a');
    a.tenant = tenantA.tenantId;
    a.main = await activeClient(a.tenant, tenantA.staffId, 'Mandant Haupt');
    a.second = await activeClient(a.tenant, tenantA.staffId, 'Mandant Zweit');
    await confirmedContact(a.tenant, a.main, 'Kontakt Haupt');
    await confirmedContact(a.tenant, a.second, 'Kontakt Zweit');
    await owner.emailTemplate.create({
      data: {
        tenantId: a.tenant,
        name: 'S-01',
        slug,
        subject: 'Neue Nachricht für {{contact.fullName}}',
        bodyMd: 'Hallo',
      },
    });

    const tenantB = await tenantWithStaff('b');
    b.tenant = tenantB.tenantId;
    b.client = await activeClient(b.tenant, tenantB.staffId, 'Fremder Mandant');
    b.contact = await confirmedContact(b.tenant, b.client, 'Fremder Kontakt');
    await owner.emailTemplate.create({
      data: { tenantId: b.tenant, name: 'S-01', slug, subject: 'Fremde Vorlage', bodyMd: 'x' },
    });

    const [role] = await withSystemContext(
      a.tenant,
      (tx) =>
        tx.$queryRaw<Array<{ role: string; bypass: boolean; superuser: boolean }>>`
          SELECT current_user::text AS role, rolbypassrls AS bypass, rolsuper AS superuser
            FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role).toEqual({ role: 'taxtronik_app', bypass: false, superuser: false });
  });

  it('benachrichtigt die bestätigten Kontakte mit Vorlage und Mandantenzusatz wie bisher', async () => {
    h.sent.length = 0;
    h.ownerCalls.length = 0;
    await expect(
      notifyClientContacts({ tenantId: a.tenant, clientId: a.main, slug, vars: {} }),
    ).resolves.toMatchObject({ ok: true, recipients: 1, attempted: 1 });

    // Zwei Mandate derselben Adresse im Tenant: der Betreff nennt den Mandanten.
    expect(h.sent).toEqual([
      { to: shared, subject: 'Neue Nachricht für Kontakt Haupt (Mandant Haupt)' },
    ]);
    expect(h.ownerCalls).toEqual([]);
  });

  it('versendet eine Einzelmail mit der Vorlage des eigenen Tenants', async () => {
    h.sent.length = 0;
    h.ownerCalls.length = 0;
    await expect(
      sendTemplateMail({
        tenantId: a.tenant,
        clientId: a.second,
        slug,
        to: shared,
        vars: { contact: { fullName: 'Kontakt Zweit' } },
      }),
    ).resolves.toMatchObject({ ok: true, sentViaTemplate: true });

    expect(h.sent).toEqual([
      { to: shared, subject: 'Neue Nachricht für Kontakt Zweit (Mandant Zweit)' },
    ]);
    expect(h.ownerCalls).toEqual([]);
  });

  it('zeigt im SYSTEM-Kontext von Tenant A keine Vorlage und keinen Kontakt von Tenant B', async () => {
    expect(
      await withSystemContext(a.tenant, async (tx) => ({
        templates: await tx.emailTemplate.findMany({ where: { tenantId: b.tenant } }),
        contacts: await tx.clientContact.findMany({ where: { id: b.contact } }),
        clients: await tx.client.findMany({ where: { id: b.client } }),
      })),
    ).toEqual({ templates: [], contacts: [], clients: [] });
  });
});
