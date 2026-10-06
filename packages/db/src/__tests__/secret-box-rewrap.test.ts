// S-08: Re-Wrap gespeicherter Secret-Box-Werte gegen eine echte PostgreSQL-DB.
// Owner-Fixtures in zwei frischen Tenants; geprüft werden alle Ablageorte aus
// SECRET_SLOTS mit echter Krypto: Klartext bleibt gleich, Lauf ist idempotent,
// wiederaufnehmbar, überschreibt keine parallele Änderung, und ein in einen
// anderen Tenant oder ein anderes Feld kopierter v3-Wert ist nicht lesbar.
import { createCipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const keys = vi.hoisted(() => ({
  AUTH: 'rewrap-test-auth-secret-with-more-than-32-chars',
  OLD: 'rewrap-test-old-data-key-with-more-than-32-chars',
  NEW: 'rewrap-test-new-data-key-with-more-than-32-chars',
}));

vi.mock('@taxtronik/config', () => ({
  env: { AUTH_SECRET: keys.AUTH, SECRET_BOX_KEY: undefined, SECRET_BOX_KEYRING: [] },
}));

import { env } from '@taxtronik/config';
import {
  decryptSecret,
  describeSecretBlob,
  encryptSecret,
  looksEncrypted,
  rewrapSecret,
  SECRET_SLOTS,
  secretSlotContext,
  type SecretContext,
  type SecretSlot,
} from '@taxtronik/crypto';
import {
  rewrapStoredSecrets,
  type RewrapSlot,
  type SecretBoxRewrapOps,
  type SqlExecutor,
} from '../secret-box-rewrap';

const mockEnv = env as unknown as { SECRET_BOX_KEYRING: string[] };

const hasDatabase = Boolean(process.env['DATABASE_URL'] && process.env['DATABASE_APP_URL']);
if (process.env['CI'] === 'true' && !hasDatabase) {
  throw new Error('Secret-Box-Re-Wrap-Test braucht DATABASE_URL und DATABASE_APP_URL in CI.');
}
const describeWithDatabase = hasDatabase ? describe : describe.skip;

const SLOTS = Object.entries(SECRET_SLOTS).map(([name, slot]) => ({ name, slot }));
const ops: SecretBoxRewrapOps<SecretContext> = {
  contextFor: (slot: RewrapSlot, ref) => secretSlotContext(slot as SecretSlot, ref),
  looksEncrypted,
  rewrap: rewrapSecret,
  describe: describeSecretBlob,
};

/** v1/v2 exakt im historischen Format (Bestandsdaten ohne Key-ID/AAD). */
function legacyBlob(version: 'v1' | 'v2', plain: string): string {
  const key =
    version === 'v1'
      ? createHash('sha256').update(keys.AUTH).digest()
      : Buffer.from(
          hkdfSync(
            'sha256',
            keys.AUTH,
            Buffer.from('taxtronik-secret-box-v2-salt', 'utf8'),
            Buffer.from('taxtronik-secret-box-v2', 'utf8'),
            32,
          ),
        );
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [version, iv, cipher.getAuthTag(), ct].map((p) => p.toString('base64')).join(':');
}

const owner = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
const seed = randomUUID().slice(0, 8);
const tenantA = randomUUID();
const tenantB = randomUUID();
const mailbox1 = randomUUID();
const mailbox2 = randomUUID();
const mailboxB = randomUUID();
const clientA = randomUUID();
const outbox1 = randomUUID();
const OUTBOX_SECRET = '{"link":"https://portal.example.test/gwg-onboarding?token=t0k3n"}';

/** Key-ID des aktuell aktiven Schlüssels (aus einem frisch verschlüsselten Wert). */
function activeKeyId(): string | null {
  return describeSecretBlob(encryptSecret('x', context('smtpPassword', tenantA))).keyId;
}

function context(name: keyof typeof SECRET_SLOTS, tenantId: string, rowId?: string) {
  return secretSlotContext(SECRET_SLOTS[name], { tenantId, rowId });
}

async function setting(tenantId: string, key: string): Promise<Record<string, string>> {
  const { rows } = await owner.query(
    'SELECT value FROM public.tenant_setting WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return (rows[0] as { value: Record<string, string> }).value;
}

async function column(table: string, col: string, id: string): Promise<string> {
  const { rows } = await owner.query(`SELECT "${col}" AS v FROM public."${table}" WHERE id = $1`, [
    id,
  ]);
  return (rows[0] as { v: string }).v;
}

/** Alle Fixture-Werte mit ihrem Kontext und erwartetem Klartext. */
async function storedFixtures(): Promise<
  Array<{ blob: string; ctx: SecretContext; plain: string }>
> {
  const a = await setting(tenantA, 'mail.smtp');
  const n8nLegacy = await setting(tenantA, 'integrations.n8n');
  const ibm = await setting(tenantB, 'quantenlos.ibm');
  const { rows } = await owner.query(
    'SELECT api_key_encrypted, signing_secret_encrypted FROM public.n8n_connection WHERE tenant_id = $1',
    [tenantA],
  );
  const conn = rows[0] as { api_key_encrypted: string; signing_secret_encrypted: string };
  return [
    { blob: a['passwordEncrypted']!, ctx: context('smtpPassword', tenantA), plain: 'smtp-a' },
    {
      blob: n8nLegacy['hmacEncrypted']!,
      ctx: context('legacyN8nHmacSecret', tenantA),
      plain: 'legacy-hmac',
    },
    {
      blob: n8nLegacy['apiKeyEncrypted']!,
      ctx: context('legacyN8nApiKey', tenantA),
      plain: 'legacy-api-key',
    },
    { blob: ibm['tokenEncrypted']!, ctx: context('quantenlosIbmToken', tenantB), plain: 'ibm-b' },
    { blob: conn.api_key_encrypted, ctx: context('n8nApiKey', tenantA), plain: 'n8n-api' },
    {
      blob: conn.signing_secret_encrypted,
      ctx: context('n8nSigningSecret', tenantA),
      plain: 'n8n-signing',
    },
    {
      blob: await column('inbound_mailbox', 'secret_enc', mailbox1),
      ctx: context('mailboxSecret', tenantA, mailbox1),
      plain: 'imap-1',
    },
    {
      blob: await column('inbound_mailbox', 'oauth_cache_enc', mailbox1),
      ctx: context('mailboxOauthCache', tenantA, mailbox1),
      plain: '{"cache":1}',
    },
    {
      blob: await column('inbound_mailbox', 'secret_enc', mailbox2),
      ctx: context('mailboxSecret', tenantA, mailbox2),
      plain: 'imap-2',
    },
    {
      blob: await column('inbound_mailbox', 'secret_enc', mailboxB),
      ctx: context('mailboxSecret', tenantB, mailboxB),
      plain: 'imap-b',
    },
    {
      blob: await column('mail_outbox', 'secret_vars_enc', outbox1),
      ctx: context('mailOutboxSecretVars', tenantA, outbox1),
      plain: OUTBOX_SECRET,
    },
  ];
}

/** Nur die Fixture-Tenants umstellen: fremde Daten der Test-DB bleiben unberührt. */
function scopedExecutor(inner: SqlExecutor = owner): SqlExecutor {
  return {
    query(text, values) {
      if (/^\s*SELECT/u.test(text)) {
        // Lesepfad auf die beiden Fixture-Tenants begrenzen.
        const scoped = text.replace(
          /\bORDER BY\b/u,
          `AND tenant_id IN ('${tenantA}'::uuid, '${tenantB}'::uuid) ORDER BY`,
        );
        return inner.query(scoped, values);
      }
      return inner.query(text, values);
    },
  };
}

async function insertFixtures(): Promise<void> {
  // Bestandsmix wie in einer Altinstallation: v1, v2 und v3 mit altem Schlüssel.
  mockEnv.SECRET_BOX_KEYRING = [keys.OLD];
  await owner.query(
    `INSERT INTO public.tenant (id, slug, name, updated_at)
     VALUES ($1, $3, 'Re-Wrap A', now()), ($2, $4, 'Re-Wrap B', now())`,
    [tenantA, tenantB, `rewrap-a-${seed}`, `rewrap-b-${seed}`],
  );
  await owner.query(
    `INSERT INTO public.tenant_setting (tenant_id, key, value, updated_at) VALUES
       ($1, 'mail.smtp', $3::jsonb, now()),
       ($1, 'integrations.n8n', $4::jsonb, now()),
       ($2, 'quantenlos.ibm', $5::jsonb, now()),
       ($2, 'mail.smtp', $6::jsonb, now())`,
    [
      tenantA,
      tenantB,
      JSON.stringify({ host: 'smtp.example.test', passwordEncrypted: legacyBlob('v2', 'smtp-a') }),
      JSON.stringify({
        hmacEncrypted: legacyBlob('v1', 'legacy-hmac'),
        apiKeyEncrypted: encryptSecret('legacy-api-key', context('legacyN8nApiKey', tenantA)),
        apiKey: 'altklartext-bleibt-unberuehrt',
      }),
      JSON.stringify({
        tokenEncrypted: encryptSecret('ibm-b', context('quantenlosIbmToken', tenantB)),
        suffix: 'mb-b',
      }),
      // Tenant B ohne SMTP-Passwort: leeres Feld wird übersprungen.
      JSON.stringify({ host: 'smtp-b.example.test', passwordEncrypted: '' }),
    ],
  );
  await owner.query(
    `INSERT INTO public.n8n_connection (tenant_id, name, api_key_encrypted, signing_secret_encrypted, updated_at)
     VALUES ($1, 'Re-Wrap', $2, $3, now())`,
    [
      tenantA,
      legacyBlob('v2', 'n8n-api'),
      encryptSecret('n8n-signing', context('n8nSigningSecret', tenantA)),
    ],
  );
  await owner.query(
    `INSERT INTO public.inbound_mailbox (id, tenant_id, name, host, username, secret_enc, oauth_cache_enc, updated_at)
     VALUES ($1, $4, 'Postfach 1', 'imap.example.test', 'a@example.test', $5, $6, now()),
            ($2, $4, 'Postfach 2', 'imap.example.test', 'b@example.test', $7, NULL, now()),
            ($3, $8, 'Postfach B', 'imap.example.test', 'c@example.test', $9, NULL, now())`,
    [
      mailbox1,
      mailbox2,
      mailboxB,
      tenantA,
      encryptSecret('imap-1', context('mailboxSecret', tenantA, mailbox1)),
      legacyBlob('v2', '{"cache":1}'),
      legacyBlob('v1', 'imap-2'),
      tenantB,
      encryptSecret('imap-b', context('mailboxSecret', tenantB, mailboxB)),
    ],
  );
  // F-08: wartender Mail-Versandauftrag mit verschlüsseltem Einladungslink;
  // ein terminaler Auftrag trägt kein Secret mehr und wird übersprungen.
  await owner.query(
    `INSERT INTO public.client (id, tenant_id, kind, name, updated_at)
     VALUES ($1, $2, 'NATPERS', 'Re-Wrap Mandant', now())`,
    [clientA, tenantA],
  );
  await owner.query(
    `INSERT INTO public.mail_outbox
       (id, tenant_id, client_id, kind, purpose, resource_type, resource_id, staff_href,
        payload, secret_vars_enc)
     VALUES ($1, $2, $3, 'DIRECT', 'gwg-invite', 'client', $3, '/staff/clients', '{}'::jsonb, $4),
            (gen_random_uuid(), $2, $3, 'DIRECT', 'gwg-invite', 'client', $3, '/staff/clients',
             '{}'::jsonb, NULL)`,
    [
      outbox1,
      tenantA,
      clientA,
      encryptSecret(OUTBOX_SECRET, context('mailOutboxSecretVars', tenantA, outbox1)),
    ],
  );
}

describeWithDatabase('S-08: pnpm secret-box:rewrap gegen PostgreSQL', () => {
  beforeAll(async () => {
    await owner.connect();
    await insertFixtures();
  });

  beforeEach(() => {
    // Rotation: NEW ist aktiv, OLD (und die AUTH_SECRET-Wurzel) entschlüsseln.
    mockEnv.SECRET_BOX_KEYRING = [keys.NEW, keys.OLD];
  });

  afterAll(async () => {
    mockEnv.SECRET_BOX_KEYRING = [];
    await owner.query('DELETE FROM public.inbound_mailbox WHERE tenant_id = ANY($1::uuid[])', [
      [tenantA, tenantB],
    ]);
    await owner.query('DELETE FROM public.tenant WHERE id = ANY($1::uuid[])', [[tenantA, tenantB]]);
    await owner.end();
  });

  it('deckt jeden Ablageort aus SECRET_SLOTS ab', () => {
    expect(new Set(SLOTS.map((entry) => entry.name))).toEqual(
      new Set([
        'smtpPassword',
        'legacyN8nHmacSecret',
        'legacyN8nApiKey',
        'quantenlosIbmToken',
        'n8nApiKey',
        'n8nSigningSecret',
        'mailboxSecret',
        'mailboxOauthCache',
        'mailOutboxSecretVars',
      ]),
    );
  });

  it('--dry-run prüft alle Werte, zählt sie und schreibt nichts', async () => {
    const before = await storedFixtures();
    const report = await rewrapStoredSecrets(scopedExecutor(), SLOTS, ops, { dryRun: true });
    const total = report.reduce((sum, stats) => sum + stats.total, 0);
    expect(total).toBe(11);
    expect(report.reduce((sum, stats) => sum + stats.pending, 0)).toBe(11);
    expect(report.every((stats) => stats.rewrapped === 0 && stats.failed === 0)).toBe(true);
    expect(await storedFixtures()).toEqual(before);
  });

  it('ist nach einem Abbruch wiederaufnehmbar und stellt alles ohne Klartextänderung um', async () => {
    let updates = 0;
    const crashing: SqlExecutor = {
      async query(text, values) {
        if (/^\s*UPDATE/u.test(text) && ++updates > 3) throw new Error('simulierter Abbruch');
        return owner.query(text, values);
      },
    };
    await expect(
      rewrapStoredSecrets(scopedExecutor(crashing), SLOTS, ops, { batchSize: 2 }),
    ).rejects.toThrow('simulierter Abbruch');
    const newKeyId = activeKeyId();
    const partial = await storedFixtures();
    // Bereits Committetes bleibt umgestellt, Unbearbeitetes unverändert lesbar.
    for (const value of partial) expect(decryptSecret(value.blob, value.ctx)).toBe(value.plain);
    expect(partial.filter((v) => describeSecretBlob(v.blob).keyId === newKeyId)).toHaveLength(3);

    const report = await rewrapStoredSecrets(scopedExecutor(), SLOTS, ops, { batchSize: 2 });
    expect(report.reduce((sum, stats) => sum + stats.failed + stats.concurrent, 0)).toBe(0);
    const after = await storedFixtures();
    for (const value of after) {
      expect(describeSecretBlob(value.blob)).toEqual({ version: 'v3', keyId: newKeyId });
      expect(decryptSecret(value.blob, value.ctx)).toBe(value.plain);
    }
    // Nur die verschlüsselten Felder wurden ersetzt; Altklartext und übrige
    // Felder des JSON-Werts bleiben, leere Felder bleiben leer.
    expect(await setting(tenantA, 'integrations.n8n')).toMatchObject({
      apiKey: 'altklartext-bleibt-unberuehrt',
    });
    expect(await setting(tenantB, 'mail.smtp')).toEqual({
      host: 'smtp-b.example.test',
      passwordEncrypted: '',
    });
  });

  it('ist idempotent: ein zweiter Lauf ändert nichts', async () => {
    const before = await storedFixtures();
    const report = await rewrapStoredSecrets(scopedExecutor(), SLOTS, ops);
    expect(report.reduce((sum, stats) => sum + stats.rewrapped, 0)).toBe(0);
    expect(report.reduce((sum, stats) => sum + stats.current, 0)).toBe(11);
    expect(await storedFixtures()).toEqual(before);
  });

  it('nach dem Re-Wrap ist der alte Schlüssel entbehrlich', async () => {
    mockEnv.SECRET_BOX_KEYRING = [keys.NEW];
    for (const value of await storedFixtures()) {
      expect(decryptSecret(value.blob, value.ctx)).toBe(value.plain);
    }
  });

  it('ein in einen anderen Tenant, eine andere Zeile oder ein anderes Feld kopierter Wert ist nicht lesbar', async () => {
    const smtpA = (await setting(tenantA, 'mail.smtp'))['passwordEncrypted']!;
    await owner.query(
      `UPDATE public.tenant_setting SET value = jsonb_set(value, '{passwordEncrypted}', to_jsonb($2::text))
        WHERE tenant_id = $1 AND key = 'mail.smtp'`,
      [tenantB, smtpA],
    );
    const copiedToB = (await setting(tenantB, 'mail.smtp'))['passwordEncrypted']!;
    expect(copiedToB).toBe(smtpA);
    expect(() => decryptSecret(copiedToB, context('smtpPassword', tenantB))).toThrow();

    const secret1 = await column('inbound_mailbox', 'secret_enc', mailbox1);
    expect(() => decryptSecret(secret1, context('mailboxSecret', tenantA, mailbox2))).toThrow();
    expect(() => decryptSecret(secret1, context('mailboxOauthCache', tenantA, mailbox1))).toThrow();
    const n8nApi = await column('n8n_connection', 'api_key_encrypted', await n8nConnectionId());
    expect(() => decryptSecret(n8nApi, context('n8nSigningSecret', tenantA))).toThrow();
    const outboxSecret = await column('mail_outbox', 'secret_vars_enc', outbox1);
    expect(() =>
      decryptSecret(outboxSecret, context('mailOutboxSecretVars', tenantA, mailbox1)),
    ).toThrow();

    // Der Re-Wrap meldet den kopierten Wert und lässt ihn unverändert.
    const failures: Array<{ slot: string; tenantId: string }> = [];
    const report = await rewrapStoredSecrets(scopedExecutor(), SLOTS, ops, {
      onFailure: (failure) => failures.push(failure),
    });
    expect(failures).toEqual([
      expect.objectContaining({ slot: 'smtpPassword', tenantId: tenantB }),
    ]);
    expect(report.find((stats) => stats.slot === 'smtpPassword')?.failed).toBe(1);
    expect((await setting(tenantB, 'mail.smtp'))['passwordEncrypted']).toBe(smtpA);
    await owner.query(
      `UPDATE public.tenant_setting SET value = jsonb_set(value, '{passwordEncrypted}', '""')
        WHERE tenant_id = $1 AND key = 'mail.smtp'`,
      [tenantB],
    );
  });

  it('überschreibt keinen zwischenzeitlich von der Anwendung geschriebenen Wert', async () => {
    // Wert auf den alten Schlüssel zurücksetzen, damit er umzustellen ist.
    mockEnv.SECRET_BOX_KEYRING = [keys.OLD];
    const stale = encryptSecret('imap-2', context('mailboxSecret', tenantA, mailbox2));
    await owner.query('UPDATE public.inbound_mailbox SET secret_enc = $2 WHERE id = $1', [
      mailbox2,
      stale,
    ]);
    mockEnv.SECRET_BOX_KEYRING = [keys.NEW, keys.OLD];
    const appWrite = encryptSecret('neues-passwort', context('mailboxSecret', tenantA, mailbox2));
    const racing: SqlExecutor = {
      async query(text, values) {
        if (/^\s*UPDATE public\."inbound_mailbox"/u.test(text) && values?.[0] === mailbox2) {
          // Die Anwendung speichert zwischen Lesen und Schreiben des Re-Wraps.
          await owner.query('UPDATE public.inbound_mailbox SET secret_enc = $2 WHERE id = $1', [
            mailbox2,
            appWrite,
          ]);
        }
        return owner.query(text, values);
      },
    };
    const report = await rewrapStoredSecrets(scopedExecutor(racing), SLOTS, ops);
    expect(report.find((stats) => stats.slot === 'mailboxSecret')?.concurrent).toBe(1);
    expect(await column('inbound_mailbox', 'secret_enc', mailbox2)).toBe(appWrite);
  });
});

async function n8nConnectionId(): Promise<string> {
  const { rows } = await owner.query('SELECT id FROM public.n8n_connection WHERE tenant_id = $1', [
    tenantA,
  ]);
  return (rows[0] as { id: string }).id;
}
