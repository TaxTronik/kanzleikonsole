// =============================================================================
// Mail-Outbox — Versandaufträge für Mandanten-Mails (Review-Befund F-08)
//
// Vorher gingen elf Mandanten-Mails nach dem fachlichen Commit per nicht
// abgewarteter Promise direkt an SMTP; ein Fehler wurde geloggt und
// aufgegeben. Jetzt schreibt die Web-App im SELBEN Commit wie der Vorgang einen
// Versandauftrag (mail_outbox), und der Worker (mail-outbox-deliver) stellt ihn
// mit genau denselben Optionen über sendTemplateMail bzw. notifyClientContacts
// zu — Inhalt, Empfängerauflösung und Opt-out-Prüfung bleiben damit identisch.
//
// Dieses Modul ist der gemeinsame Vertrag beider Seiten: Payload-Form,
// JSON-Prüfung, Secret-Box-Bindung geheimer Variablen und die Rückübersetzung
// in Versandoptionen. Zustellung, Retry und Eskalation leben im Worker.
// =============================================================================

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { decryptSecret, encryptSecret, SECRET_SLOTS, secretSlotContext } from '@taxtronik/crypto';
import { isAllowedN8nEvent, type N8nEventName } from '@taxtronik/n8n-shared';
import type { ContactDispatchOptions, DispatchOptions, TemplateFallback } from './dispatch';
import type { MailAttachment } from './send';
import type { MailOutboxPurpose, MailOutboxResourceType } from './outbox-purposes';

export {
  MAIL_OUTBOX_PURPOSES,
  MAIL_OUTBOX_PURPOSE_LABELS,
  type MailOutboxPurpose,
  type MailOutboxResourceType,
} from './outbox-purposes';
export {
  checkMailOutboxRelevanceTx,
  type MailOutboxRelevance,
  type MailOutboxRelevanceReader,
  type MailOutboxRelevanceRow,
} from './outbox-relevance';

export interface MailOutboxTarget {
  tenantId: string;
  clientId: string;
  purpose: MailOutboxPurpose;
  resource: { type: MailOutboxResourceType; id: string };
  /** Ziel der Kanzlei-Benachrichtigung bei endgültigem Fehlschlag. */
  staffHref: string;
}

/** Anhang als Verweis auf eine gespeicherte Dokumentfassung (keine Bytes in der DB). */
export interface OutboxAttachmentRef {
  documentVersionId: string;
  filename: string;
  contentType?: string;
}

interface OutboxMailBase {
  /** System-Slug der EmailTemplate. */
  slug: string;
  vars: Record<string, unknown>;
  fallback?: TemplateFallback;
  subjectSuffix?: string;
  n8nEvent?: N8nEventName;
  n8nPayload?: Record<string, unknown>;
}

/** Eine Template-Mail an genau eine Adresse (Semantik von sendTemplateMail). */
export interface OutboxDirectMail extends OutboxMailBase {
  to: string;
  replyTo?: string;
  attachments?: OutboxAttachmentRef[];
  /**
   * Variablen, die nur Secret-Box-verschlüsselt gespeichert werden dürfen
   * (z. B. Einladungslink mit Token). Sie werden beim Versand in `vars`
   * eingesetzt und mit dem Terminalstatus gelöscht.
   */
  secretVars?: Record<string, string>;
}

/** Template-Mail an die bestätigten Kontakte (Semantik von notifyClientContacts). */
export type OutboxContactMail = OutboxMailBase;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Gespeicherte Form (Version 1); bis zum Terminalstatus im Auftrag. */
export interface MailOutboxPayload {
  v: 1;
  slug: string;
  to?: string;
  vars: JsonObject;
  fallback?: TemplateFallback;
  replyTo?: string;
  subjectSuffix?: string;
  n8nEvent?: N8nEventName;
  n8nPayload?: JsonObject;
  attachments?: OutboxAttachmentRef[];
}

/** Der Auftrag ist nicht (mehr) versendbar; kein SMTP-Kontakt hat stattgefunden. */
export class MailOutboxPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailOutboxPayloadError';
  }
}

export type MailOutboxWriter = Pick<Prisma.TransactionClient, 'mailOutbox'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Prüft, dass ein Wert verlustfrei als JSON gespeichert werden kann. Ein
 * Date, Decimal oder BigInt würde nach dem Speichern anders gerendert als
 * heute im Speicher (String(value)); das fällt hier sofort auf statt in der
 * Mail. `undefined`-Felder entfallen wie bei JSON.stringify — fehlende und
 * undefinierte Variablen rendert renderTemplate gleich (leer).
 */
function toJson(value: unknown, path: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: Zahl ist nicht endlich.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => toJson(item, `${path}[${index}]`) ?? null);
  }
  if (isPlainObject(value)) return toJsonObject(value, path);
  throw new TypeError(`${path}: Wert ist nicht verlustfrei als JSON speicherbar.`);
}

