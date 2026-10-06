// =============================================================================
// Zentrales Fehler-Mapping für Server-Actions (Review-Befund F-03).
//
// Nur bewusst UI-taugliche Fehler reichen ihre Meldung durch: ActionError (und
// Unterklassen), UnauthorizedError, ForbiddenError. Datenbank- und Storage-
// Fehler werden über Prisma-Code/SQLSTATE bzw. Fehlerklasse eingeordnet, nie
// über den Meldungstext. Alles andere — Stacktraces, Treiber-, Pfad- oder
// Prisma-Meldungen — landet nur im Server-Log; das UI sieht eine generische
// Meldung. Bewusst ohne Auth-/Session-Imports, damit Unit-Tests das echte
// Mapping verwenden können.
// =============================================================================

import { StoredObjectError, UploadRejectedError } from '@taxtronik/storage/errors';
import { log } from '@/server/logger';
import { ActionError, ForbiddenError, UnauthorizedError } from './action-error';
import {
  databaseErrorInfo,
  type DatabaseErrorInfo,
  type DatabaseErrorKind,
} from './database-error';

export { ActionError, ForbiddenError, UnauthorizedError } from './action-error';

export interface ActionErrorResult {
  ok: false;
  error: string;
}

export const UNEXPECTED_ACTION_ERROR =
  'Unerwarteter Fehler. Bitte erneut versuchen oder Admin kontaktieren.';

const DATABASE_MESSAGES: Record<DatabaseErrorKind, string> = {
  NOT_FOUND: 'Datensatz nicht gefunden oder bereits geändert.',
  UNIQUE_VIOLATION: 'Eintrag existiert bereits (Eindeutigkeits-Konflikt).',
  FOREIGN_KEY_VIOLATION: 'Referenz auf nicht existierenden Datensatz.',
  GWG_CLIENT_INACTIVE: 'Mandant ist nicht aktiv (GwG-Prüfung ausstehend).',
  // Andere Datenbankfehler nicht durchreichen — könnten DB-Internals leaken.
  OTHER: 'Datenbankfehler.',
};

/** Erwartbare Konflikte: warn statt error im Log. */
const EXPECTED_DATABASE_ERRORS: ReadonlySet<DatabaseErrorKind> = new Set([
  'NOT_FOUND',
  'UNIQUE_VIOLATION',
  'GWG_CLIENT_INACTIVE',
]);

const UPLOAD_REJECTION_MESSAGES: Partial<Record<UploadRejectedError['reason'], string>> = {
  INFECTED: 'Die Datei wurde vom Virenscanner abgewiesen.',
  TOO_LARGE: 'Die Datei ist zu groß.',
  SCAN_ERROR: 'Der Virenscan ist derzeit nicht verfügbar. Bitte versuchen Sie es später erneut.',
};

/**
 * Log-Felder für Datenbankfehler. `meta` wird bewusst nicht roh geloggt: Bei
 * Driver-Adapter-Fehlern kann es die DETAIL-Zeile von Postgres und damit
 * Zeilenwerte enthalten („Failing row contains …“). Die Fehlerstelle in der
 * Action steht in Message und Stack.
 */
function databaseErrorLogFields(info: DatabaseErrorInfo, e: Error) {
  return {
    component: 'action-error',
    prismaCode: info.prismaCode,
    modelName: info.modelName ?? undefined,
    sqlState: info.sqlState ?? undefined,
    constraint: info.constraint ?? undefined,
    kind: info.kind,
    err: e.message,
    stack: e.stack,
  };
}

function storedObjectMessage(e: StoredObjectError): string {
  if (e.reason === 'TOO_LARGE') return 'Die Datei ist zu groß.';
  if (e.reason === 'MISSING_BODY') return 'Datei nicht verfügbar.';
  return 'Dateiintegrität konnte nicht bestätigt werden.';
}

/**
 * Fehler → `{ ok: false, error }` für Server-Actions.
 *
 * R-6: Prisma wirft P2025 für "Record to update/delete not found" — kommt
 * regelmäßig vor, wenn eine Action ohne vorheriges findFirst direkt update/
 * delete ruft und die ID nicht existiert oder Cross-Tenant ist. Unique- und
 * FK-Verletzungen (P2002/P2003 bzw. SQLSTATE 23505/23503 aus Raw-SQL) und die
 * GwG-Schranken-Trigger bekommen menschenlesbare Meldungen.
 *
 * Erwartbare Konflikte werden mit warn geloggt. Alles andere, etwa Transaktions-
 * Timeout (P2028), Serialisierungskonflikt (P2034) oder erschöpfter Pool
 * (P2024), landet als error im Log, statt nur als „Datenbankfehler.“ im UI.
 */
export function toActionError(e: unknown): ActionErrorResult {
  if (e instanceof UnauthorizedError || e instanceof ForbiddenError || e instanceof ActionError) {
    return { ok: false, error: e.message };
  }
  // Name statt Klasse: die Klasse zöge den Redis-Revocation-Stack in jede Action.
  if (e instanceof Error && e.name === 'SessionRevocationUnavailableError') {
    return { ok: false, error: 'Session-Widerruf ist derzeit nicht verfügbar.' };
  }
  const database = databaseErrorInfo(e);
  if (database) {
    const fields = databaseErrorLogFields(database, e as Error);
    if (EXPECTED_DATABASE_ERRORS.has(database.kind)) {
      log.warn(fields, 'toActionError: erwartbarer Datenbank-Konflikt');
    } else {
      log.error(fields, 'toActionError: Datenbankfehler');
    }
    return { ok: false, error: DATABASE_MESSAGES[database.kind] };
  }
  if (e instanceof StoredObjectError) {
    const fields = { component: 'action-error', reason: e.reason, err: e.message, stack: e.stack };
    if (e.integrityViolation) log.error(fields, 'toActionError: Integritätsfehler im Speicher');
    else log.warn(fields, 'toActionError: Speicherobjekt nicht lesbar');
    return { ok: false, error: storedObjectMessage(e) };
  }
  if (e instanceof UploadRejectedError) {
    const message = UPLOAD_REJECTION_MESSAGES[e.reason];
    if (message) {
      log.warn(
        { component: 'action-error', reason: e.reason, err: e.message },
        'toActionError: Datei abgewiesen',
      );
      return { ok: false, error: message };
    }
  }
  // Audit Round 14, Finding 3: Unbekannte Errors NIE direkt ans UI durch-
  // reichen — könnten Stacktraces, native Driver-Fehler, Pfad-Fragmente oder
  // sonstige Internals enthalten. Original ins Server-Log für Ops; UI sieht
  // nur eine generische Meldung.
  const err = e as Error | undefined;
  log.error(
    { component: 'action-error', name: err?.name, err: err?.message, stack: err?.stack },
    'toActionError: unbehandelte Exception',
  );
  return { ok: false, error: UNEXPECTED_ACTION_ERROR };
}
