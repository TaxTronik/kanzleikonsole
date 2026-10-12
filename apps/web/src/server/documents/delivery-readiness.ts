/** DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001: Nur eine finalisierte,
 * saubere neueste Version ist auslieferbar; nie auf einen älteren Stand fallen. */
export function isDocumentVersionReady(
  version: { scanStatus: string; scanCompletedAt: Date | null } | null | undefined,
): boolean {
  return version?.scanStatus === 'CLEAN' && version.scanCompletedAt != null;
}

/**
 * Welle 15: Für Leser, die dem Nutzer den Grund nennen (Textübernahme der
 * Subsumtion). `ready` ist genau isDocumentVersionReady; sonst läuft die
 * Prüfung noch (PENDING oder CLEAN ohne Abschluss) oder die Version wurde nicht
 * freigegeben (infiziert, Scannerfehler, jeder andere Status).
 */
export type DocumentVersionReadiness = 'ready' | 'scan_pending' | 'scan_rejected';

export function documentVersionReadiness(version: {
  scanStatus: string;
  scanCompletedAt: Date | null;
}): DocumentVersionReadiness {
  if (isDocumentVersionReady(version)) return 'ready';
  if (version.scanStatus === 'PENDING' || version.scanStatus === 'CLEAN') return 'scan_pending';
  return 'scan_rejected';
}
