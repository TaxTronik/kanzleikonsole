// =============================================================================
// RBAC-Helper für Staff-Server-Actions und API-Routen.
//
// Bisher haben einzelne Actions ihre Rolle-Checks selbst gemacht (oder gar
// nicht). Hier zentral, damit Drift unmöglich wird und alle Actions denselben
// Fehlermeldungs-Text liefern.
//
// Konvention:
//  - `requireStaffSession()` — wirft `UnauthorizedError`, wenn nicht eingeloggt
//  - `requireStaffAdmin()`   — wirft `ForbiddenError`, wenn nicht ADMIN/PARTNER
//  - `isStaffAdmin(session)` — Boolean-Check für UI-Filter
//
// Server Actions, die per `_prev/formData`-Pattern Ergebnis-Objekte liefern,
// fangen die Errors und mappen sie auf `{ ok: false, error }`. API-Routen
// können sie zu 401/403 mappen.
// =============================================================================

import { Prisma } from '@taxtronik/db/prisma-client';
import type { Prisma as PrismaTypes } from '@prisma/client';
// Subpath statt Barrel: vermeidet, dass owner-client (verlangt DATABASE_URL beim
// Import) in reine Unit-Tests gezogen wird, die rbac.ts transitiv importieren.
import { withTenantContext } from '@taxtronik/db/tenant-context';
// type-only: wird zur Compile-Zeit gelöscht, zieht den Owner-Client NICHT rein.
import type { TxClient } from '@taxtronik/db';
import { readAccessPolicyTx, decideClientAccess } from '@/server/settings/access-policy';
import { staffAuth, type StaffSession } from './staff';
import { log } from '@/server/logger';

