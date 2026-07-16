// =============================================================================
// @taxtronik/tax — Public API
//
// Pure-funktionale Steuertermin-Engine (engine.ts, keine Side-Effects) plus
// der gemeinsame Materialisierungs-Kern (materialize.ts), geteilt zwischen
// Web-App und Worker. DB/Evidence kommen per Dependency-Injection — das
// Paket selbst hat keine Laufzeit-Abhängigkeit auf Prisma oder Evidence
// (nur Typ-Imports).
// =============================================================================

export {
  generateDeadlines,
  shiftToNextWorkday,
  germanHolidays,
  berlinCalendarDate,
  berlinTodayUtcMidnight,
  endOfDueDay,
  startOfUtcDay,
  appealDeadline,
  appealDeadlineFromNotification,
  appealDeadlineForPostAbroad,
  klageDeadline,
  BEKANNTGABE_FIKTION_TAGE,
  bekanntgabeFiktionTage,
  SCHEDULE_LABELS,
  REGION_LABELS,
  type GermanRegion,
  type DeadlineCandidate,
} from './engine';

export {
  materializeTenantTaxDeadlines,
  type MaterializeDb,
  type MaterializeDeps,
  type MaterializeParams,
  type MaterializeStats,
  type AutoRequestEvidence,
} from './materialize';