function toJsonObject(value: Record<string, unknown>, path: string): JsonObject {
  const result: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    const json = toJson(entry, `${path}.${key}`);
    if (json !== undefined) result[key] = json;
  }
  return result;
}

function definedOnly<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function assertTarget(target: MailOutboxTarget): void {
  if (!UUID.test(target.resource.id)) {
    throw new TypeError('Mail-Outbox: Vorgangs-ID ist keine UUID.');
  }
  if (!target.staffHref.startsWith('/staff/')) {
    throw new TypeError('Mail-Outbox: Kanzlei-Link muss auf /staff/ zeigen.');
  }
}

function basePayload(mail: OutboxMailBase): MailOutboxPayload {
  if (mail.n8nEvent && !isAllowedN8nEvent(mail.n8nEvent)) {
    throw new TypeError(`Mail-Outbox: n8n-Ereignis ${mail.n8nEvent} ist nicht freigegeben.`);
  }
  return definedOnly({
    v: 1 as const,
    slug: mail.slug,
    vars: toJsonObject(mail.vars, 'vars'),
    fallback: mail.fallback
      ? { subject: mail.fallback.subject, bodyMd: mail.fallback.bodyMd }
      : undefined,
    subjectSuffix: mail.subjectSuffix,
    n8nEvent: mail.n8nEvent,
    n8nPayload: mail.n8nPayload ? toJsonObject(mail.n8nPayload, 'n8nPayload') : undefined,
  });
}

function secretContext(tenantId: string, outboxId: string) {
  return secretSlotContext(SECRET_SLOTS.mailOutboxSecretVars, { tenantId, rowId: outboxId });
}

function sealSecretVars(
  tenantId: string,
  outboxId: string,
  vars: Record<string, unknown>,
  secretVars: Record<string, string> | undefined,
): string | null {
  if (!secretVars || Object.keys(secretVars).length === 0) return null;
  for (const [key, value] of Object.entries(secretVars)) {
    if (typeof value !== 'string') throw new TypeError(`secretVars.${key}: kein Text.`);
    if (key in vars) throw new TypeError(`secretVars.${key}: kollidiert mit vars.${key}.`);
  }
  return encryptSecret(JSON.stringify(secretVars), secretContext(tenantId, outboxId));
}

/** Stabiler n8n-Dedupe-Schlüssel eines Versandauftrags. */
export function mailOutboxN8nDedupeKey(outboxId: string): string {
  return `mail-outbox:${outboxId}`;
}

/**
 * Legt eine Template-Mail an genau eine Adresse als Versandauftrag an — in der
 * übergebenen Transaktion des fachlichen Vorgangs (RLS-Kontext des Tenants).
 */
export async function enqueueDirectMailTx(
  tx: MailOutboxWriter,
  target: MailOutboxTarget,
  mail: OutboxDirectMail,
): Promise<string> {
  assertTarget(target);
  const id = randomUUID();
  const payload: MailOutboxPayload = definedOnly({
    ...basePayload(mail),
    to: mail.to,
    replyTo: mail.replyTo,
    attachments: mail.attachments?.map((attachment) =>
      definedOnly({
        documentVersionId: attachment.documentVersionId,
        filename: attachment.filename,
        contentType: attachment.contentType,
      }),
    ),
  });
  await tx.mailOutbox.create({
    data: {
      id,
      tenantId: target.tenantId,
      clientId: target.clientId,
      kind: 'DIRECT',
      purpose: target.purpose,
      resourceType: target.resource.type,
      resourceId: target.resource.id,
      staffHref: target.staffHref,
      payload: payload as unknown as Prisma.InputJsonObject,
      secretVarsEnc: sealSecretVars(target.tenantId, id, mail.vars, mail.secretVars),
    },
  });
  return id;
}

/**
 * Legt eine Mail an alle bestätigten Kontakte des Mandanten als Versandauftrag
 * an. Die Empfänger löst der Worker beim Versand auf — wie bisher unmittelbar
 * nach dem Commit, mit derselben Opt-in-/Portal-Login-Prüfung.
 */
export async function enqueueClientContactsMailTx(
  tx: MailOutboxWriter,
  target: MailOutboxTarget,
  mail: OutboxContactMail,
): Promise<string> {
  assertTarget(target);
  const id = randomUUID();
  await tx.mailOutbox.create({
    data: {
      id,
      tenantId: target.tenantId,
      clientId: target.clientId,
      kind: 'CLIENT_CONTACTS',
      purpose: target.purpose,
      resourceType: target.resource.type,
      resourceId: target.resource.id,
      staffHref: target.staffHref,
      payload: basePayload(mail) as unknown as Prisma.InputJsonObject,
    },
  });
  return id;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new MailOutboxPayloadError(`payload.${key} ist kein Text.`);
  return value;
}

