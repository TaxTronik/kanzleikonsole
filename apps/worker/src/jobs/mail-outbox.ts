// =============================================================================
// Mail-Outbox-Zustellung — Kern des Jobs mail-outbox-deliver (Review-Befund F-08)
//
// Die Web-App schreibt Versandaufträge im fachlichen Commit (mail_outbox) und
// stößt diesen Job danach an; ein Minutentakt holt verlorene Anstöße und
// fällige Wiederholungen nach. Der Zustandsautomat folgt dem bewährten Pfad
// der Steuertermin-Benachrichtigungen (tax-deadline-notification.ts):
//
//   - SENDING ist ein fail-closed In-Flight-Claim (CAS vor jedem externen I/O).
//     Stirbt der Prozess nach einer möglichen Provider-Annahme, wird nach
//     30 Minuten nicht erneut gesendet, sondern UNKNOWN eskaliert.
//   - Nur eindeutig gescheiterte Versuche ohne angenommenen Empfänger werden
//     wiederholt (RETRY_PENDING, exponentieller Backoff, höchstens sechs
//     Versuche wie die n8n-Zustellung); danach FAILED. Eindeutig ist eine
//     ausdrückliche Provider-Ablehnung, ein Fehler beim Vorbereiten des Auftrags
//     und (A7) eine nicht lesbare oder ungültige SMTP-Konfiguration der Kanzlei
//     — die beiden letzten entstehen vor jedem SMTP-Kontakt.
//   - Unklarer Ausgang (UNKNOWN) und Teilzustellung (PARTIAL_FAILURE) werden
//     wegen des Doppelversandrisikos nie automatisch wiederholt.
//   - FAILED, UNKNOWN und PARTIAL_FAILURE erzeugen eine Kanzlei-Benachrichtigung
//     (SYSTEM_MAIL_FAILED) am Vorgang. NO_RECIPIENT (kein bestätigter Kontakt
//     mit Benachrichtigungen) bleibt wie bisher ohne Mail und ohne Hinweis,
//     ist aber am Vorgang sichtbar.
//   - Vor jedem Versuch (auch jedem Retry) prüft der Claim in derselben
//     Tenant-Transaktion, ob die Mail noch gewollt ist
//     (checkMailOutboxRelevanceTx: zurückgezogene Einladung, abgesagter
//     Termin, geschlossene Anforderung, ...). Sonst endet der Auftrag ohne
//     SMTP-Kontakt als SKIPPED mit Begründung in last_error, ohne
//     Kanzlei-Benachrichtigung.
//
// Ein n8n-Ereignis der Mail trägt den Dedupe-Schlüssel des Auftrags; ein
// Retry erzeugt deshalb kein zweites Ereignis. Mit dem Terminalstatus werden
// Payload (Empfänger, Variablen, Anhangsverweise) und geheime Variablen
// entfernt.
// =============================================================================

import type { Prisma } from '@prisma/client';
import type {
  ContactDispatchOptions,
  ContactNotificationResult,
  DispatchOptions,
  MailAttachment,
  TemplateMailResult,
} from '@taxtronik/mail';
import {
  checkMailOutboxRelevanceTx,
  MAIL_OUTBOX_PURPOSE_LABELS,
  mailOutboxDispatch,
  openMailOutboxSecretVars,
  parseMailOutboxPayload,
  type MailOutboxPurpose,
  type OutboxAttachmentRef,
} from '@taxtronik/mail/outbox';
import type { NotifyInput } from '../notify';

/** Wie DELIVERY_JOB_OPTIONS der n8n-Zustellung: sechs Versuche, Basis 60 s. */
export const MAIL_OUTBOX_MAX_ATTEMPTS = 6;
const RETRY_BASE_DELAY_MS = 60_000;
/** Wie die Steuertermin-Benachrichtigung: danach gilt ein Claim als abgebrochen. */
export const MAIL_OUTBOX_IN_FLIGHT_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_BATCH_SIZE = 25;

type Db = Prisma.TransactionClient;

/** Ressourcentypen, die app.notification_resource_scope kennt; sonst der Mandant. */
const NOTIFICATION_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'invoice',
  'request',
  'gwg_check',
  'gwg_onboarding_invite',
  'appointment_request',
]);

