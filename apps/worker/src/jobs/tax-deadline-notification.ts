// =============================================================================
// Persistierter Benachrichtigungsfluss fuer automatische Steuertermin-
// Anforderungen. Fachkatalog: TAX-DEADLINE-AUTOREQUEST-001.
//
// Die Portal-Anforderung existiert zu diesem Zeitpunkt bereits. Dieser
// Baustein erzeugt deshalb niemals einen Request, sondern arbeitet immer mit
// derselben requestId. Provider-Annahme, tatsaechliche Zustellung und
// Kenntnisnahme sind bewusst verschiedene Aussagen; wir persistieren hier nur
// die erste davon.
// =============================================================================

import type {
  Prisma,
  RequestPriority,
  RequestStatus,
  TaxDeadlineNotificationStatus,
} from '@prisma/client';
import type { AutomaticTaxRequestOpenedInput } from '@taxtronik/mail';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 4 * 60_000;
const IN_FLIGHT_TIMEOUT_MS = 30 * 60_000;
const WORKER_ELIGIBLE_STATUSES = new Set<TaxDeadlineNotificationStatus>(['QUEUED', 'FAILED']);
const ACTIVE_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS'] as const satisfies readonly RequestStatus[];
const ACTIVE_REQUEST_STATUS_SET = new Set<RequestStatus>(ACTIVE_REQUEST_STATUSES);

type Db = Prisma.TransactionClient;

interface StaffNotificationInput {
  tenantId: string;
  staffId: null;
  kind: 'TAX_DEADLINE_NOTIFICATION_FAILED';
  title: string;
  body: string;
  href: string;
  resourceType: 'tax_deadline';
  resourceId: string;
}

export interface TaxDeadlineNotificationDeps {
  db: Db;
  runAtomic: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  notifyAutomaticTaxRequestOpened: (input: AutomaticTaxRequestOpenedInput) => Promise<{
    ok: boolean;
    recipients: number;
    attempted: number;
    externalSideEffectOccurred: boolean;
    uncertainFailure: boolean;
  }>;
  upsertStaffNotification: (tx: Db, input: StaffNotificationInput) => Promise<unknown>;
  resolveFailureNotifications: (
    tx: Db,
    input: { tenantId: string; deadlineId: string },
  ) => Promise<unknown>;
  logUncertainError?: (input: {
    tenantId: string;
    deadlineId: string;
    requestId: string;
    error: unknown;
  }) => void;
}

export interface TaxDeadlineNotificationStats {
  processed: number;
  providerAccepted: number;
  recipientsAccepted: number;
  retryPending: number;
  escalated: number;
}

const candidateSelect = {
  id: true,
  tenantId: true,
  clientId: true,
  requestId: true,
  dueDate: true,
  autoRequestNotificationStatus: true,
  autoRequestNotificationAttemptCount: true,
  autoRequestNotificationNextAttemptAt: true,
  request: {
    select: {
      id: true,
      priority: true,
      status: true,
      dueAt: true,
    },
  },
} satisfies Prisma.TaxDeadlineSelect;

type Candidate = Prisma.TaxDeadlineGetPayload<{ select: typeof candidateSelect }>;

function failureNotification(
  candidate: Pick<Candidate, 'id' | 'tenantId' | 'requestId'>,
  title: string,
  body: string,
): StaffNotificationInput {
  return {
    tenantId: candidate.tenantId,
    staffId: null,
    kind: 'TAX_DEADLINE_NOTIFICATION_FAILED',
    title,
    body,
    href: candidate.requestId ? `/staff/requests/${candidate.requestId}` : '/staff/tax-deadlines',
    resourceType: 'tax_deadline',
    resourceId: candidate.id,
  };
}

