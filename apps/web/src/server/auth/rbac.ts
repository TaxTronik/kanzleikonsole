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

import { Prisma } from '@prisma/client';
// Subpath statt Barrel: vermeidet, dass owner-client (verlangt DATABASE_URL beim
// Import) in reine Unit-Tests gezogen wird, die rbac.ts transitiv importieren.
import { withTenantContext } from '@taxtronik/db/tenant-context';
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

export function isStaffAdmin(session: StaffSession | null | undefined): boolean {
  if (!session?.user?.roles) return false;
  return session.user.roles.some((r) => r === 'ADMIN' || r === 'PARTNER');
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
 */
export async function canAccessClient(session: StaffSession, clientId: string): Promise<boolean> {
  if (isStaffAdmin(session)) return true;
  const { tenantId, staffId } = session.user;
  return withTenantContext(
    { tenantId, actorId: staffId, actorType: 'STAFF' },
    async (tx) => {
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
    },
  );
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
  if (e instanceof UnauthorizedError || e instanceof ForbiddenError) {
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
  return { ok: false, error: 'Unerwarteter Fehler. Bitte erneut versuchen oder Admin kontaktieren.' };
}
