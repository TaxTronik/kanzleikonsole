/**
 * Erzwingt die globale Hardware-Policy bereits beim Start jeder Node-Replica.
 * Der Startpfad schreibt ausschließlich den DB-Anker und kontaktiert nicht den
 * externen FIDO-Metadienst; dessen Prüfung bleibt auf Hardware-Pfade begrenzt.
 *
 * Fachkatalog: ACCESS-TENANT-RLS-001
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production') return;

  const { initializeHardwareAccessPolicy } = await import('@/server/auth/webauthn');
  await initializeHardwareAccessPolicy();
}
