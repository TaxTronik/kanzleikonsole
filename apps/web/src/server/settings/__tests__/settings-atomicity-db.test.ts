// Fachkatalog: AUDIT-HASH-CHAIN-001, ACCESS-CLIENT-MODE-001.
// Real actions, authorization, setting writers, encryption, evidence and SQL.
// Only the request session/Next cache and the connection boundary are replaced.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@taxtronik/db/prisma-client';
import { createPostgresAdapter, optionalDatabaseUrl } from '@taxtronik/db/prisma-adapter';
import type { TenantContext, TxClient } from '@taxtronik/db';
import { EvidenceService, LocalTimestampAdapter, type AuditEventInput } from '@taxtronik/evidence';
import { decryptSecret, encryptSecret } from '@taxtronik/crypto';
import type { StaffSession } from '@/server/auth/staff';

const fixture = vi.hoisted(() => ({
  session: null as StaffSession | null,
  failAudit: false,
  inTransaction: false,
  transactions: 0,
  run: async (_ctx: TenantContext, _run: (tx: TxClient) => unknown): Promise<unknown> => undefined,
  record: async (_tx: TxClient, _event: AuditEventInput): Promise<unknown> => undefined,
  revalidate: vi.fn(),
}));
vi.mock('@/server/auth/staff', () => ({ staffAuth: async () => fixture.session }));
vi.mock('@/server/logger', () => ({ log: { error: vi.fn(), warn: vi.fn() } }));
vi.mock('@/server/db/prisma-owner', () => ({ prismaOwner: {} }));
vi.mock('@taxtronik/config', () => ({
  riskLayerConfig: { url: 'https://engine.example.test', token: 'synthetic-engine-token' },
  env: {
    AUTH_SECRET: 'settings-regression-test-secret-with-more-than-32-characters',
    NODE_ENV: 'test',
    SMTP_HOST: '',
    SMTP_FROM: '',
  },
}));
vi.mock('@taxtronik/db', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
vi.mock('@taxtronik/db/tenant-context', () => ({
  withTenantContext: (ctx: TenantContext, run: (tx: TxClient) => unknown) => fixture.run(ctx, run),
}));
vi.mock('@taxtronik/mail', async () => ({
  ...(await import('../../../../../../packages/mail/src/smtp-settings')),
  ...(await import('../../../../../../packages/mail/src/dispatch-settings')),
}));
vi.mock('@/server/mail/send', () => ({ sendTestMail: vi.fn() }));
// Drawing/reconciliation is tested separately; IBM settings never call the engine.
vi.mock('@/server/risk', () => ({}));
vi.mock('@/server/container', () => ({
  evidenceService: {
    record: (tx: TxClient, event: AuditEventInput) => fixture.record(tx, event),
  },
}));
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => {
    // Cache invalidation must follow the successful database commit.
    expect(fixture.inTransaction).toBe(false);
    fixture.revalidate(...args);
  },
}));

import {
  saveAccessPolicyAction,
  saveModulesAction,
  saveClientLayoutAction,
  resetClientLayoutAction,
} from '@/app/staff/(protected)/admin/settings/modules-actions';
import {
  saveSellerInfoAction,
  saveBrandingAction,
  saveLetterheadAction,
  saveLegalAction,
} from '@/app/staff/(protected)/admin/settings/branding-actions';
import {
  saveSmtpAction,
  resetSmtpAction,
  saveMailDispatchAction,
} from '@/app/staff/(protected)/admin/settings/mail-actions';
import {
  saveTaxRegionAction,
  saveTsaAction,
} from '@/app/staff/(protected)/admin/settings/infra-actions';
import { writeAccessPolicy } from '../access-policy';
import { DEFAULT_CLIENT_LAYOUT } from '../client-layout';
import { writeSmtpConfig, readSmtpConfig, deleteSmtpConfig } from '../smtp';
import { writeMailDispatch } from '../mail-dispatch';
import {
  ibmTokenSpeichernAction,
  ibmTokenEntfernenAction,
} from '@/app/staff/(protected)/admin/quantenlos/actions';
import { writeIbmToken, readIbmToken, deleteIbmToken } from '../quantenlos';

