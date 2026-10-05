// =============================================================================
// Ablageorte der Secret-Box und ihre gebundenen Zusatzdaten (S-08)
//
// Jeder v3-Wert ist per AAD an Tenant, Ablageort (Scope) und Feld gebunden.
// Die Kontexte entstehen ausschließlich hier, damit Schreib- und Lesepfade
// sowie das Re-Wrap-Kommando denselben Wortlaut verwenden. Ein in der
// Datenbank in einen anderen Tenant, eine andere Zeile, ein anderes Setting
// oder Feld kopierter Wert lässt sich dadurch nicht mehr entschlüsseln.
//
// Wortlaut je Ablageort (`<tenantId>|<scope>|<field>`):
//   tenant_setting      <tenantId>|tenant_setting/<key>|<JSON-Feld>
//   eine Zeile je Tenant <tenantId>|<tabelle>|<spalte>   (n8n_connection)
//   mehrere Zeilen      <tenantId>|<tabelle>/<id>|<spalte> (inbound_mailbox)
// =============================================================================

/** Bindung eines verschlüsselten Werts an seinen Ablageort (AAD). */
export interface SecretContext {
  /** Kanzlei-Tenant, dem der Wert gehört. */
  readonly tenantId: string;
  /** Ablageort, z. B. `tenant_setting/mail.smtp` oder `inbound_mailbox/<id>`. */
  readonly scope: string;
  /** Feld bzw. Spalte innerhalb des Ablageorts. */
  readonly field: string;
}

const CONTEXT_PART_MAX = 200;

/**
 * Nicht leer, höchstens 200 Zeichen, ohne Trennzeichen `|` und ohne
 * Steuerzeichen: Damit ist die Verkettung eindeutig und kein Bestandteil kann
 * einen anderen vortäuschen.
 */
function isContextPart(part: unknown): part is string {
  if (typeof part !== 'string' || part.length === 0 || part.length > CONTEXT_PART_MAX) {
    return false;
  }
  for (let index = 0; index < part.length; index++) {
    const code = part.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 0x7c) return false;
  }
  return true;
}

/** Kanonische AAD-Form `<tenantId>|<scope>|<field>`; wirft bei ungültigem Kontext. */
export function canonicalSecretContext(context: SecretContext): string {
  const parts = [context?.tenantId, context?.scope, context?.field];
  if (!parts.every(isContextPart)) throw new Error('Ungültiger Secret-Box-Kontext.');
  return parts.join('|');
}

/** Persistenter Ablageort eines Secret-Box-Werts. */
export type SecretSlot =
  | {
      readonly kind: 'tenant_setting';
      /** Schlüssel in `tenant_setting`. */
      readonly key: string;
      /** Eigenschaft im JSON-Wert. */
      readonly field: string;
    }
  | {
      readonly kind: 'column';
      readonly table: 'n8n_connection';
      readonly column: 'api_key_encrypted' | 'signing_secret_encrypted';
      /** Genau eine Zeile je Tenant: der Tenant identifiziert die Zeile. */
      readonly row: 'tenant';
    }
  | {
      readonly kind: 'column';
      readonly table: 'inbound_mailbox';
      readonly column: 'secret_enc' | 'oauth_cache_enc';
      /** Mehrere Zeilen je Tenant: die Zeilen-ID gehört zum Kontext. */
      readonly row: 'id';
    };

/**
 * Alle persistenten Secret-Box-Felder. Neue Felder müssen hier eingetragen
 * werden; das Re-Wrap-Kommando (`pnpm secret-box:rewrap`) bearbeitet genau
 * diese Liste.
 */
export const SECRET_SLOTS = {
  smtpPassword: { kind: 'tenant_setting', key: 'mail.smtp', field: 'passwordEncrypted' },
  legacyN8nHmacSecret: { kind: 'tenant_setting', key: 'integrations.n8n', field: 'hmacEncrypted' },
  legacyN8nApiKey: { kind: 'tenant_setting', key: 'integrations.n8n', field: 'apiKeyEncrypted' },
  quantenlosIbmToken: { kind: 'tenant_setting', key: 'quantenlos.ibm', field: 'tokenEncrypted' },
  n8nApiKey: {
    kind: 'column',
    table: 'n8n_connection',
    column: 'api_key_encrypted',
    row: 'tenant',
  },
  n8nSigningSecret: {
    kind: 'column',
    table: 'n8n_connection',
    column: 'signing_secret_encrypted',
    row: 'tenant',
  },
  mailboxSecret: { kind: 'column', table: 'inbound_mailbox', column: 'secret_enc', row: 'id' },
  mailboxOauthCache: {
    kind: 'column',
    table: 'inbound_mailbox',
    column: 'oauth_cache_enc',
    row: 'id',
  },
} as const satisfies Record<string, SecretSlot>;

export type SecretSlotName = keyof typeof SECRET_SLOTS;

/** Kontext eines persistenten Werts; `rowId` ist für Tabellen mit mehreren Zeilen je Tenant Pflicht. */
export function secretSlotContext(
  slot: SecretSlot,
  ref: { tenantId: string; rowId?: string },
): SecretContext {
  if (slot.kind === 'tenant_setting') {
    return { tenantId: ref.tenantId, scope: `tenant_setting/${slot.key}`, field: slot.field };
  }
  if (slot.row === 'tenant') {
    return { tenantId: ref.tenantId, scope: slot.table, field: slot.column };
  }
  if (!ref.rowId) throw new Error('Ungültiger Secret-Box-Kontext.');
  return { tenantId: ref.tenantId, scope: `${slot.table}/${ref.rowId}`, field: slot.column };
}

/**
 * Kurzlebiger PKCE-/State-Cookie der Microsoft-Postfachanbindung. Nicht
 * persistent (fünf Minuten) und daher nicht Teil des Re-Wraps; gebunden an
 * Tenant und anfordernde Person.
 */
export function mailboxOauthStateContext(tenantId: string, staffId: string): SecretContext {
  return { tenantId, scope: `cookie/tt-mailbox-oauth/${staffId}`, field: 'payload' };
}
