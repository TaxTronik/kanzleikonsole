/**
 * Start jeder Node-Replica (Next.js ruft register() genau einmal je
 * Serverprozess auf, vor der ersten Anfrage).
 *
 * K-10: Logger und n8n-Emitter des Mail-Pakets werden hier explizit
 * registriert, in jeder Umgebung — nicht mehr als Seiteneffekt eines Imports.
 *
 * Erzwingt außerdem die globale Hardware-Policy (nur Produktion). Der
 * Startpfad schreibt ausschließlich den DB-Anker und kontaktiert nicht den
 * externen FIDO-Metadienst; diesen lädt und prüft allein der Worker-Job
 * fido-mds-refresh (P-23), Hardware-Pfade lesen nur den gespeicherten Stand.
 *
 * Fachkatalog: ACCESS-TENANT-RLS-001
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerMailIntegrations } = await import('@/server/mail/integrations');
  registerMailIntegrations();

  if (process.env.NODE_ENV !== 'production') return;
  const { initializeHardwareAccessPolicy } = await import('@/server/auth/webauthn');
  await initializeHardwareAccessPolicy();
}