function form(input: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(input)) data.set(key, value);
  return data;
}
const smtp = {
  host: 'smtp.example.test',
  port: 587,
  secure: false,
  user: 'sender',
  password: 'synthetic-smtp-password',
  from: 'mail@example.test',
  replyTo: '',
};
const smtpForm = () => form({ ...smtp, port: String(smtp.port), secure: '' });
const cases = [
  {
    name: 'access policy RESTRICTED -> OPEN',
    key: 'access',
    event: 'access_policy.update',
    invoke: () => saveAccessPolicyAction(null, form({ clientAccessMode: 'OPEN' })),
    value: { clientAccessMode: 'OPEN' },
  },
  {
    name: 'module flags',
    key: 'modules',
    event: 'modules.update',
    invoke: () =>
      saveModulesAction(null, form({ poaMode: 'OFF', invoiceMode: 'OFF', 'enabled.risk': 'on' })),
    value: { risk: true, poaMode: 'OFF' },
  },
  {
    name: 'client layout',
    key: 'client_detail.layout',
    event: 'client_layout.update',
    invoke: () => saveClientLayoutAction(DEFAULT_CLIENT_LAYOUT),
    value: DEFAULT_CLIENT_LAYOUT,
  },
  {
    name: 'client layout reset',
    key: 'client_detail.layout',
    event: 'client_layout.update',
    invoke: () => resetClientLayoutAction(),
    value: DEFAULT_CLIENT_LAYOUT,
  },
  {
    name: 'seller',
    key: 'invoicing.seller',
    event: 'seller.update',
    invoke: () => saveSellerInfoAction(null, form({ name: 'Synthetic seller', countryIso: 'de' })),
    value: { name: 'Synthetic seller', countryIso: 'DE' },
  },
  {
    name: 'branding',
    key: 'branding',
    event: 'branding.update',
    invoke: () =>
      saveBrandingAction(null, form({ displayName: 'Synthetic firm', accentColor: '#ABCDEF' })),
    value: { displayName: 'Synthetic firm', accentColor: '#abcdef' },
  },
  {
    name: 'letterhead',
    key: 'branding.letterhead',
    event: 'letterhead.update',
    invoke: () =>
      saveLetterheadAction(
        null,
        form({
          organisationName: ' Synthetic letterhead ',
          addressLines: '',
          contactLine: '',
          footnote: '',
        }),
      ),
    value: { organisationName: 'Synthetic letterhead' },
  },
  {
    name: 'legal links',
    key: 'legal',
    event: 'legal.update',
    invoke: () =>
      saveLegalAction(null, form({ impressumUrl: 'https://example.test/legal', privacyUrl: '' })),
    value: { impressumUrl: 'https://example.test/legal', privacyUrl: '' },
  },
  {
    name: 'SMTP password',
    key: 'mail.smtp',
    event: 'smtp.update',
    invoke: () => saveSmtpAction(null, smtpForm()),
    value: { host: smtp.host },
  },
  {
    name: 'SMTP reset',
    key: 'mail.smtp',
    event: 'smtp.reset',
    invoke: () => resetSmtpAction(),
    value: null,
  },
  {
    name: 'mail dispatch',
    key: 'mail.dispatch',
    event: 'mail_dispatch.update',
    invoke: () => saveMailDispatchAction(null, form({ mode: 'BOTH' })),
    value: { mode: 'BOTH' },
  },
  {
    name: 'tax region',
    key: 'tax_region',
    event: 'tax_region.update',
    invoke: () => saveTaxRegionAction(null, form({ region: 'DE-BY' })),
    value: { region: 'DE-BY', assumptionHoliday: false },
  },
  {
    name: 'TSA',
    key: 'evidence.tsa',
    event: 'tsa.update',
    invoke: () => saveTsaAction(null, form({ providerId: 'dfn' })),
    value: { providerId: 'dfn', customUrl: '' },
  },
] as const;

