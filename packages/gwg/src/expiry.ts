// Fachkatalog: GWG-REVERIFICATION-VALIDITY-001
// =============================================================================
// GwG-Wiederholungsprüfung: Eskalationsstufen vor und nach Ablauf einer
// verifizierten Prüfung (gemessen an `validUntil`) und das Erinnerungsfenster
// ablaufender Ausweise. K-01: vormals lokal im Worker-Job gwg-expiry-check;
// rein funktional, damit Web und Worker dieselbe Regel verwenden können.
//
//   - 90 Tage vor Ablauf:  Stufe 1 — Hauptbearbeiter
//   - 30 Tage vor Ablauf:  Stufe 2 — zusätzlich Berufsträger
//   - bei/nach Ablauf:     Stufe 3 — ADMIN/PARTNER, Mandant wird deaktiviert
//   - Ausweise: Erinnerung ab 60 Tage vor dem Ablaufdatum
// =============================================================================

import type { NotificationKind } from '@prisma/client';

export const GWG_EXPIRY_STAGE1_DAYS = 90;
export const GWG_EXPIRY_STAGE2_DAYS = 30;
export const GWG_ID_DOCUMENT_WARN_DAYS = 60;

export type GwgExpiryStage = 'STAGE1' | 'STAGE2' | 'STAGE3';

export const GWG_EXPIRY_NOTIFICATION_KIND: Record<GwgExpiryStage, NotificationKind> = {
  STAGE1: 'GWG_EXPIRY_90D',
  STAGE2: 'GWG_EXPIRY_30D',
  STAGE3: 'GWG_EXPIRED',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Relevanzfenster der Eskalation: Prüfungen mit validUntil bis einschließlich dieses Zeitpunkts. */
export function gwgExpiryStage1Cutoff(now: Date): Date {
  return new Date(now.getTime() + GWG_EXPIRY_STAGE1_DAYS * DAY_MS);
}

/** Verbleibende Tage bis validUntil, angebrochene Tage aufgerundet (≤ 0: abgelaufen). */
export function gwgCheckDaysLeft(validUntil: Date, now: Date): number {
  return Math.ceil((validUntil.getTime() - now.getTime()) / DAY_MS);
}

export function gwgExpiryStageForDaysLeft(daysLeft: number): GwgExpiryStage | null {
  if (daysLeft <= 0) return 'STAGE3';
  if (daysLeft <= GWG_EXPIRY_STAGE2_DAYS) return 'STAGE2';
  if (daysLeft <= GWG_EXPIRY_STAGE1_DAYS) return 'STAGE1';
  return null;
}

/**
 * Zuständige je Stufe: Stufe 1 nur Hauptbearbeiter, ab Stufe 2 zusätzlich
 * Berufsträger. Aktivität, Zugriff und der ADMIN/PARTNER-Fallback bzw.
 * (Stufe 3) die ADMIN/PARTNER-Eskalation löst der Aufrufer auf.
 */
export function responsibleStaffForGwgExpiryStage(
  stage: GwgExpiryStage,
  responsibilities: ReadonlyArray<{ staffId: string; role: string }>,
): string[] {
  const bearbeiter = responsibilities
    .filter((r) => r.role === 'HAUPTBEARBEITER')
    .map((r) => r.staffId);
  if (stage === 'STAGE1') return bearbeiter;
  const berufstraeger = responsibilities
    .filter((r) => r.role === 'BERUFSTRAEGER')
    .map((r) => r.staffId);
  return [...bearbeiter, ...berufstraeger];
}

/**
 * Ende des Erinnerungsfensters ablaufender Ausweise: expiry_date ist ein
 * fachliches DATE, gemessen ab dem Berliner Kalendertag (UTC-Mitternacht).
 */
export function gwgIdDocumentWarnCutoff(berlinToday: Date): Date {
  return new Date(berlinToday.getTime() + GWG_ID_DOCUMENT_WARN_DAYS * DAY_MS);
}