export class UnauthorizedError extends Error {
  constructor(message = 'Nicht eingeloggt.') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Nur ADMIN/PARTNER.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Bewusst UI-taugliche Domänen-Fehlermeldung (z. B. „Name bereits vergeben.").
 * `toActionError` reicht die Message durch — im Gegensatz zu unerwarteten Fehlern,
 * die generisch ersetzt werden (kein Leak von Internals). Ersetzt das frühere
 * `throw new Error(...)` + `return (e as Error).message`-Muster.
 */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

export function isStaffAdmin(session: StaffSession | null | undefined): boolean {
  if (!session?.user?.roles) return false;
  return session.user.roles.some((r) => r === 'ADMIN' || r === 'PARTNER');
}

// iter87: granulare Einzelrechte — EINZIGE Quelle in lib/staff-permissions.ts
// (reines Daten-Modul, auch im Client-Bundle/Unit-Test ohne @prisma/client
// nutzbar). Hier nur re-exportiert, damit bestehende Importpfade stabil bleiben.
export type { StaffPermissionName } from '@/lib/staff-permissions';
export { PERMISSION_LABELS } from '@/lib/staff-permissions';
import type { StaffPermissionName } from '@/lib/staff-permissions';

/**
 * Einzelrecht-Prüfung: ADMIN/PARTNER haben implizit ALLE Rechte (kleine
 * Kanzleien arbeiten ohne Grants weiter), EMPLOYEE braucht den expliziten
 * Grant (staff_permission, von Admins vergeben und auditiert).
 */
export function hasStaffPermission(
  session: StaffSession | null | undefined,
  permission: StaffPermissionName,
): boolean {
  if (isStaffAdmin(session)) return true;
  return session?.user?.permissions?.includes(permission) ?? false;
}

/**
 * Liefert die aktive StaffSession oder wirft `UnauthorizedError`.
 */
export async function requireStaffSession(): Promise<StaffSession> {
  const session = await staffAuth();
  if (!session?.user) throw new UnauthorizedError();
  return session;
}

/**
 * Liefert die aktive StaffSession und prüft ADMIN/PARTNER. Wirft sonst.
 */
export async function requireStaffAdmin(): Promise<StaffSession> {
  const session = await requireStaffSession();
  if (!isStaffAdmin(session)) throw new ForbiddenError();
  return session;
}

/**
 * Zentrale Mandanten-Zugriffsprüfung (alle Module). Entkoppelt „zuarbeiten" von
 * „verantwortlich sein": im OPEN-Modell (Default) darf jeder aktive Mitarbeiter
 * an jedem nicht-vertraulichen Mandanten arbeiten; `ClientResponsibility` ist nur
 * noch Zuständigkeit/Filter. Existiert der Mandant nicht (oder anderer Tenant via
 * RLS) → kein Zugriff.
 *
 * Durchgesetzt wird die Policy überall, wo client-gebundene Inhalte das System
 * verlassen: Subsumtions-Workspace/-Export sowie die Staff-API-Routen für
 * Dokument-Download/-Preview, Bulk-ZIP, DATEV-Belege-Export, XRechnung/ZUGFeRD,
 * globale Suche und CSV-Exporte (Mandanten/Rechnungen/Anforderungen).
 */
export async function canAccessClient(session: StaffSession, clientId: string): Promise<boolean> {
  if (isStaffAdmin(session)) return true;
  const { tenantId, staffId } = session.user;
  return withTenantContext({ tenantId, actorId: staffId, actorType: 'STAFF' }, (tx) =>
    canAccessClientTx(tx, session, clientId),
  );
}

/**
 * Variante von `canAccessClient` auf einer BESTEHENDEN Tx — für Routen, die den
 * Check in dieselbe Transaktion wie ihren Objekt-Lookup legen wollen (kein
 * zweiter Tenant-Kontext, und der Audit-Eintrag entsteht erst NACH bestandenem
 * Check).
 */
export async function canAccessClientTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
): Promise<boolean> {
  if (isStaffAdmin(session)) return true;
  const { tenantId, staffId } = session.user;
  const policy = await readAccessPolicyTx(tx, tenantId);
  const client = await tx.client.findUnique({
    where: { id: clientId },
    select: { vertraulich: true },
  });
  if (!client) return false;
  // Responsibility nur abfragen, wenn sie überhaupt entscheiden kann
  // (RESTRICTED oder vertraulicher Mandant) — spart im OPEN-Normalfall eine Query.
  const needResponsibility = policy.clientAccessMode === 'RESTRICTED' || client.vertraulich;
  const isResponsible = needResponsibility
    ? (await tx.clientResponsibility.findFirst({
        where: { clientId, staffId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
        select: { id: true },
      })) !== null
    : false;
  return decideClientAccess({
    isAdmin: false,
    mode: policy.clientAccessMode,
    vertraulich: client.vertraulich,
    isResponsible,
  });
}

/**
 * Menge der Mandanten-IDs, die der Mitarbeiter NICHT sehen darf — für
 * Mengen-Endpunkte (Suche, CSV-Exporte, Bulk-ZIP), die nicht pro Treffer
 * `canAccessClient` rufen können. Eine leichte Query pro Request:
 *  - Admin/Partner → leer (keine Zusatzlast).
 *  - OPEN: nur vertraulich markierte Mandanten ohne eigene Zuordnung — im
 *    Normalfall (keine vertraulichen Mandanten) ist das Ergebnis sofort leer.
 *  - RESTRICTED: alle Mandanten ohne eigene Zuordnung.
 * Semantik exakt wie `decideClientAccess` (Zuordnung = Berufsträger/
 * Hauptbearbeiter via ClientResponsibility).
 */
export async function inaccessibleClientIdsFor(
  tx: TxClient,
  session: StaffSession,
): Promise<string[]> {
  if (isStaffAdmin(session)) return [];
  const { tenantId, staffId } = session.user;
  const policy = await readAccessPolicyTx(tx, tenantId);
  const rows = await tx.client.findMany({
    where: {
      ...(policy.clientAccessMode === 'OPEN' ? { vertraulich: true } : {}),
      responsibilities: {
        none: { staffId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
      },
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Positive Prisma-Bedingung für skalierbare Mandanten-Suchen. Anders als
 * `inaccessibleClientIdsFor` materialisiert sie im RESTRICTED-Modus nicht den
 * nahezu gesamten Bestand als tausende `NOT IN`-Parameter, sondern lässt
 * PostgreSQL die vorhandene Responsibility-Relation direkt filtern.
 */
export async function accessibleClientsWhereFor(
  tx: TxClient,
  session: StaffSession,
): Promise<PrismaTypes.ClientWhereInput> {
  if (isStaffAdmin(session)) return {};
  const { tenantId, staffId } = session.user;
  const policy = await readAccessPolicyTx(tx, tenantId);
  const responsibility: PrismaTypes.ClientWhereInput = {
    responsibilities: {
      some: { staffId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
    },
  };
  return policy.clientAccessMode === 'RESTRICTED'
    ? responsibility
    : { OR: [{ vertraulich: false }, responsibility] };
}

/** Wirft `ForbiddenError`, wenn kein Zugriff auf den Mandanten besteht. */
export async function requireClientAccess(clientId: string): Promise<StaffSession> {
  const session = await requireStaffSession();
  if (!(await canAccessClient(session, clientId))) {
    throw new ForbiddenError('Kein Zugriff auf diesen Mandanten.');
  }
  return session;
}

/**
 * Wie `requireClientAccess`, aber auf einer BESTEHENDEN Tenant-Tx und mit einer
 * bereits vorhandenen Session — für mutierende Server-Actions, die das
 * Vertraulich-/RESTRICTED-Ventil (Mandantentrennung INNERHALB der Kanzlei)
 * durchsetzen müssen. Der Layout-Guard (`canAccessClient` im Seiten-Layout)
 * schützt Server-Actions NICHT, weil diese als direkte POSTs am Layout
 * vorbeilaufen; RLS scoped nur pro Tenant, nicht pro Vertraulichkeit. Daher als
 * ERSTE Anweisung im Tenant-Tx-Callback jeder mutierenden Client-Action rufen,
 * bevor Zielobjekte gelesen/geschrieben werden. Wirft `ForbiddenError`
 * (→ `toActionError` mappt es auf `{ ok:false, error }`).
 */
export async function assertClientAccessTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
): Promise<void> {
  // Admin/Partner haben stets Zugriff (Kurzschluss wie in `canAccessClient`);
  // `canAccessClientTx` selbst wertet bewusst mit isAdmin:false und würde einen
  // Admin auf einem vertraulichen Mandanten ohne Zuordnung sonst fälschlich sperren.
  if (isStaffAdmin(session)) return;
  if (!(await canAccessClientTx(tx, session, clientId))) {
    throw new ForbiddenError('Kein Zugriff auf diesen Mandanten.');
  }
}

/**
 * Subsumtions-Workspace-Zugang. Nutzt jetzt die zentrale `canAccessClient`-Policy
 * (OPEN-Default + Vertraulich-Ventil) statt einer eigenen Responsibility-Prüfung —
 * damit Mitarbeiter mandantenübergreifend mitarbeiten können. Name bleibt für die
 * bestehenden Call-Sites.
 */
export async function requireSubsumtionAccess(clientId: string): Promise<StaffSession> {
  return requireClientAccess(clientId);
}

export interface ActionErrorResult {
  ok: false;
  error: string;
}

/**
 * Wrapper für Server-Actions, die `{ ok, error }` zurückgeben: fängt
 * `UnauthorizedError`, `ForbiddenError` und Prisma-Errors und mappt sie auf
 * das `ActionResult`-Pattern.
 *
 * R-6: Prisma wirft P2025 für "Record to update/delete not found" — kommt
 * regelmäßig vor wenn ein Action ohne vorheriges findFirst direkt update/
 * delete ruft und die ID nicht existiert oder Cross-Tenant ist. Vorher:
 * 500-Stack-Trace im Log + generischer Fehler im UI. Jetzt: sauberes
 * { ok: false, error: 'Datensatz nicht gefunden' }. Auch P2002 (unique)
 * und P2003 (FK) bekommen menschenlesbare Meldungen.
 */
export function toActionError(e: unknown): ActionErrorResult {
  if (e instanceof UnauthorizedError || e instanceof ForbiddenError || e instanceof ActionError) {
    return { ok: false, error: e.message };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case 'P2025':
        return { ok: false, error: 'Datensatz nicht gefunden oder bereits geändert.' };
      case 'P2002':
        return { ok: false, error: 'Eintrag existiert bereits (Eindeutigkeits-Konflikt).' };
      case 'P2003':
        return { ok: false, error: 'Referenz auf nicht existierenden Datensatz.' };
      default:
        // Andere Prisma-Fehler nicht durchreichen — könnten DB-internals leaken
        return { ok: false, error: 'Datenbankfehler.' };
    }
  }
  // Audit Round 14, Finding 3: Unbekannte Errors NIE direkt ans UI durch-
  // reichen — könnten Stacktraces, native Driver-Fehler, Pfad-Fragmente oder
  // sonstige Internals enthalten. Original ins Server-Log für Ops; UI sieht
  // nur eine generische Meldung.
  const err = e as Error;
  log.error(
    { component: 'action-error', name: err?.name, err: err?.message, stack: err?.stack },
    'toActionError: unbehandelte Exception',
  );
  return {
    ok: false,
    error: 'Unerwarteter Fehler. Bitte erneut versuchen oder Admin kontaktieren.',
  };
}
