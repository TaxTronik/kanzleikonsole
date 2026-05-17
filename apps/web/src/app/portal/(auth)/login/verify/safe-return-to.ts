// =============================================================================
// V-4: open-redirect-Verteidigung für ?returnTo= nach Magic-Link-Verify.
//
// Separates Modul, damit der Unit-Test (siehe __tests__/safe-return-to.test.ts)
// die Funktion isoliert prüfen kann, ohne den Server-Component-Import-Graph
// (next/navigation, verifyMagicLinkAction, Prisma) zu ziehen.
// =============================================================================

/**
 * Akzeptiert nur same-origin /portal/-Pfade. Alles andere → Default-Pfad.
 */
export function safePortalReturnTo(raw: string | undefined): string {
  if (!raw) return '/portal/dashboard';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/portal/dashboard';
  if (!raw.startsWith('/portal/')) return '/portal/dashboard';
  if (raw.includes('\\')) return '/portal/dashboard';
  return raw;
}
