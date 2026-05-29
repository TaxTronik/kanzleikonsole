// Shared constants used across the app.

// Calendar/dashboard look-back: show tax deadlines from the past 14 days.
export const CALENDAR_PAST_DAYS = 14;
export const CALENDAR_PAST_MS = CALENDAR_PAST_DAYS * 24 * 60 * 60 * 1000;

// GwG: expiry window for identity verification documents (5 years = 60 months).
// Pragmatic approximation: 90 pay periods * 14 days per period ≈ 5 years for
// checking "will expire soon" (GwG Requirement / § 8 Abs. 4).
export const GWG_EXPIRY_WINDOW_DAYS = 90;
export const GWG_EXPIRY_WINDOW_MS = GWG_EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
