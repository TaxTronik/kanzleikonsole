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

import type { Prisma as PrismaTypes } from '@prisma/client';
// Subpath statt Barrel: vermeidet, dass owner-client (verlangt DATABASE_URL beim
// Import) in reine Unit-Tests gezogen wird, die rbac.ts transitiv importieren.
import { withTenantContext } from '@taxtronik/db/tenant-context';
// type-only: wird zur Compile-Zeit gelöscht, zieht den Owner-Client NICHT rein.
import type { TxClient } from '@taxtronik/db';
import { filterStaffAccessClientTx as filterStaffAccessClientSharedTx } from '@taxtronik/db/staff-client-access';
import { ForbiddenError, UnauthorizedError } from '@/server/actions/action-error';
import { readAccessPolicyTx, decideClientAccess } from '@/server/settings/access-policy';
import type { ClientAccessWhere } from './client-access-filter';
import { staffAuth, type StaffSession } from './staff';

// Fehlerklassen und Fehler-Mapping liegen ohne Auth-/Session-Imports in
// server/actions (testbar mit dem echten Mapping); hier re-exportiert, damit
// bestehende Importpfade stabil bleiben.
export { ForbiddenError, UnauthorizedError } from '@/server/actions/action-error';
export {
  toActionError,
  UNEXPECTED_ACTION_ERROR,
  type ActionErrorResult,
} from '@/server/actions/to-action-error';

/**
 * Bewusst UI-taugliche Domänen-Fehlermeldung (z. B. „Name bereits vergeben.").
 * `toActionError` reicht die Message durch — im Gegensatz zu unerwarteten Fehlern,
 * die generisch ersetzt werden (kein Leak von Internals). Ersetzt das frühere
 * `throw new Error(...)` + `return (e as Error).message`-Muster.
 */
export { ActionError } from '@/server/actions/action-error';

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
 * Wie `canAccessClientTx`, aber für einen ANDEREN Mitarbeiter — es liegt also
 * keine Session vor, sondern nur dessen ID. Rollen werden dafür nachgeladen.
 *
 * Gebraucht beim Zuweisen: wer eine Markierung delegiert, darf sie nicht an
 * jemanden geben, der den Mandanten gar nicht sehen darf. Die Delegation prüfte
 * bisher nur, dass der Empfänger ein aktiver Mitarbeiter DIESES Tenants ist —
 * bei einem vertraulichen Mandanten konnte man damit an Unbefugte zuweisen,
 * und die Wiedervorlage trägt ein wörtliches Zitat aus dem Sachverhalt.
 */
export async function canOtherStaffAccessClientTx(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  clientId: string,
): Promise<boolean> {
  const erlaubt = await filterStaffAccessClientTx(tx, tenantId, [staffId], clientId);
  return erlaubt.has(staffId);
}

/**
 * Batch-Variante von `canOtherStaffAccessClientTx`: entscheidet fuer VIELE
 * Mitarbeiter-IDs auf einmal, wer den Mandanten sehen darf.
 *
 * Der Subsumtions-Guard filtert damit die Zuweisungs-Liste — vorher lief das
 * als eine Einzelpruefung PRO Person, also bis zu 4·N Queries pro Seitenaufruf,
 * wobei Policy und Mandant N-fach identisch geladen wurden. Hier sind es
 * hoechstens vier Queries insgesamt, unabhaengig von der Teamgroesse.
 *
 * Bewusst sequentiell (kein Promise.all): die Aufrufe laufen auf einem
 * interaktiven Prisma-Tx, und der serialisiert ohnehin.
 */
export async function filterStaffAccessClientTx(
  tx: TxClient,
  tenantId: string,
  staffIds: readonly string[],
  clientId: string,
): Promise<Set<string>> {
  return filterStaffAccessClientSharedTx(tx, tenantId, staffIds, clientId);
}

/**
 * Sichtbare Mandanten als positive Prisma-Bedingung auf `client` — für
 * Mengen-Endpunkte (Listen, Suche, CSV-Exporte, Bulk-ZIP, Dashboard), die nicht
 * pro Treffer `canAccessClient` rufen können. Mandantengebundene Modelle hängen
 * sie über `clientAccessFilter`/`optionalClientAccessFilter` an
 * (client-access-filter.ts). Eine leichte Query pro Request (Policy):
 *  - Admin/Partner → `{}` (keine Einschränkung, keine Query).
 *  - OPEN: nicht vertrauliche Mandanten oder eigene Zuordnung.
 *  - RESTRICTED: nur Mandanten mit eigener Zuordnung.
 * Semantik exakt wie `decideClientAccess` (Zuordnung = Berufsträger/
 * Hauptbearbeiter via ClientResponsibility). Anders als eine Liste gesperrter
 * IDs materialisiert sie im RESTRICTED-Modus nicht den nahezu gesamten Bestand
 * als tausende `NOT IN`-Parameter, sondern lässt PostgreSQL die vorhandene
 * Responsibility-Relation direkt filtern.
 */
export async function accessibleClientsWhereFor(
  tx: TxClient,
  session: StaffSession,
): Promise<ClientAccessWhere> {
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

/**
 * Darf dieser Mitarbeiter am Mandanten SCHREIBEN — im Unterschied zum blossen
 * Zugang?
 *
 * `canAccessClientTx` beantwortet nur „darf hinsehen" und spart die
 * Responsibility-Query im OPEN-Normalfall bewusst ein. Fuer Schreibrechte ist
 * genau diese Zuordnung aber die Bedingung, also wird sie hier immer gefragt.
 * Dieselbe Regel wie die Nav-Pill auf der Mandantenseite (`canSubsumtion`).
 */
export async function canWriteClientTx(
  tx: TxClient,
  session: StaffSession,
  clientId: string,
): Promise<boolean> {
  if (isStaffAdmin(session)) return true;
  const { staffId } = session.user;
  return (
    (await tx.clientResponsibility.findFirst({
      where: { clientId, staffId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
      select: { id: true },
    })) !== null
  );
}

/**
 * Wie `canWriteClientTx`, aber ohne Session — fuer Aufrufer, die nur eine
 * Staff-ID haben (z. B. die Timeline mit `ctx.actorId`). Dieselbe Regel:
 * Admin/Partner oder BERUFSTRAEGER/HAUPTBEARBEITER-Zuordnung; Rollen werden
 * dafuer nachgeladen.
 */
export async function canStaffWriteClientTx(
  tx: TxClient,
  tenantId: string,
  staffId: string,
  clientId: string,
): Promise<boolean> {
  const staff = await tx.staffUser.findFirst({
    where: { id: staffId, tenantId, active: true },
    select: { roles: { select: { role: true } } },
  });
  if (!staff) return false;
  if (staff.roles.some((r) => r.role === 'ADMIN' || r.role === 'PARTNER')) return true;
  return (
    (await tx.clientResponsibility.findFirst({
      where: { clientId, staffId, role: { in: ['BERUFSTRAEGER', 'HAUPTBEARBEITER'] } },
      select: { id: true },
    })) !== null
  );
}
