// =============================================================================
// Tägliche Abschlusskontrolle des Fristenkontrollbuchs.
//
// Fachkatalog: TAX-CONTROL-STATUS-001
//
// Ein Abschluss ist ein unveränderbarer Snapshot der zu diesem Zeitpunkt bis
// einschließlich heute offenen Fristen. Er ändert keinen Quellvorgang. Weil
// der Snapshot tenantweit und pro Tag eindeutig ist, darf der schreibende Pfad
// nur mit einer Session aufgerufen werden, die alle Mandanten des Tenants sehen
// darf (der Server-Action-Gate erzwingt dafür ADMIN/PARTNER).
// =============================================================================

import type { Prisma } from '@prisma/client';
import type { TxClient } from '@taxtronik/db';
import type { StaffSession } from '@/server/auth/staff';
import { ActionError } from '@/server/actions/action-error';
import { berlinTodayUtcMidnight } from '@/lib/fmt';
import { evidenceService } from '@/server/container';
import { loadKontrollbuch } from './kontrollbuch';
import type { FristEintrag, FristKontrollart, FristQuelle } from './eintrag';

const SNAPSHOT_VERSION = 1;

export interface DailyReviewEntrySnapshot {
  quelle: FristQuelle;
  kontrollart: FristKontrollart;
  id: string;
  clientId: string;
  faelligAm: string;
  verantwortlichId: string | null;
}

export interface DailyReviewSnapshot {
  version: typeof SNAPSHOT_VERSION;
  reviewDate: string;
  entries: DailyReviewEntrySnapshot[];
}

export interface DailyReviewCounts {
  openCount: number;
  overdueCount: number;
  dueTodayCount: number;
}

export interface PreparedDailyReview extends DailyReviewCounts {
  reviewDate: Date;
  snapshot: DailyReviewSnapshot;
}