function parseAttachments(value: unknown): OutboxAttachmentRef[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new MailOutboxPayloadError('payload.attachments ist keine Liste.');
  return value.map((entry) => {
    if (!isPlainObject(entry)) throw new MailOutboxPayloadError('Ungültiger Anhangsverweis.');
    const documentVersionId = stringField(entry, 'documentVersionId');
    const filename = stringField(entry, 'filename');
    if (!documentVersionId || !UUID.test(documentVersionId) || !filename) {
      throw new MailOutboxPayloadError('Ungültiger Anhangsverweis.');
    }
    return definedOnly({
      documentVersionId,
      filename,
      contentType: stringField(entry, 'contentType'),
    });
  });
}

/** Liest den gespeicherten Payload; wirft MailOutboxPayloadError bei fremder Form. */
export function parseMailOutboxPayload(value: unknown): MailOutboxPayload {
  if (!isPlainObject(value) || value['v'] !== 1) {
    throw new MailOutboxPayloadError('Versandauftrag ohne gültigen Payload.');
  }
  const slug = stringField(value, 'slug');
  if (!slug) throw new MailOutboxPayloadError('Versandauftrag ohne Template-Slug.');
  const vars = value['vars'];
  if (!isPlainObject(vars)) throw new MailOutboxPayloadError('payload.vars ist kein Objekt.');
  const fallback = value['fallback'];
  if (
    fallback !== undefined &&
    !(
      isPlainObject(fallback) &&
      typeof fallback['subject'] === 'string' &&
      typeof fallback['bodyMd'] === 'string'
    )
  ) {
    throw new MailOutboxPayloadError('payload.fallback ist ungültig.');
  }
  const n8nEvent = stringField(value, 'n8nEvent');
  if (n8nEvent !== undefined && !isAllowedN8nEvent(n8nEvent)) {
    throw new MailOutboxPayloadError('payload.n8nEvent ist nicht freigegeben.');
  }
  const n8nPayload = value['n8nPayload'];
  if (n8nPayload !== undefined && !isPlainObject(n8nPayload)) {
    throw new MailOutboxPayloadError('payload.n8nPayload ist kein Objekt.');
  }
  return definedOnly({
    v: 1 as const,
    slug,
    to: stringField(value, 'to'),
    vars: vars as JsonObject,
    fallback: fallback as TemplateFallback | undefined,
    replyTo: stringField(value, 'replyTo'),
    subjectSuffix: stringField(value, 'subjectSuffix'),
    n8nEvent: n8nEvent as N8nEventName | undefined,
    n8nPayload: n8nPayload as JsonObject | undefined,
    attachments: parseAttachments(value['attachments']),
  });
}

/** Entschlüsselt die geheimen Variablen eines Auftrags (an Tenant und Zeile gebunden). */
export function openMailOutboxSecretVars(row: {
  id: string;
  tenantId: string;
  secretVarsEnc: string | null;
}): Record<string, string> {
  if (!row.secretVarsEnc) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(row.secretVarsEnc, secretContext(row.tenantId, row.id)));
  } catch {
    throw new MailOutboxPayloadError('Geheime Variablen des Versandauftrags nicht lesbar.');
  }
  if (!isPlainObject(parsed) || Object.values(parsed).some((value) => typeof value !== 'string')) {
    throw new MailOutboxPayloadError('Geheime Variablen des Versandauftrags sind ungültig.');
  }
  return parsed as Record<string, string>;
}

export type MailOutboxDispatch =
  | { kind: 'DIRECT'; options: DispatchOptions }
  | { kind: 'CLIENT_CONTACTS'; options: ContactDispatchOptions };

/**
 * Übersetzt einen Auftrag zurück in genau die Versandoptionen, die vorher
 * direkt an sendTemplateMail bzw. notifyClientContacts gingen — ergänzt nur
 * um den n8n-Dedupe-Schlüssel des Auftrags.
 */
export function mailOutboxDispatch(
  row: { id: string; tenantId: string; clientId: string; kind: 'DIRECT' | 'CLIENT_CONTACTS' },
  payload: MailOutboxPayload,
  secretVars: Record<string, string>,
  attachments: MailAttachment[],
): MailOutboxDispatch {
  const common = definedOnly({
    tenantId: row.tenantId,
    clientId: row.clientId,
    slug: payload.slug,
    vars: { ...payload.vars, ...secretVars },
    fallback: payload.fallback,
    subjectSuffix: payload.subjectSuffix,
    n8nEvent: payload.n8nEvent,
    n8nPayload: payload.n8nPayload,
    n8nDedupeKey: payload.n8nEvent ? mailOutboxN8nDedupeKey(row.id) : undefined,
  });
  if (row.kind === 'CLIENT_CONTACTS') {
    if (payload.to !== undefined || payload.attachments !== undefined) {
      throw new MailOutboxPayloadError('Kontakt-Versandauftrag mit Einzeladresse oder Anhang.');
    }
    return { kind: 'CLIENT_CONTACTS', options: common };
  }
  if (!payload.to) throw new MailOutboxPayloadError('Versandauftrag ohne Empfängeradresse.');
  return {
    kind: 'DIRECT',
    options: definedOnly({
      ...common,
      to: payload.to,
      replyTo: payload.replyTo,
      attachments: attachments.length > 0 ? attachments : undefined,
    }),
  };
}