// The ordinary quality job has URL placeholders but no database. The mandatory
// db job explicitly opts in; invalid/missing/nonlocal targets then fail closed.
const enabled = process.env.SETTINGS_ATOMICITY_DB_TEST === '1';
if (enabled) {
  for (const name of ['DATABASE_URL', 'DATABASE_APP_URL']) {
    let url: URL;
    try {
      url = new URL(process.env[name] ?? '');
    } catch {
      throw new Error(`SETTINGS_ATOMICITY_DB_TEST requires a valid ${name}.`);
    }
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      url.pathname.length < 2 ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    ) {
      throw new Error(
        `SETTINGS_ATOMICITY_DB_TEST requires a loopback PostgreSQL ${name} with a database.`,
      );
    }
  }
}

(enabled ? describe : describe.skip)(
  'AUDIT-HASH-CHAIN-001 settings transactions against PostgreSQL',
  () => {
    const owner = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_URL)),
    });
    const app = new PrismaClient({
      adapter: createPostgresAdapter(optionalDatabaseUrl(process.env.DATABASE_APP_URL)),
    });
    const evidence = new EvidenceService(new LocalTimestampAdapter());
    let tenantId: string, staffId: string, ctx: TenantContext;
    let auditCount: number;

    beforeAll(async () => {
      const suffix = randomUUID();
      tenantId = (
        await owner.tenant.create({
          data: { slug: `settings-atomicity-${suffix}`, name: 'Synthetic settings tenant' },
        })
      ).id;
      staffId = (
        await owner.staffUser.create({
          data: {
            tenantId,
            email: `${suffix}@example.test`,
            fullName: 'Synthetic administrator',
            passwordHash: 'x',
            roles: { create: { role: 'ADMIN' } },
          },
        })
      ).id;
      ctx = { tenantId, actorId: staffId, actorType: 'STAFF' };
      fixture.run = async (context, run) => {
        expect(context).toEqual(ctx);
        // A nested standalone writer would commit on another connection.
        expect(fixture.inTransaction).toBe(false);
        fixture.transactions++;
        fixture.inTransaction = true;
        try {
          return await app.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
            return run(tx);
          });
        } finally {
          fixture.inTransaction = false;
        }
      };
      fixture.record = async (tx, event) => {
        const recorded = await evidence.record(tx, event);
        if (fixture.failAudit) {
          // Emulates a database failure after the audit insert, before commit.
          // PostgreSQL must roll back both the setting and the hash-chain tail.
          await tx.$executeRaw`SELECT 1 / 0`;
        }
        return recorded;
      };
    });
    beforeEach(async () => {
      fixture.session = {
        user: { tenantId, staffId, roles: ['ADMIN'], permissions: [] },
      } as unknown as StaffSession;
      fixture.failAudit = false;
      fixture.transactions = 0;
      fixture.revalidate.mockClear();
      auditCount = await owner.auditLog.count({ where: { tenantId } });
    });
    afterAll(async () => {
      // Positive commit tests intentionally retain their synthetic tenant and
      // append-only audit rows in the disposable local test database. Deleting
      // that tenant would violate the audit FK; never disable evidence guards.
      await Promise.all([owner.$disconnect(), app.$disconnect()]);
    });
    async function seed(key: string) {
      const value =
        key === 'access'
          ? { clientAccessMode: 'RESTRICTED' }
          : { previous: 'original configuration' };
      return owner.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key } },
        create: { tenantId, key, value },
        update: { value },
      });
    }
    const read = (key: string) =>
      owner.tenantSetting.findUnique({ where: { tenantId_key: { tenantId, key } } });

    it.each(cases)(
      'rolls back $name and inserted audit on database failure',
      async ({ key, invoke }) => {
        const original = await seed(key);
        fixture.failAudit = true;
        await expect(invoke()).rejects.toThrow(/division by zero/);
        expect(await read(key)).toEqual(original);
        expect(await owner.auditLog.count({ where: { tenantId } })).toBe(auditCount);
        expect(fixture.transactions).toBe(1);
        expect(fixture.revalidate).not.toHaveBeenCalled();
      },
    );
    it.each(cases)(
      'commits $name with exactly its audit event before invalidating caches',
      async ({ key, invoke, value, event }) => {
        await seed(key);
        expect(await invoke()).toEqual({ ok: true });
        const stored = await read(key);
        if (value === null) expect(stored).toBeNull();
        else {
          expect(stored?.value).toMatchObject(value);
          expect(stored?.updatedBy).toBe(staffId);
        }
        expect(fixture.transactions).toBe(1);
        expect(fixture.revalidate).toHaveBeenCalled();
        expect(await owner.auditLog.count({ where: { tenantId } })).toBe(auditCount + 1);
        const audit = await owner.auditLog.findFirstOrThrow({
          where: { tenantId },
          orderBy: { id: 'desc' },
        });
        expect(audit).toMatchObject({
          action: `tenant.settings.${event}`,
          actorId: staffId,
          resourceType: 'tenant_setting',
          resourceId: key,
        });
        if (event === 'smtp.update') {
          const encrypted = (stored!.value as { passwordEncrypted: string }).passwordEncrypted;
          expect(encrypted).toMatch(/^v2:/);
          expect(decryptSecret(encrypted)).toBe(smtp.password);
          expect(audit.after).toMatchObject({ password: '***' });
          expect(JSON.stringify(audit.after)).not.toContain(smtp.password);
          expect(JSON.stringify(stored!.value)).not.toContain(smtp.password);
        }
        const chain = await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT set_config('app.current_tenant_id',${tenantId},true), set_config('app.current_actor_id',${staffId},true), set_config('app.current_actor_type','STAFF',true)`;
          return evidence.verifyChain(tx, tenantId);
        });
        expect(chain.ok).toBe(true);
      },
    );
    it.each(cases)(
      'denies non-admin $name before any transaction or revalidation',
      async ({ invoke }) => {
        fixture.session!.user.roles = ['EMPLOYEE'];
        expect(await invoke()).toMatchObject({ ok: false });
        expect(fixture.transactions).toBe(0);
        expect(fixture.revalidate).not.toHaveBeenCalled();
        expect(await owner.auditLog.count({ where: { tenantId } })).toBe(auditCount);
      },
    );
    it('retains the encrypted SMTP password when changing the host with keepPassword', async () => {
      const value = {
        ...smtp,
        password: undefined,
        passwordEncrypted: encryptSecret('existing-secret'),
      };
      await owner.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: 'mail.smtp' } },
        create: { tenantId, key: 'mail.smtp', value },
        update: { value },
      });
      const input = smtpForm();
      input.set('keepPassword', 'on');
      expect(await saveSmtpAction(null, input)).toEqual({ ok: true });
      expect((await readSmtpConfig(ctx))?.password).toBe('existing-secret');
      expect(await owner.auditLog.count({ where: { tenantId } })).toBe(auditCount + 1);
    });
    it('preserves standalone policy and mail writer APIs without nesting transactions', async () => {
      await writeAccessPolicy(ctx, { clientAccessMode: 'RESTRICTED' });
      expect((await read('access'))?.value).toEqual({ clientAccessMode: 'RESTRICTED' });
      await writeSmtpConfig(ctx, { ...smtp, host: ` ${smtp.host} ` });
      expect(await readSmtpConfig(ctx)).toEqual(smtp);
      await writeMailDispatch(ctx, { mode: 'BOTH' });
      expect((await read('mail.dispatch'))?.value).toEqual({ mode: 'BOTH' });
      await deleteSmtpConfig(ctx);
      expect(await read('mail.smtp')).toBeNull();
      expect(fixture.transactions).toBe(5);
    });
    describe('IBM token settings in the Quantenlos administration', () => {
      const token = 'synthetic-ibm-token-1234';
      const originalToken = 'synthetic-original-token-5678';
      const tokenCases = [
        { operation: 'update', invoke: () => ibmTokenSpeichernAction({ token: ` ${token} ` }) },
        { operation: 'reset', invoke: () => ibmTokenEntfernenAction() },
      ] as const;
      beforeEach(async () => {
        await owner.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key: 'modules' } },
          create: { tenantId, key: 'modules', value: { risk: true } },
          update: { value: { risk: true } },
        });
        await writeIbmToken(ctx, originalToken);
        fixture.transactions = 0;
      });
      it.each(tokenCases)(
        'rolls back IBM token $operation with its inserted audit',
        async ({ invoke }) => {
          const original = await read('quantenlos.ibm');
          fixture.failAudit = true;
          expect(await invoke()).toEqual({ ok: false, error: 'Datenbankfehler.' });
          expect(await read('quantenlos.ibm')).toEqual(original);
          expect(await owner.auditLog.count({ where: { tenantId } })).toBe(auditCount);
          // The first transaction is the actual feature gate read, the second owns write+audit.
          expect(fixture.transactions).toBe(2);
          expect(fixture.revalidate).not.toHaveBeenCalled();
        },
      );
      it.each(tokenCases)(
        'commits IBM token $operation with only masked audit data',
        async ({ operation, invoke }) => {
          expect(await invoke()).toMatchObject({
            ok: true,
            status: { hinterlegt: operation === 'update' },
          });
          expect(fixture.transactions).toBe(operation === 'update' ? 3 : 2);
          const stored = await read('quantenlos.ibm');
          if (operation === 'update') {
            expect(stored?.value).toMatchObject({ suffix: '1234' });
            expect(stored?.updatedBy).toBe(staffId);
            const encrypted = (stored!.value as { tokenEncrypted: string }).tokenEncrypted;
            expect(encrypted).toMatch(/^v2:/);
            expect(decryptSecret(encrypted)).toBe(token);
            expect(JSON.stringify(stored!.value)).not.toContain(token);
          } else expect(stored).toBeNull();
          const audit = await owner.auditLog.findFirstOrThrow({
            where: { tenantId },
            orderBy: { id: 'desc' },
          });
          expect(audit).toMatchObject({
            action: `tenant.settings.quantenlos_ibm.${operation}`,
            actorId: staffId,
            resourceType: 'tenant_setting',
            resourceId: 'quantenlos.ibm',
            after: { token: operation === 'update' ? '***1234' : null },
          });
          expect(JSON.stringify(audit.after)).not.toContain(token);
          expect(await owner.auditLog.count({ where: { tenantId } })).toBe(auditCount + 1);
          const chain = await fixture.run(ctx, (tx) => evidence.verifyChain(tx, tenantId));
          expect(chain).toMatchObject({ ok: true });
          expect(fixture.revalidate).toHaveBeenCalledWith('/staff/admin/quantenlos');
        },
      );
      it.each(tokenCases)(
        'denies employee IBM token $operation before any setting read/write',
        async ({ invoke }) => {
          fixture.session!.user.roles = ['EMPLOYEE'];
          const original = await read('quantenlos.ibm');
          expect(await invoke()).toMatchObject({ ok: false });
          expect(fixture.transactions).toBe(0);
          expect(await read('quantenlos.ibm')).toEqual(original);
          expect(await owner.auditLog.count({ where: { tenantId } })).toBe(auditCount);
          expect(fixture.revalidate).not.toHaveBeenCalled();
        },
      );
      it('preserves standalone IBM token encryption, trimming, read and delete', async () => {
        await writeIbmToken(ctx, ` ${token} `);
        expect(await readIbmToken(ctx)).toBe(token);
        await deleteIbmToken(ctx);
        expect(await readIbmToken(ctx)).toBeNull();
        expect(fixture.transactions).toBe(4);
      });
    });
  },
);