async function escalateStrandedUnknown(
  deps: TaxDeadlineNotificationDeps,
  tenantId: string,
  now: Date,
): Promise<number> {
  const stranded = await deps.db.taxDeadline.findMany({
    where: {
      tenantId,
      autoRequestNotificationStatus: 'UNKNOWN',
      autoRequestNotificationEscalatedAt: null,
      autoRequestNotificationLastAttemptAt: {
        lte: new Date(now.getTime() - IN_FLIGHT_TIMEOUT_MS),
      },
    },
    select: { id: true, tenantId: true, requestId: true },
  });

  let escalated = 0;
  for (const candidate of stranded) {
    await deps.runAtomic(async (tx) => {
      const changed = await tx.taxDeadline.updateMany({
        where: {
          id: candidate.id,
          tenantId,
          autoRequestNotificationStatus: 'UNKNOWN',
          autoRequestNotificationEscalatedAt: null,
          autoRequestNotificationLastAttemptAt: {
            lte: new Date(now.getTime() - IN_FLIGHT_TIMEOUT_MS),
          },
        },
        data: {
          autoRequestNotificationEscalatedAt: now,
          autoRequestNotificationNextAttemptAt: null,
          autoRequestNotificationLastError:
            'Ein gestarteter Versandversuch wurde nicht eindeutig abgeschlossen; kein automatischer Neuversand.',
        },
      });
      if (changed.count === 0) return;
      await deps.upsertStaffNotification(
        tx,
        failureNotification(
          candidate,
          'Versandstatus einer Auto-Anforderung ist unklar',
          'Der technische Versandversuch wurde nicht eindeutig abgeschlossen. Bitte Empfänger und Versand manuell prüfen; TaxTronik sendet nicht automatisch erneut.',
        ),
      );
      escalated += 1;
    });
  }
  return escalated;
}

async function claimAttempt(
  deps: TaxDeadlineNotificationDeps,
  candidate: Candidate,
  attemptAt: Date,
): Promise<number | null> {
  const attemptNo = candidate.autoRequestNotificationAttemptCount + 1;
  const claimed = await deps.runAtomic((tx) =>
    tx.taxDeadline.updateMany({
      where: {
        id: candidate.id,
        tenantId: candidate.tenantId,
        requestId: candidate.requestId,
        autoRequestNotificationStatus: candidate.autoRequestNotificationStatus,
        autoRequestNotificationAttemptCount: candidate.autoRequestNotificationAttemptCount,
        autoRequestNotificationNextAttemptAt: candidate.autoRequestNotificationNextAttemptAt,
        // TAX-DEADLINE-AUTOREQUEST-001: Der Request-Status wird im selben
        // atomaren UPDATE wie der In-Flight-Claim geprueft. Ein zwischen dem
        // Kandidaten-Read und dem Claim geschlossener/stornierter Request darf
        // damit kein externes I/O mehr ausloesen.
        request: { status: { in: [...ACTIVE_REQUEST_STATUSES] } },
      },
      data: {
        // UNKNOWN ist gleichzeitig ein fail-closed In-Flight-Claim: stirbt der
        // Prozess nach einer moeglichen Provider-Annahme, darf der naechste
        // Lauf nicht blind noch einmal senden.
        autoRequestNotificationStatus: 'UNKNOWN',
        autoRequestNotificationAttemptCount: { increment: 1 },
        autoRequestNotificationLastAttemptAt: attemptAt,
        autoRequestNotificationNextAttemptAt: null,
        autoRequestNotificationAcceptedAt: null,
        autoRequestNotificationLastError:
          'Versandversuch gestartet; Providerstatus noch nicht bestimmt.',
      },
    }),
  );
  return claimed.count === 1 ? attemptNo : null;
}

async function orphanNotificationForTerminalRequest(
  deps: TaxDeadlineNotificationDeps,
  candidate: Candidate,
): Promise<boolean> {
  return deps.runAtomic(async (tx) => {
    const changed = await tx.taxDeadline.updateMany({
      where: {
        id: candidate.id,
        tenantId: candidate.tenantId,
        requestId: candidate.requestId,
        autoRequestNotificationStatus: candidate.autoRequestNotificationStatus,
        autoRequestNotificationAttemptCount: candidate.autoRequestNotificationAttemptCount,
        autoRequestNotificationNextAttemptAt: candidate.autoRequestNotificationNextAttemptAt,
        // Auch die Terminalitaet ist Teil des CAS: Wird der Request parallel
        // wieder geoeffnet, bleibt die Versandvormerkung bestehen und wird
        // erst im naechsten Lauf anhand des neuen Status bewertet.
        request: { status: { notIn: [...ACTIVE_REQUEST_STATUSES] } },
      },
      // `requestId` ist der technische Benachrichtigungs-Pointer. Der
      // Datenbank-Guard ueberfuehrt den Zustand dabei nach ORPHANED, entfernt
      // den Scheduler-Zeitpunkt und bewahrt Versuchs-/Fehlerhistorie. Der
      // eigentliche Request samt stabiler Herkunft `taxDeadlineId` bleibt
      // unveraendert erhalten.
      data: { requestId: null },
    });
    if (changed.count !== 1) return false;
    await deps.resolveFailureNotifications(tx, {
      tenantId: candidate.tenantId,
      deadlineId: candidate.id,
    });
    return true;
  });
}

