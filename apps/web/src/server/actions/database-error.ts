// Zentrale Einordnung von Datenbankfehlern (F-03) — Implementierung und
// DB-Nachweis gegen echte Trigger liegen in @taxtronik/db/database-error.
export {
  databaseErrorInfo,
  isDatabaseError,
  isUniqueViolation,
  type DatabaseErrorInfo,
  type DatabaseErrorKind,
} from '@taxtronik/db/database-error';
