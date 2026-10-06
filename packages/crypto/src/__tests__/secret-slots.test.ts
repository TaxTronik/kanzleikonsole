// S-08: Wortlaut der AAD-Kontexte je Ablageort. Ein geänderter Wortlaut macht
// bestehende v3-Werte unlesbar; dieser Test pinnt ihn deshalb.
import { describe, expect, it } from 'vitest';
import {
  canonicalSecretContext,
  mailboxOauthStateContext,
  SECRET_SLOTS,
  secretSlotContext,
} from '../secret-slots';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ROW = '33333333-3333-4333-8333-333333333333';

describe('Secret-Box-Ablageorte', () => {
  it.each([
    ['smtpPassword', `${TENANT}|tenant_setting/mail.smtp|passwordEncrypted`],
    ['legacyN8nHmacSecret', `${TENANT}|tenant_setting/integrations.n8n|hmacEncrypted`],
    ['legacyN8nApiKey', `${TENANT}|tenant_setting/integrations.n8n|apiKeyEncrypted`],
    ['quantenlosIbmToken', `${TENANT}|tenant_setting/quantenlos.ibm|tokenEncrypted`],
    ['n8nApiKey', `${TENANT}|n8n_connection|api_key_encrypted`],
    ['n8nSigningSecret', `${TENANT}|n8n_connection|signing_secret_encrypted`],
    ['mailboxSecret', `${TENANT}|inbound_mailbox/${ROW}|secret_enc`],
    ['mailboxOauthCache', `${TENANT}|inbound_mailbox/${ROW}|oauth_cache_enc`],
    ['mailOutboxSecretVars', `${TENANT}|mail_outbox/${ROW}|secret_vars_enc`],
  ] as const)('%s → %s', (name, expected) => {
    const context = secretSlotContext(SECRET_SLOTS[name], { tenantId: TENANT, rowId: ROW });
    expect(canonicalSecretContext(context)).toBe(expected);
  });

  it('Tabellen mit mehreren Zeilen je Tenant verlangen die Zeilen-ID', () => {
    expect(() => secretSlotContext(SECRET_SLOTS.mailboxSecret, { tenantId: TENANT })).toThrow(
      /Secret-Box-Kontext/,
    );
    expect(() =>
      secretSlotContext(SECRET_SLOTS.mailOutboxSecretVars, { tenantId: TENANT }),
    ).toThrow(/Secret-Box-Kontext/);
  });

  it('der OAuth-State-Cookie ist an Tenant und anfordernde Person gebunden', () => {
    expect(canonicalSecretContext(mailboxOauthStateContext(TENANT, ROW))).toBe(
      `${TENANT}|cookie/tt-mailbox-oauth/${ROW}|payload`,
    );
  });

  it('weist leere, zu lange und mehrdeutige Bestandteile ab', () => {
    const valid = { tenantId: TENANT, scope: 'tenant_setting/mail.smtp', field: 'x' };
    expect(canonicalSecretContext(valid)).toBe(`${TENANT}|tenant_setting/mail.smtp|x`);
    for (const broken of [
      { ...valid, tenantId: '' },
      { ...valid, scope: 'a|b' },
      { ...valid, field: 'x\u0000' },
      { ...valid, field: 'x\u007f' },
      { ...valid, scope: 's'.repeat(201) },
      { ...valid, tenantId: undefined as unknown as string },
    ]) {
      expect(() => canonicalSecretContext(broken)).toThrow(/Secret-Box-Kontext/);
    }
  });
});
