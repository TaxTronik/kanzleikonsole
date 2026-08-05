// =============================================================================
// Re-Export aus @taxtronik/mail (Muster M-7, secret-box.ts).
//
// Der Safe-Markdown-Renderer lebt jetzt in packages/mail (geteilt mit dem
// Worker-Mail-Versand). UI-Stellen (z. B. Form-Template-Intro) importieren
// weiter über diesen Pfad.
//
// WICHTIG: Subpath-Import (nicht der Paket-Index!) — der Index zieht den
// SMTP-Transport samt ENV-Validierung in den Modul-Graphen; der Renderer
// selbst ist pur und wird auch in Test-/UI-Kontexten ohne Mail-ENV geladen.
// =============================================================================

export { renderSafeMarkdown, escapeMarkdownVariable } from '@taxtronik/mail/markdown';