export interface DailyReviewSummary extends DailyReviewCounts {
  id: string;
  reviewDate: Date;
  /** Beginn des konsistenten REPEATABLE-READ-Datenstands. */
  snapshotAt: Date;
  /** Zeitpunkt, zu dem der unveränderbare Abschluss in der DB geschrieben wurde. */
  reviewedAt: Date;
  reviewedBy: string;
  reviewerName: string | null;
  escalationNote: string | null;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDateValue(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/**
 * Baut den beweisorientierten Snapshot aus der Kontrollsicht. Die defensive
 * Filterung verhindert, dass ein später breiter gewordener Loader versehentlich
 * erledigte oder zukünftige Fristen in den Tagesabschluss übernimmt.
 */
export function prepareDailyReview(
  entries: readonly FristEintrag[],
  reviewDate = berlinTodayUtcMidnight(),
): PreparedDailyReview {
  const reviewDay = utcDateValue(reviewDate);
  const openDue = entries.filter(
    (entry) => !entry.erledigt && utcDateValue(entry.faelligAm) <= reviewDay,
  );
  const overdueCount = openDue.filter((entry) => utcDateValue(entry.faelligAm) < reviewDay).length;
  const dueTodayCount = openDue.length - overdueCount;

  return {
    reviewDate: new Date(reviewDay),
    openCount: openDue.length,
    overdueCount,
    dueTodayCount,
    snapshot: {
      version: SNAPSHOT_VERSION,
      reviewDate: isoDate(new Date(reviewDay)),
      entries: openDue.map((entry) => ({
        quelle: entry.quelle,
        kontrollart: entry.kontrollart,
        id: entry.id,
        clientId: entry.clientId,
        faelligAm: isoDate(entry.faelligAm),
        verantwortlichId: entry.verantwortlichId,
      })),
    },
  };
}

/** Lädt für den Abschluss alle Fristquellen bis heute, ohne Zuständigkeitsfilter. */
export async function loadOpenDueForDailyReview(
  tx: TxClient,
  session: StaffSession,
  reviewDate = berlinTodayUtcMidnight(),
): Promise<FristEintrag[]> {
  return loadKontrollbuch(tx, session, {
    tage: 0,
    nurOffene: true,
    nurStaffId: null,
    // Ein tenantweiter Abschluss darf keine bestehende Frist nur deshalb
    // auslassen, weil das zugehörige UI-Modul inzwischen ausgeblendet wurde.
    sources: { taxNotices: true, reminders: true },
    referenceDate: reviewDate,
  });
}

async function loadDatabaseReviewDate(tx: TxClient): Promise<Date> {
  const [clock] = await tx.$queryRaw<Array<{ reviewDate: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'Europe/Berlin')::date AS "reviewDate"
  `;
  if (!clock) throw new ActionError('Der Datenbank-Kontrolltag konnte nicht bestimmt werden.');
  return clock.reviewDate;
}

export async function loadDailyReviewSummary(
  tx: TxClient,
  tenantId: string,
  reviewDate = berlinTodayUtcMidnight(),
): Promise<DailyReviewSummary | null> {
  const row = await tx.deadlineDailyReview.findUnique({
    where: { tenantId_reviewDate: { tenantId, reviewDate } },
    select: {
      id: true,
      reviewDate: true,
      snapshotAt: true,
      reviewedAt: true,
      reviewedBy: true,
      openCount: true,
      overdueCount: true,
      dueTodayCount: true,
      escalationNote: true,
    },
  });
  if (!row) return null;

  const reviewer = await tx.staffUser.findFirst({
    where: { id: row.reviewedBy },
    select: { fullName: true },
  });
  return { ...row, reviewerName: reviewer?.fullName ?? null };
}

export async function createDailyReviewTx(
  tx: TxClient,
  input: {
    tenantId: string;
    staffId: string;
    session: StaffSession;
    escalationNote?: string | null;
    reviewDate?: Date;
  },
): Promise<DailyReviewSummary> {
  // Der fachliche Tag kommt einmalig aus der DB-Uhr und wird durch Loader,
  // Snapshot und Insert gereicht. Wechselt Berlin während der Transaktion den
  // Kalendertag, weist der DB-Trigger den Insert zurück; ein gemischter
  // Vortag-/Folgetag-Abschluss kann so nicht entstehen.
  const reviewDate = input.reviewDate ?? (await loadDatabaseReviewDate(tx));
  const entries = await loadOpenDueForDailyReview(tx, input.session, reviewDate);
  const prepared = prepareDailyReview(entries, reviewDate);
  const escalationNote = input.escalationNote?.trim() || null;

  if (prepared.openCount > 0 && (!escalationNote || escalationNote.length < 3)) {
    throw new ActionError(
      'Bei heute fälligen oder überfälligen offenen Fristen ist eine Eskalationsnotiz erforderlich.',
    );
  }

  const created = await tx.deadlineDailyReview.create({
    data: {
      tenantId: input.tenantId,
      reviewDate: prepared.reviewDate,
      reviewedBy: input.staffId,
      openCount: prepared.openCount,
      overdueCount: prepared.overdueCount,
      dueTodayCount: prepared.dueTodayCount,
      escalationNote,
      entriesSnapshot: prepared.snapshot as unknown as Prisma.InputJsonValue,
    },
    select: {
      id: true,
      reviewDate: true,
      snapshotAt: true,
      reviewedAt: true,
      reviewedBy: true,
      openCount: true,
      overdueCount: true,
      dueTodayCount: true,
      escalationNote: true,
    },
  });

  await evidenceService.record(tx, {
    tenantId: input.tenantId,
    actorType: 'STAFF',
    actorId: input.staffId,
    action: 'fristen.daily_review.complete',
    resourceType: 'deadline_daily_review',
    resourceId: created.id,
    after: {
      reviewDate: isoDate(created.reviewDate),
      openCount: created.openCount,
      overdueCount: created.overdueCount,
      dueTodayCount: created.dueTodayCount,
      escalationNoteRecorded: created.escalationNote !== null,
      snapshotVersion: SNAPSHOT_VERSION,
    },
  });

  return { ...created, reviewerName: null };
}