async function persistTerminalOutcome(
  deps: TaxDeadlineNotificationDeps,
  candidate: Candidate,
  attemptNo: number,
  attemptAt: Date,
  input: {
    status: TaxDeadlineNotificationStatus;
    error: string | null;
    acceptedAt?: Date | null;
    escalate?: { title: string; body: string };
  },
): Promise<boolean> {
  return deps.runAtomic(async (tx) => {
    const changed = await tx.taxDeadline.updateMany({
      where: {
        id: candidate.id,
        tenantId: candidate.tenantId,
        requestId: candidate.requestId,
        autoRequestNotificationStatus: 'UNKNOWN',
        autoRequestNotificationAttemptCount: attemptNo,
        autoRequestNotificationLastAttemptAt: attemptAt,
      },
      data: {
        autoRequestNotificationStatus: input.status,
        autoRequestNotificationAcceptedAt: input.acceptedAt ?? null,
        autoRequestNotificationNextAttemptAt: null,
        autoRequestNotificationLastError: input.error,
        autoRequestNotificationEscalatedAt: input.escalate ? attemptAt : null,
      },
    });
    if (changed.count !== 1) return false;
    if (input.escalate) {
      await deps.upsertStaffNotification(
        tx,
        failureNotification(candidate, input.escalate.title, input.escalate.body),
      );
    } else if (input.status === 'PROVIDER_ACCEPTED') {
      await deps.resolveFailureNotifications(tx, {
        tenantId: candidate.tenantId,
        deadlineId: candidate.id,
      });
    }
    return true;
  });
}

async function persistDefiniteFailure(
  deps: TaxDeadlineNotificationDeps,
  candidate: Candidate,
  attemptNo: number,
  attemptAt: Date,
  attempted: number,
): Promise<'retry' | 'escalated' | 'lost-claim'> {
  const exhausted = attemptNo >= MAX_ATTEMPTS;
  return deps.runAtomic(async (tx) => {
    const changed = await tx.taxDeadline.updateMany({
      where: {
        id: candidate.id,
        tenantId: candidate.tenantId,
        requestId: candidate.requestId,
        autoRequestNotificationStatus: 'UNKNOWN',
        autoRequestNotificationAttemptCount: attemptNo,
        autoRequestNotificationLastAttemptAt: attemptAt,
      },
      data: {
        autoRequestNotificationStatus: exhausted ? 'ESCALATED' : 'FAILED',
        autoRequestNotificationAcceptedAt: null,
        autoRequestNotificationNextAttemptAt: exhausted
          ? null
          : new Date(attemptAt.getTime() + RETRY_DELAY_MS),
        autoRequestNotificationLastError: exhausted
          ? `Keiner von ${attempted} Versandversuchen wurde in Versuch ${attemptNo} vom Provider angenommen; maximale Versuchszahl erreicht.`
          : `Keiner von ${attempted} Versandversuchen wurde in Versuch ${attemptNo} vom Provider angenommen.`,
        autoRequestNotificationEscalatedAt: exhausted ? attemptAt : null,
      },
    });
    if (changed.count !== 1) return 'lost-claim';
    if (!exhausted) return 'retry';
    await deps.upsertStaffNotification(
      tx,
      failureNotification(
        candidate,
        'Benachrichtigung einer Auto-Anforderung fehlgeschlagen',
        `Nach ${MAX_ATTEMPTS} eindeutigen technischen Fehlversuchen wurde der automatische Versand beendet. Die Portal-Anforderung bleibt bestehen; bitte Versandweg und Empfänger manuell prüfen.`,
      ),
    );
    return 'escalated';
  });
}

