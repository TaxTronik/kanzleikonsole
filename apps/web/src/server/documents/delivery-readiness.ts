/** DOC-UPLOAD-JOURNAL-001, DOC-VERSION-IMMUTABILITY-001: Nur eine finalisierte,
 * saubere neueste Version ist auslieferbar; nie auf einen älteren Stand fallen. */
export function isDocumentVersionReady(
  version: { scanStatus: string; scanCompletedAt: Date | null } | null | undefined,
): boolean {
  return version?.scanStatus === 'CLEAN' && version.scanCompletedAt != null;
}