export interface MailOutboxDeliveryDeps {
  /** Owner-Client (BYPASSRLS) für den mandantenübergreifenden Scan. */
  db: Pick<Db, 'mailOutbox'>;
  /** Tenant-Transaktion für Statuswechsel samt Kanzlei-Benachrichtigung. */
  runAtomic: <T>(tenantId: string, fn: (tx: Db) => Promise<T>) => Promise<T>;
  sendTemplateMail: (options: DispatchOptions) => Promise<TemplateMailResult>;
  notifyClientContacts: (options: ContactDispatchOptions) => Promise<ContactNotificationResult>;
  loadAttachment: (input: {
    tenantId: string;
    ref: OutboxAttachmentRef;
  }) => Promise<MailAttachment>;
  notifyStaff: (tx: Db, input: NotifyInput) => Promise<unknown>;
  log: {
    info(obj: Record<string, unknown>, msg: string): void;
    warn(obj: Record<string, unknown>, msg: string): void;
    error(obj: Record<string, unknown>, msg: string): void;
  };
}

export interface MailOutboxStats {
  processed: number;
  providerAccepted: number;
  retryPending: number;
  noRecipient: number;
  escalated: number;
  /** Vor dem Versand verworfen (SKIPPED), weil der Vorgang nicht mehr aktuell ist. */
  skipped: number;
}

const candidateSelect = {
  id: true,
  tenantId: true,
  clientId: true,
  kind: true,
  purpose: true,
  resourceType: true,
  resourceId: true,
  staffHref: true,
  payload: true,
  secretVarsEnc: true,
  status: true,
  attemptCount: true,
} satisfies Prisma.MailOutboxSelect;

type Candidate = Prisma.MailOutboxGetPayload<{ select: typeof candidateSelect }>;
type Claimed = Candidate & { attemptNo: number; attemptAt: Date };
type Escalation = { title: string; body: string };

function purposeLabel(purpose: string): string {
  return MAIL_OUTBOX_PURPOSE_LABELS[purpose as MailOutboxPurpose] ?? 'Mandanten-E-Mail';
}

function retryDelayMs(attemptNo: number): number {
  return RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attemptNo - 1);
}

/** A7: Abbruch vor jedem SMTP-Kontakt; die Kanzlei muss ihre SMTP-Einstellungen prüfen. */
const SMTP_CONFIG_UNAVAILABLE_REASON =
  'Die SMTP-Konfiguration der Kanzlei war nicht lesbar oder ungültig; der Versand wurde vor jedem SMTP-Kontakt abgebrochen.';

interface DefiniteFailure {
  reason: string;
  /** Zusatz für die Kanzlei-Benachrichtigung nach dem letzten Versuch. */
  staffHint?: string;
}

function definiteFailure(reason: string): DefiniteFailure {
  return { reason };
}

function smtpConfigFailure(detail?: string): DefiniteFailure {
  return {
    reason: detail ? `${SMTP_CONFIG_UNAVAILABLE_REASON} ${detail}` : SMTP_CONFIG_UNAVAILABLE_REASON,
    staffHint: 'Bitte die SMTP-Einstellungen der Kanzlei prüfen.',
  };
}

/** Terminalstatus: Inhalt und geheime Variablen verlassen den Auftrag. */
const CLEARED_CONTENT = {
  payload: {} as Prisma.InputJsonObject,
  secretVarsEnc: null,
  nextAttemptAt: null,
} as const;

function staffNotification(
  row: Pick<Candidate, 'tenantId' | 'clientId' | 'resourceType' | 'resourceId' | 'staffHref'>,
  escalation: Escalation,
): NotifyInput {
  const resource = NOTIFICATION_RESOURCE_TYPES.has(row.resourceType)
    ? { resourceType: row.resourceType, resourceId: row.resourceId }
    : { resourceType: 'client', resourceId: row.clientId };
  return {
    tenantId: row.tenantId,
    clientId: row.clientId,
    staffId: null,
    kind: 'SYSTEM_MAIL_FAILED',
    title: escalation.title,
    body: escalation.body,
    href: row.staffHref,
    ...resource,
  };
}