export async function processTaxDeadlineNotifications(
  deps: TaxDeadlineNotificationDeps,
  input: { tenantId: string; now?: Date },
): Promise<TaxDeadlineNotificationStats> {
  const now = input.now ?? new Date();
  const stats: TaxDeadlineNotificationStats = {
    processed: 0,
    providerAccepted: 0,
    recipientsAccepted: 0,
    retryPending: 0,
    escalated: await escalateStrandedUnknown(deps, input.tenantId, now),
  };

  const candidates = await deps.db.taxDeadline.findMany({
    where: {
      tenantId: input.tenantId,
      requestId: { not: null },
      autoRequestNotificationAttemptCount: { lt: MAX_ATTEMPTS },
      OR: [
        {
          autoRequestNotificationStatus: 'QUEUED',
          autoRequestNotificationNextAttemptAt: { lte: now },
        },
        {
          autoRequestNotificationStatus: 'FAILED',
          autoRequestNotificationNextAttemptAt: { lte: now },
        },
      ],
    },
    orderBy: [{ autoRequestNotificationNextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    select: candidateSelect,
  });

  for (const candidate of candidates) {
    // Defense in depth: Selbst bei einem fehlerhaften DB-Adapter oder einer
    // spaeter erweiterten Query bleiben ORPHANED und alle terminalen Zustaende
    // vom Versand ausgeschlossen.
    if (!WORKER_ELIGIBLE_STATUSES.has(candidate.autoRequestNotificationStatus)) continue;

    // Eine inkonsistente Verknuepfung ist kein Anlass, einen neuen Request zu
    // erzeugen. Sie wird wie ein unklarer technischer Zustand eskaliert.
    if (
      !candidate.requestId ||
      !candidate.request ||
      candidate.request.id !== candidate.requestId
    ) {
      const changed = await deps.runAtomic(async (tx) => {
        const update = await tx.taxDeadline.updateMany({
          where: {
            id: candidate.id,
            tenantId: candidate.tenantId,
            requestId: candidate.requestId,
            autoRequestNotificationStatus: candidate.autoRequestNotificationStatus,
            autoRequestNotificationAttemptCount: candidate.autoRequestNotificationAttemptCount,
          },
          data: {
            autoRequestNotificationStatus: 'UNKNOWN',
            autoRequestNotificationNextAttemptAt: null,
            autoRequestNotificationLastError:
              'Die gespeicherte Request-Verknuepfung konnte nicht eindeutig aufgeloest werden.',
            autoRequestNotificationEscalatedAt: now,
          },
        });
        if (update.count !== 1) return false;
        await deps.upsertStaffNotification(
          tx,
          failureNotification(
            candidate,
            'Auto-Anforderung kann nicht benachrichtigt werden',
            'Die gespeicherte Request-Verknuepfung ist inkonsistent. Es wurde keine zweite Anforderung erzeugt und kein Versand versucht.',
          ),
        );
        return true;
      });
      if (changed) stats.escalated += 1;
      continue;
    }

    // RESPONDED ist ebenso nicht mehr mandantenseitig offen. Fuer den
    // Versand sind ausschliesslich OPEN und IN_PROGRESS zugelassen; CLOSED,
    // CANCELLED und RESPONDED werden ohne externen Versuch terminalisiert.
    if (!ACTIVE_REQUEST_STATUS_SET.has(candidate.request.status)) {
      await orphanNotificationForTerminalRequest(deps, candidate);
      continue;
    }

    const attemptAt = new Date();
    const attemptNo = await claimAttempt(deps, candidate, attemptAt);
    if (attemptNo === null) continue;
    stats.processed += 1;

    try {
      const result = await deps.notifyAutomaticTaxRequestOpened({
        tenantId: candidate.tenantId,
        clientId: candidate.clientId,
        requestId: candidate.requestId,
        priority: candidate.request.priority as RequestPriority,
        dueAtIso: (candidate.request.dueAt ?? candidate.dueDate).toISOString(),
      });

      if (result.attempted === 0) {
        const sideEffectHint = result.externalSideEffectOccurred
          ? ' Das einmalige n8n-Ereignis wurde dennoch ausgelöst.'
          : '';
        const changed = await persistTerminalOutcome(deps, candidate, attemptNo, attemptAt, {
          status: 'NO_RECIPIENT',
          error: `Kein aktiver, per Portal-Login bestätigter Kontakt mit eingeschalteten Benachrichtigungen vorhanden.${sideEffectHint}`,
          escalate: {
            title: 'Auto-Anforderung ohne Benachrichtigungsempfänger',
            body: `Die Portal-Anforderung wurde angelegt, aber es ist kein aktiver, per Portal-Login bestätigter Kontakt mit eingeschalteten Benachrichtigungen vorhanden.${sideEffectHint} Bitte Empfängerzuordnung manuell prüfen.`,
          },
        });
        if (changed) stats.escalated += 1;
        continue;
      }

      if (result.uncertainFailure) {
        const acceptedHint =
          result.recipients > 0
            ? `${result.recipients} Mail-Einzelversuch(e) wurden sicher technisch angenommen; `
            : '';
        const sideEffectHint = result.externalSideEffectOccurred
          ? ' Ein externer Workflow wurde bereits ausgelöst.'
          : '';
        const changed = await persistTerminalOutcome(deps, candidate, attemptNo, attemptAt, {
          status: 'UNKNOWN',
          error: `${acceptedHint}mindestens ein SMTP-Versuch endete ohne explizite Provider-Ablehnung; der Gesamtausgang ist nicht sicher bestimmbar.${sideEffectHint} Kein automatischer Neuversand.`,
          escalate: {
            title: 'Versandstatus einer Auto-Anforderung ist unklar',
            body: `${acceptedHint}mindestens ein SMTP-Versuch endete ohne eindeutig bestimmbare Provider-Antwort.${sideEffectHint} Wegen des Doppelversandrisikos erfolgt kein automatischer Neuversand; bitte manuell prüfen.`,
          },
        });
        if (changed) {
          stats.recipientsAccepted += result.recipients;
          stats.escalated += 1;
        }
        continue;
      }

      if (result.recipients === result.attempted) {
        const changed = await persistTerminalOutcome(deps, candidate, attemptNo, attemptAt, {
          status: 'PROVIDER_ACCEPTED',
          error: null,
          acceptedAt: attemptAt,
        });
        if (changed) {
          stats.providerAccepted += 1;
          stats.recipientsAccepted += result.recipients;
        }
        continue;
      }

      if (result.recipients > 0 || result.externalSideEffectOccurred) {
        const sideEffectHint = result.externalSideEffectOccurred
          ? ' Ein externer Workflow wurde bereits ausgelöst.'
          : '';
        const changed = await persistTerminalOutcome(deps, candidate, attemptNo, attemptAt, {
          status: 'PARTIAL_FAILURE',
          error: `${result.recipients} von ${result.attempted} Mail-Einzelversuchen wurden vom Provider angenommen.${sideEffectHint} Kein automatischer Neuversand wegen Doppelverarbeitungsrisiko.`,
          escalate: {
            title: 'Auto-Anforderung nur teilweise benachrichtigt',
            body: `${result.recipients} von ${result.attempted} Mail-Empfängerversuchen wurden technisch angenommen.${sideEffectHint} Wegen des Doppelverarbeitungsrisikos erfolgt kein automatischer Neuversand; bitte manuell prüfen.`,
          },
        });
        if (changed) {
          stats.recipientsAccepted += result.recipients;
          stats.escalated += 1;
        }
        continue;
      }

      const outcome = await persistDefiniteFailure(
        deps,
        candidate,
        attemptNo,
        attemptAt,
        result.attempted,
      );
      if (outcome === 'retry') stats.retryPending += 1;
      if (outcome === 'escalated') stats.escalated += 1;
    } catch (error) {
      // Eine Exception kann nach tatsaechlicher Provider-Annahme auftreten
      // (z. B. nachgelagerter n8n-Side-Effect). Deshalb niemals blind erneut.
      deps.logUncertainError?.({
        tenantId: candidate.tenantId,
        deadlineId: candidate.id,
        requestId: candidate.requestId,
        error,
      });
      const changed = await persistTerminalOutcome(deps, candidate, attemptNo, attemptAt, {
        status: 'UNKNOWN',
        error:
          'Der Versandversuch endete mit einem unklaren technischen Zustand; Provider-Annahme nicht sicher bestimmbar.',
        escalate: {
          title: 'Versandstatus einer Auto-Anforderung ist unklar',
          body: 'Der technische Versandversuch endete ohne eindeutig bestimmbaren Providerstatus. Wegen des Doppelversandrisikos erfolgt kein automatischer Neuversand; bitte manuell prüfen.',
        },
      });
      if (changed) stats.escalated += 1;
    }
  }

  return stats;
}
