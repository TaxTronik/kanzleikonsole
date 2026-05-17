// =============================================================================
// @taxtronik/tax — Public API
//
// Pure-funktionale Steuertermin-Engine, geteilt zwischen Web-App und Worker.
// Keine DB-Abhängigkeit, keine Side-Effects.
// =============================================================================

export {
  generateDeadlines,
  shiftToNextWorkday,
  germanHolidays,
  SCHEDULE_LABELS,
  REGION_LABELS,
  type GermanRegion,
  type DeadlineCandidate,
} from './engine';
