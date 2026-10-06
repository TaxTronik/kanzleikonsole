// =============================================================================
// Einordnung von Postgres-/Prisma-Fehlern (Review-Befund F-03) für Web und Worker.
//
// Prisma 7 mit @prisma/adapter-pg liefert Postgres-Fehler als
// PrismaClientKnownRequestError: Unique/FK als P2002/P2003, Trigger-Ausnahmen
// (RAISE EXCEPTION) als P2039 bzw. bei Raw-Queries jeden Fehler als P2010. Der
// SQLSTATE und die Trigger-Meldung stehen in `meta.driverAdapterError.cause`
// (`originalCode`/`originalMessage`). Eingeordnet wird über Prisma-Code und
// SQLSTATE; Trigger-Ablehnungen zusätzlich über den stabilen Meldungsmarker der
// Migration — nie über den Prisma-Meldungstext (der enthält Quellpfade).
// =============================================================================

import { Prisma } from './prisma-client';

export type DatabaseErrorKind =
  /** P2025: Datensatz für update/delete nicht gefunden (oder Cross-Tenant). */
  | 'NOT_FOUND'
  /** P2002 bzw. SQLSTATE 23505. */
  | 'UNIQUE_VIOLATION'
  /** P2003 bzw. SQLSTATE 23503. */
  | 'FOREIGN_KEY_VIOLATION'
  /** GwG-Schranke: Dokument/Anforderung/Rechnung für nicht aktiven Mandanten. */
  | 'GWG_CLIENT_INACTIVE'
  | 'OTHER';

export interface DatabaseErrorInfo {
  kind: DatabaseErrorKind;
  prismaCode: string;
  sqlState: string | null;
  modelName: string | null;
  /** Felder oder Index der verletzten Bedingung, soweit Prisma sie liefert. */
  constraint: string | string[] | null;
}

/**
 * Bekannte Trigger-Ablehnungen: SQLSTATE plus Marker aus der Trigger-Meldung.
 * Der Marker ist der stabile Vertrag der Migrationen (init, iter2, iter5,
 * iter88: `app.enforce_client_active_for_{document,request,invoice}`).
 */
const KNOWN_TRIGGER_REJECTIONS: ReadonlyArray<{
  kind: DatabaseErrorKind;
  sqlStates: readonly string[];
  marker: RegExp;
}> = [{ kind: 'GWG_CLIENT_INACTIVE', sqlStates: ['23514'], marker: /\(GwG-Schranke\)/ }];

function stringOrStringList(value: unknown): string | string[] | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return undefined;
}

function objectField(source: unknown, key: string): Record<string, unknown> | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(source: Record<string, unknown> | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}

function classify(
  prismaCode: string,
  sqlState: string | null,
  databaseMessage: string | null,
): DatabaseErrorKind {
  if (prismaCode === 'P2025') return 'NOT_FOUND';
  if (prismaCode === 'P2002' || sqlState === '23505') return 'UNIQUE_VIOLATION';
  if (prismaCode === 'P2003' || sqlState === '23503') return 'FOREIGN_KEY_VIOLATION';
  if (sqlState !== null && databaseMessage !== null) {
    const known = KNOWN_TRIGGER_REJECTIONS.find(
      (rejection) =>
        rejection.sqlStates.includes(sqlState) && rejection.marker.test(databaseMessage),
    );
    if (known) return known.kind;
  }
  return 'OTHER';
}

/** Prisma-/Postgres-Fehler einordnen; `null` für alles andere. */
export function databaseErrorInfo(error: unknown): DatabaseErrorInfo | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = objectField(objectField(error.meta, 'driverAdapterError'), 'cause');
  const sqlState = stringField(cause, 'originalCode');
  const constraint = objectField(cause, 'constraint');
  const modelName = error.meta?.['modelName'];
  return {
    kind: classify(error.code, sqlState, stringField(cause, 'originalMessage')),
    prismaCode: error.code,
    sqlState,
    modelName: typeof modelName === 'string' ? modelName : null,
    constraint:
      stringOrStringList(constraint?.['fields']) ??
      stringOrStringList(constraint?.['index']) ??
      stringOrStringList(error.meta?.['target']) ??
      null,
  };
}

export function isDatabaseError(error: unknown, kind: DatabaseErrorKind): boolean {
  return databaseErrorInfo(error)?.kind === kind;
}

/** Eindeutigkeitskonflikt aus Prisma-Query (P2002) oder Raw-SQL (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
  return isDatabaseError(error, 'UNIQUE_VIOLATION');
}