type TenantScope = { tenantId?: string };

async function escalateStrandedSending(
  deps: MailOutboxDeliveryDeps,
  now: Date,
  batchSize: number,
  scope: TenantScope,
): Promise<number> {
  const cutoff = new Date(now.getTime() - MAIL_OUTBOX_IN_FLIGHT_TIMEOUT_MS);
  const stranded = await deps.db.mailOutbox.findMany({
    where: { ...scope, status: 'SENDING', lastAttemptAt: { lte: cutoff } },
    orderBy: [{ lastAttemptAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
    select: {
      id: true,
      tenantId: true,
      clientId: true,
      purpose: true,
      resourceType: true,
      resourceId: true,
      staffHref: true,
      lastAttemptAt: true,
    },
  });

  let escalated = 0;
  for (const row of stranded) {
    const changed = await deps.runAtomic(row.tenantId, async (tx) => {
      const update = await tx.mailOutbox.updateMany({
        where: { id: row.id, status: 'SENDING', lastAttemptAt: row.lastAttemptAt },
        data: {
          ...CLEARED_CONTENT,
          status: 'UNKNOWN',
          escalatedAt: now,
          lastError:
            'Ein gestarteter Versandversuch wurde nicht eindeutig abgeschlossen; kein automatischer Neuversand.',
        },
      });
      if (update.count !== 1) return false;
      await deps.notifyStaff(
        tx,
        staffNotification(row, {
          title: 'Versandstatus einer Mandanten-E-Mail unklar',
          body: `${purposeLabel(row.purpose)}: Der Versandversuch wurde nicht eindeutig abgeschlossen. Wegen des Doppelversandrisikos sendet TaxTronik nicht automatisch erneut; bitte Empfang beim Mandanten prüfen.`,
        }),
      );
      return true;
    });
    if (changed) escalated += 1;
  }
  return escalated;
}

type ClaimOutcome =
  | { kind: 'claimed'; row: Claimed }
  | { kind: 'skipped'; reason: string }
  | { kind: 'lost' };

/**
 * Prüft den Vorgang und beansprucht den Auftrag in EINER Tenant-Transaktion:
 * ist die Mail nicht mehr gewollt, endet er als SKIPPED (Inhalt entfernt);
 * sonst CAS nach SENDING vor jedem externen I/O. Beides ist an den gelesenen
 * Status und Versuchszähler gebunden.
 */
async function claimOrSkip(
  deps: MailOutboxDeliveryDeps,
  candidate: Candidate,
  now: Date,
): Promise<ClaimOutcome> {
  const attemptAt = new Date();
  const attemptNo = candidate.attemptCount + 1;
  const unchanged = {
    id: candidate.id,
    status: candidate.status,
    attemptCount: candidate.attemptCount,
  };
  return deps.runAtomic(candidate.tenantId, async (tx): Promise<ClaimOutcome> => {
    const relevance = await checkMailOutboxRelevanceTx(tx, candidate, now);
    if (!relevance.wanted) {
      const skipped = await tx.mailOutbox.updateMany({
        where: unchanged,
        data: {
          ...CLEARED_CONTENT,
          status: 'SKIPPED',
          lastError: `Nicht versendet: ${relevance.reason}`,
        },
      });
      return skipped.count === 1 ? { kind: 'skipped', reason: relevance.reason } : { kind: 'lost' };
    }
    const claimed = await tx.mailOutbox.updateMany({
      where: unchanged,
      data: {
        status: 'SENDING',
        attemptCount: { increment: 1 },
        lastAttemptAt: attemptAt,
        nextAttemptAt: null,
        lastError: 'Versandversuch gestartet; Providerstatus noch nicht bestimmt.',
      },
    });
    return claimed.count === 1
      ? { kind: 'claimed', row: { ...candidate, attemptNo, attemptAt } }
      : { kind: 'lost' };
  });
}

/** CAS auf genau den eigenen Claim; ein fremder oder eskalierter Zustand bleibt unberührt. */
function ownClaim(row: Claimed) {
  return {
    id: row.id,
    status: 'SENDING' as const,
    attemptCount: row.attemptNo,
    lastAttemptAt: row.attemptAt,
  };
}

async function persistTerminal(
  deps: MailOutboxDeliveryDeps,
  row: Claimed,
  input: {
    status: 'PROVIDER_ACCEPTED' | 'PARTIAL_FAILURE' | 'NO_RECIPIENT' | 'FAILED' | 'UNKNOWN';
    lastError: string | null;
    attempted?: number;
    accepted?: number;
    escalation?: Escalation;
  },
): Promise<boolean> {
  return deps.runAtomic(row.tenantId, async (tx) => {
    const update = await tx.mailOutbox.updateMany({
      where: ownClaim(row),
      data: {
        ...CLEARED_CONTENT,
        status: input.status,
        acceptedAt: input.status === 'PROVIDER_ACCEPTED' ? row.attemptAt : null,
        lastError: input.lastError,
        escalatedAt: input.escalation ? row.attemptAt : null,
        ...(input.attempted !== undefined ? { recipientsAttempted: input.attempted } : {}),
        ...(input.accepted !== undefined ? { recipientsAccepted: input.accepted } : {}),
      },
    });
    if (update.count !== 1) return false;
    if (input.escalation) await deps.notifyStaff(tx, staffNotification(row, input.escalation));
    return true;
  });
}

/** Eindeutig nicht versendet: Retry mit Backoff oder nach dem letzten Versuch FAILED. */
async function persistDefiniteFailure(
  deps: MailOutboxDeliveryDeps,
  row: Claimed,
  failure: DefiniteFailure,
  attempted: number | undefined,
  stats: MailOutboxStats,
): Promise<void> {
  const { reason } = failure;
  if (row.attemptNo >= MAIL_OUTBOX_MAX_ATTEMPTS) {
    const staffHint = failure.staffHint ? ` ${failure.staffHint}` : '';
    const changed = await persistTerminal(deps, row, {
      status: 'FAILED',
      lastError: `${reason} Versuch ${row.attemptNo} von ${MAIL_OUTBOX_MAX_ATTEMPTS}; kein weiterer automatischer Versuch.`,
      attempted,
      accepted: attempted === undefined ? undefined : 0,
      escalation: {
        title: 'E-Mail an Mandanten fehlgeschlagen',
        body: `${purposeLabel(row.purpose)}: Nach ${MAIL_OUTBOX_MAX_ATTEMPTS} eindeutig gescheiterten Versuchen wurde der automatische Versand beendet.${staffHint} Bitte Empfänger und Versandweg prüfen und den Mandanten gegebenenfalls direkt informieren.`,
      },
    });
    if (changed) stats.escalated += 1;
    return;
  }
  const update = await deps.runAtomic(row.tenantId, (tx) =>
    tx.mailOutbox.updateMany({
      where: ownClaim(row),
      data: {
        status: 'RETRY_PENDING',
        nextAttemptAt: new Date(row.attemptAt.getTime() + retryDelayMs(row.attemptNo)),
        lastError: `${reason} Versuch ${row.attemptNo} von ${MAIL_OUTBOX_MAX_ATTEMPTS}; erneuter Versuch geplant.`,
        ...(attempted !== undefined
          ? { recipientsAttempted: attempted, recipientsAccepted: 0 }
          : {}),
      },
    }),
  );
  if (update.count === 1) stats.retryPending += 1;
}

async function persistUncertain(
  deps: MailOutboxDeliveryDeps,
  row: Claimed,
  detail: { attempted?: number; accepted?: number },
  stats: MailOutboxStats,
): Promise<void> {
  const acceptedHint = detail.accepted
    ? `${detail.accepted} Mail-Einzelversuch(e) wurden sicher technisch angenommen; `
    : '';
  const changed = await persistTerminal(deps, row, {
    status: 'UNKNOWN',
    lastError: `${acceptedHint}mindestens ein Versuch endete ohne eindeutig bestimmbare Provider-Antwort. Kein automatischer Neuversand.`,
    attempted: detail.attempted,
    accepted: detail.accepted,
    escalation: {
      title: 'Versandstatus einer Mandanten-E-Mail unklar',
      body: `${purposeLabel(row.purpose)}: ${acceptedHint}der Versand endete ohne eindeutig bestimmbaren Providerstatus. Wegen des Doppelversandrisikos sendet TaxTronik nicht automatisch erneut; bitte Empfang beim Mandanten prüfen.`,
    },
  });
  if (changed) stats.escalated += 1;
}

async function persistDirectResult(
  deps: MailOutboxDeliveryDeps,
  row: Claimed,
  result: TemplateMailResult,
  hasFallback: boolean,
  stats: MailOutboxStats,
): Promise<void> {
  if (result.ok) {
    const changed = await persistTerminal(deps, row, {
      status: 'PROVIDER_ACCEPTED',
      lastError: null,
      attempted: 1,
      accepted: 1,
    });
    if (changed) stats.providerAccepted += 1;
    return;
  }
  if (result.uncertainFailure) {
    await persistUncertain(deps, row, { attempted: 1, accepted: 0 }, stats);
    return;
  }
  await persistDefiniteFailure(
    deps,
    row,
    result.smtpConfigUnavailable
      ? smtpConfigFailure()
      : definiteFailure(
          result.sentViaTemplate || hasFallback
            ? 'Der Mail-Provider hat die Nachricht ausdrücklich abgelehnt.'
            : 'Weder aktive Vorlage noch Ersatztext vorhanden.',
        ),
    1,
    stats,
  );
}

async function persistContactResult(
  deps: MailOutboxDeliveryDeps,
  row: Claimed,
  result: ContactNotificationResult,
  stats: MailOutboxStats,
): Promise<void> {
  if (result.attempted === 0) {
    const changed = await persistTerminal(deps, row, {
      status: 'NO_RECIPIENT',
      lastError:
        'Kein aktiver, per Portal-Login bestätigter Kontakt mit eingeschalteten Benachrichtigungen vorhanden.',
      attempted: 0,
      accepted: 0,
    });
    if (changed) stats.noRecipient += 1;
    return;
  }
  if (result.uncertainFailure) {
    await persistUncertain(
      deps,
      row,
      { attempted: result.attempted, accepted: result.recipients },
      stats,
    );
    return;
  }
  if (result.recipients === result.attempted) {
    const changed = await persistTerminal(deps, row, {
      status: 'PROVIDER_ACCEPTED',
      lastError: null,
      attempted: result.attempted,
      accepted: result.recipients,
    });
    if (changed) stats.providerAccepted += 1;
    return;
  }
  if (result.recipients > 0) {
    const changed = await persistTerminal(deps, row, {
      status: 'PARTIAL_FAILURE',
      lastError: `${result.recipients} von ${result.attempted} Mail-Einzelversuchen wurden vom Provider angenommen. Kein automatischer Neuversand wegen Doppelversandrisiko.`,
      attempted: result.attempted,
      accepted: result.recipients,
      escalation: {
        title: 'Mandanten-E-Mail nur teilweise zugestellt',
        body: `${purposeLabel(row.purpose)}: ${result.recipients} von ${result.attempted} Empfängern wurden technisch angenommen. Wegen des Doppelversandrisikos sendet TaxTronik nicht automatisch erneut; bitte die übrigen Kontakte prüfen.`,
      },
    });
    if (changed) stats.escalated += 1;
    return;
  }
  await persistDefiniteFailure(
    deps,
    row,
    result.smtpConfigUnavailable
      ? smtpConfigFailure(
          `Keiner von ${result.attempted} Mail-Einzelversuchen wurde an den Mail-Provider übergeben.`,
        )
      : definiteFailure(
          `Keiner von ${result.attempted} Mail-Einzelversuchen wurde vom Provider angenommen.`,
        ),
    result.attempted,
    stats,
  );
}

async function prepare(deps: MailOutboxDeliveryDeps, row: Claimed) {
  const payload = parseMailOutboxPayload(row.payload);
  const secretVars = openMailOutboxSecretVars(row);
  const attachments: MailAttachment[] = [];
  for (const ref of payload.attachments ?? []) {
    attachments.push(await deps.loadAttachment({ tenantId: row.tenantId, ref }));
  }
  return mailOutboxDispatch(row, payload, secretVars, attachments);
}

async function deliver(
  deps: MailOutboxDeliveryDeps,
  row: Claimed,
  stats: MailOutboxStats,
): Promise<void> {
  let dispatch: Awaited<ReturnType<typeof prepare>>;
  try {
    dispatch = await prepare(deps, row);
  } catch (error) {
    // Vor jedem SMTP-Kontakt gescheitert (Payload, Secret, Anhang): eindeutig
    // nicht versendet, also wiederholbar.
    deps.log.warn(
      { outboxId: row.id, tenantId: row.tenantId, errName: (error as Error).name },
      'mail-outbox: Versandauftrag konnte nicht vorbereitet werden',
    );
    await persistDefiniteFailure(
      deps,
      row,
      definiteFailure(
        'Der Versandauftrag konnte nicht vorbereitet werden (Inhalt oder Anhang nicht lesbar).',
      ),
      undefined,
      stats,
    );
    return;
  }

  let outcome:
    | { kind: 'DIRECT'; result: TemplateMailResult }
    | { kind: 'CLIENT_CONTACTS'; result: ContactNotificationResult };
  try {
    outcome =
      dispatch.kind === 'DIRECT'
        ? { kind: 'DIRECT', result: await deps.sendTemplateMail(dispatch.options) }
        : { kind: 'CLIENT_CONTACTS', result: await deps.notifyClientContacts(dispatch.options) };
  } catch (error) {
    // Eine Exception kann nach tatsächlicher Provider-Annahme auftreten
    // (z. B. beim nachgelagerten n8n-Ereignis): niemals blind erneut senden.
    deps.log.error(
      { outboxId: row.id, tenantId: row.tenantId, errName: (error as Error).name },
      'mail-outbox: Versandstatus unklar',
    );
    await persistUncertain(deps, row, {}, stats);
    return;
  }

  // Scheitert erst das Speichern des Ergebnisses, bleibt der Claim SENDING und
  // wird nach MAIL_OUTBOX_IN_FLIGHT_TIMEOUT_MS als UNKNOWN eskaliert.
  if (outcome.kind === 'DIRECT') {
    const hasFallback = dispatch.kind === 'DIRECT' && Boolean(dispatch.options.fallback);
    await persistDirectResult(deps, row, outcome.result, hasFallback, stats);
  } else {
    await persistContactResult(deps, row, outcome.result, stats);
  }
}

/**
 * Ein Lauf: hängende Claims eskalieren, dann höchstens `batchSize` fällige
 * Aufträge zustellen oder als nicht mehr gewollt verwerfen (älteste zuerst).
 * Liefert die Zahl der bearbeiteten (`processed`) und verworfenen (`skipped`)
 * Aufträge, damit der Job bei vollem Batch weiterlaufen kann. Ohne `tenantId`
 * mandantenübergreifend (Regelbetrieb), sonst nur dieser Tenant.
 */
export async function processMailOutbox(
  deps: MailOutboxDeliveryDeps,
  input: { now?: Date; batchSize?: number; tenantId?: string } = {},
): Promise<MailOutboxStats> {
  const now = input.now ?? new Date();
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const scope: TenantScope = input.tenantId ? { tenantId: input.tenantId } : {};
  const stats: MailOutboxStats = {
    processed: 0,
    providerAccepted: 0,
    retryPending: 0,
    noRecipient: 0,
    escalated: await escalateStrandedSending(deps, now, batchSize, scope),
    skipped: 0,
  };

  const candidates = await deps.db.mailOutbox.findMany({
    where: {
      ...scope,
      status: { in: ['QUEUED', 'RETRY_PENDING'] },
      nextAttemptAt: { lte: now },
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    take: batchSize,
    select: candidateSelect,
  });

  for (const candidate of candidates) {
    const outcome = await claimOrSkip(deps, candidate, now);
    if (outcome.kind === 'skipped') {
      stats.skipped += 1;
      deps.log.info(
        {
          outboxId: candidate.id,
          tenantId: candidate.tenantId,
          purpose: candidate.purpose,
          reason: outcome.reason,
        },
        'mail-outbox: Versandauftrag verworfen, Vorgang nicht mehr aktuell',
      );
      continue;
    }
    if (outcome.kind === 'lost') continue;
    stats.processed += 1;
    await deliver(deps, outcome.row, stats);
  }
  return stats;
}
