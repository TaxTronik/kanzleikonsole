// Gemeinsame Konstanten, app-weit genutzt.

// Kalender/Dashboard-Rückblick: Steuertermine der letzten 14 Tage mit anzeigen
// (gerade überfällige bleiben im Blick, nicht nur künftige).
export const CALENDAR_PAST_DAYS = 14;
export const CALENDAR_PAST_MS = CALENDAR_PAST_DAYS * 24 * 60 * 60 * 1000;

// GwG-Dashboard: VERIFIED-Checks, deren Gültigkeit (validUntil) in den nächsten
// 90 Tagen endet, werden als „läuft bald aus" markiert — Vorlauf für die
// Re-Verifikation, bevor der Mandant in einen blockierten Zustand fällt.
export const GWG_EXPIRY_WINDOW_DAYS = 90;
export const GWG_EXPIRY_WINDOW_MS = GWG_EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
