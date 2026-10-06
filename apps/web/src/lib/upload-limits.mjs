// =============================================================================
// Upload-Grenzen je Upload-Art (Review-Finding F-09).
//
// Einzige Quelle für
//   (a) die serverseitige Größenprüfung der Upload-Server-Actions,
//   (b) Anzeige und Vorprüfung der Grenze im UI und
//   (c) `experimental.serverActions.bodySizeLimit` in next.config.mjs.
//
// Upload-Actions erhalten die Datei als `File` in FormData (binärer
// Multipart-Body, kein base64 mit 33 % Aufschlag). Das Body-Limit der
// Server-Actions ist deshalb die größte Upload-Art plus Platz für
// Multipart-Framing und die übrigen Formularfelder.
//
// Bewusst reines ESM-JavaScript: next.config.mjs lädt die Datei ohne
// TypeScript-Übersetzung. Keine Upload-Art darf über MAX_UPLOAD_BYTES des
// Storage-Dienstes (@taxtronik/storage) liegen; der Test in
// src/lib/__tests__/upload-limits.test.ts hält beide Werte synchron.
// =============================================================================

const MIB = 1024 * 1024;

/** Globale Obergrenze des Storage-Dienstes (= MAX_UPLOAD_BYTES in @taxtronik/storage). */
export const STORAGE_MAX_UPLOAD_BYTES = 25 * MIB;

/** Höchstgröße je Upload-Art in Bytes. */
export const MAX_UPLOAD_BYTES_BY_KIND = Object.freeze({
  /** Fremdrechnung (PDF, GoBD-Archiv). */
  externalInvoicePdf: 10 * MIB,
  /** Berechnungs-PDF einer Steuererklärung (GoBD-Archiv). */
  taxFilingPdf: 10 * MIB,
  /** DATEV-BWA-Vorjahresvergleich (XLSX, wird nur geparst). */
  bwaXlsx: 20 * MIB,
  /** Datei-Feld eines Portal-Formulars. */
  portalFormFile: 10 * MIB,
  /** GwG-Onboarding: Ausweis- und Zusatzdokumente. */
  gwgOnboardingFile: 10 * MIB,
  /** Vollmacht-PDF (Staff). */
  poaPdf: STORAGE_MAX_UPLOAD_BYTES,
  /** Lohn-Anlagen (Staff, Portal, Beschäftigte). */
  payrollFile: STORAGE_MAX_UPLOAD_BYTES,
  /** Textübernahme in den Subsumtions-Workspace (PDF/DOCX). */
  subsumtionImport: STORAGE_MAX_UPLOAD_BYTES,
});

/** Platz für Multipart-Framing und die übrigen Felder einer Upload-Action. */
export const UPLOAD_ACTION_OVERHEAD_BYTES = MIB;

/** `serverActions.bodySizeLimit`: größte Upload-Art plus Overhead. */
export const SERVER_ACTION_BODY_LIMIT_BYTES =
  Math.max(...Object.values(MAX_UPLOAD_BYTES_BY_KIND)) + UPLOAD_ACTION_OVERHEAD_BYTES;

/**
 * Anzeige einer Grenze im UI, z. B. „10 MB" (binäre Megabyte, wie bisher).
 * @param {number} bytes
 * @returns {string}
 */
export function formatUploadLimit(bytes) {
  const mib = bytes / MIB;
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1).replace('.', ',')} MB`;
}
