// Reine Auth-Entscheidung des zentralen Staff-Gates — bewusst OHNE jeden Import
// (kein next-auth/IO), damit Unit-Tests die Sicherheits-Wahrheitstabelle ziehen
// können, ohne die Auth.js-Importkette zu laden.

/** `null` = erlaubt, sonst die UI-Fehlermeldung. EINMAL geprüft statt 162×/63×. */
export function decideStaffGuard(input: { hasUser: boolean; isAdmin: boolean; requireAdmin: boolean }): string | null {
  if (!input.hasUser) return 'Nicht eingeloggt.';
  if (input.requireAdmin && !input.isAdmin) return 'Nur ADMIN/PARTNER.';
  return null;
}
