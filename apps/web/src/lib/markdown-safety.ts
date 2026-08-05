// =============================================================================
// Re-Export aus @taxtronik/mail (Muster M-7, secret-box.ts).
//
// WICHTIG: Subpath-Import (nicht der Paket-Index!) — diese Primitiven werden
// auch von Client-Komponenten verwendet; der Index würde nodemailer/db in den
// Client-Graph ziehen.
// =============================================================================

export { escapeHtml, safeHref } from '@taxtronik/mail/markdown-safety';
