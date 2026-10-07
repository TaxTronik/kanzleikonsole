// =============================================================================
// S-01 (Folgearbeit): gemeinsame Hilfen der App-Rollen-DB-Suiten des Workers.
//
// Die Suiten führen einen Job oder Pfad gegen echtes PostgreSQL aus. Wie im CI
// verbindet DATABASE_URL als Owner-Rolle (taxtronik_owner) und DATABASE_APP_URL
// als App-Rolle (taxtronik_app, RLS). Der Owner legt nur Fixtures an.
//
// `guardOwnerClient` ersetzt in der Suite den Owner-Client (`prismaOwner` aus
// @taxtronik/db, den auch ../prisma-owner re-exportiert): Freigegebene Aufrufe,
// etwa die Tenant-Liste eines Fan-outs, gehen an die echte Owner-Verbindung;
// jeder andere Zugriff wird in `ownerAccess.denied` protokolliert und wirft.
// Eine Suite belegt damit, dass der Job Mandantendaten nur über die App-Rolle
// liest und schreibt, auch wenn er einen Fehler selbst abfangen würde.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { prismaOwner as OwnerClient } from '@taxtronik/db';

export type Owner = typeof OwnerClient;

/** Owner-Zugriffe der laufenden Suite (freigegeben bzw. abgewiesen). */
export const ownerAccess = { allowed: [] as string[], denied: [] as string[] };

export function resetOwnerAccess(): void {
  ownerAccess.allowed.length = 0;
  ownerAccess.denied.length = 0;
}

/** Verlangt lokale PostgreSQL-Ziele für Owner- und App-Verbindung. */
export function assertLoopbackDatabases(flag: string): void {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`${flag} requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(`${flag} requires a loopback PostgreSQL ${name}.`);
    }
  }
}

export type AnyFn = (...args: unknown[]) => unknown;

/**
 * Owner-Client, der nur `allowed` (z. B. `tenant.findMany`, `$disconnect`)
 * an `real` durchreicht. Alles andere wird protokolliert und wirft.
 * `overrides` ersetzt einen freigegebenen Aufruf, etwa um die Tenant-Liste
 * eines Fan-outs auf die Fixture-Tenants der Suite zu begrenzen.
 */
export function guardOwnerClient<T extends object>(
  real: T,
  allowed: readonly string[],
  overrides: Readonly<Record<string, AnyFn>> = {},
): T {
  const deny = (path: string): never => {
    ownerAccess.denied.push(path);
    throw new Error(`S-01: Owner-Client für ${path} benutzt`);
  };
  const call = (path: string, target: object, key: string) => {
    return (...args: unknown[]) => {
      if (!allowed.includes(path)) return deny(path);
      ownerAccess.allowed.push(path);
      const override = overrides[path];
      if (override) return override(...args);
      return (Reflect.get(target, key) as AnyFn).apply(target, args);
    };
  };
  return new Proxy(real, {
    get(target, prop) {
      if (typeof prop !== 'string' || prop === 'then') return undefined;
      if (prop.startsWith('$')) return call(prop, target, prop);
      const model = Reflect.get(target, prop) as object | undefined;
      if (!model || typeof model !== 'object') return deny(prop);
      return new Proxy(model, {
        get(modelTarget, method) {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return call(`${prop}.${method}`, modelTarget, method);
        },
      });
    },
  });
}

/** Die App-Verbindung muss die eingeschränkte Rolle sein (kein Superuser, kein BYPASSRLS). */
export async function assertAppRoleConnection(app: {
  $queryRaw<R>(query: TemplateStringsArray, ...values: unknown[]): PromiseLike<R>;
}): Promise<string> {
  const rows = await app.$queryRaw<Array<{ role: string; superuser: boolean; bypass: boolean }>>`
    SELECT current_user::text AS role, rolsuper AS superuser, rolbypassrls AS bypass
      FROM pg_roles WHERE rolname = current_user`;
  const row = rows[0];
  if (!row || row.superuser || row.bypass) {
    throw new Error(
      `DATABASE_APP_URL muss die App-Rolle ohne BYPASSRLS sein (${row?.role ?? '?'}).`,
    );
  }
  return row.role;
}

export async function createTenantFixture(owner: Owner, label: string): Promise<string> {
  const suffix = randomUUID();
  const tenant = await owner.tenant.create({
    data: { slug: `s01-${label}-${suffix}`, name: `S-01 ${label}` },
    select: { id: true },
  });
  return tenant.id;
}

export async function createStaffFixture(
  owner: Owner,
  tenantId: string,
  input: { name: string; role?: 'ADMIN' | 'PARTNER' | 'EMPLOYEE'; active?: boolean },
): Promise<string> {
  const staff = await owner.staffUser.create({
    data: {
      tenantId,
      email: `s01-${input.name}-${randomUUID()}@example.test`,
      fullName: `Synthetic ${input.name}`,
      passwordHash: 'x',
      active: input.active ?? true,
      roles: { create: [{ role: input.role ?? 'EMPLOYEE' }] },
    },
    select: { id: true },
  });
  return staff.id;
}

export async function createClientFixture(
  owner: Owner,
  tenantId: string,
  name: string,
): Promise<string> {
  const client = await owner.client.create({
    data: { tenantId, name: `Synthetic ${name}`, kind: 'JURPERS' },
    select: { id: true },
  });
  return client.id;
}

/**
 * Aktiver Mandant (allow_active) hinter der GwG-Schranke: dieselbe fail-closed
 * Folge wie packages/db/src/__tests__/gwg-test-fixture.ts (DRAFT, Vertretung,
 * Nachweis, bestätigte 1:1-Zuordnung, VERIFIED). Der Import der Vorlage ist
 * wegen rootDir des Workers nicht möglich. `validUntil` (Prüfung) und
 * `idExpiryDate` (Ausweis) sind optional; ohne Angabe unbefristet bzw. 2099.
 */
export async function createActiveClientFixture(
  owner: Owner,
  tenantId: string,
  verifiedBy: string,
  name: string,
  dates: { validUntil?: Date; idExpiryDate?: Date } = {},
): Promise<string> {
  const clientId = await createClientFixture(owner, tenantId, name);
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
        validUntil: dates.validUntil ?? null,
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
        expiryDate: dates.idExpiryDate ?? new Date('2099-12-31T00:00:00.000Z'),
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

/**
 * Löscht die Fixture-Tenants samt Kaskade. Tenants mit append-only Audit-Zeilen,
 * aufbewahrungspflichtigen GwG-Prüfungen oder unveränderlichen Screening-
 * Nachweisen bleiben wie in den übrigen DB-Suiten in der Wegwerf-Datenbank.
 */
export async function deleteTenantFixtures(owner: Owner, tenantIds: readonly string[]) {
  for (const tenantId of tenantIds.filter(Boolean)) {
    const kept = await Promise.all([
      owner.auditLog.count({ where: { tenantId } }),
      owner.gwgCheck.count({ where: { tenantId } }),
      owner.screeningRun.count({ where: { tenantId } }),
      owner.sanctionsSnapshot.count({ where: { tenantId } }),
    ]);
    if (kept.some((count) => count > 0)) continue;
    await owner.tenant.delete({ where: { id: tenantId } });
  }
}
