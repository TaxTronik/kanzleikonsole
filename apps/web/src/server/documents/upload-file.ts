// =============================================================================
// Datei aus der FormData einer Upload-Server-Action lesen (Review-Finding F-09).
//
// Upload-Actions bekommen die Datei als `File` in FormData statt als
// base64-String im Action-Body. Die Größe wird gegen die Grenze der
// Upload-Art aus src/lib/upload-limits.mjs geprüft — dieselbe Quelle, aus der
// next.config.mjs das Server-Action-Body-Limit und das UI die Anzeige ableitet.
// =============================================================================

import { MAX_UPLOAD_BYTES_BY_KIND, formatUploadLimit } from '@/lib/upload-limits.mjs';

export type UploadKind = keyof typeof MAX_UPLOAD_BYTES_BY_KIND;

export type UploadFileRead =
  | { ok: true; file: File; bytes: Buffer; fileName: string; mimeType: string }
  | { ok: false; error: string };

export interface UploadFileMessages {
  /** Fehlt das Feld oder ist es kein File. */
  missing?: string;
  /** Leere Datei. */
  empty?: string;
  /** Präfix vor „(max. N MB)". */
  tooLarge?: string;
}

/** Höchstgröße einer Upload-Art in Bytes. */
export function maxUploadBytes(kind: UploadKind): number {
  return MAX_UPLOAD_BYTES_BY_KIND[kind];
}

/**
 * Liest `field` aus `formData` und prüft Leere und Größe gegen die Grenze von
 * `kind`, bevor die Bytes kopiert werden. Dateiname und MIME-Typ stammen vom
 * File (Client-Angabe); die Ablage ersetzt den MIME-Typ weiterhin durch die
 * Magic-Byte-Erkennung.
 */
export async function readUploadFile(
  formData: FormData | null | undefined,
  field: string,
  kind: UploadKind,
  messages: UploadFileMessages = {},
): Promise<UploadFileRead> {
  const value = formData?.get(field);
  if (!(value instanceof File)) {
    return { ok: false, error: messages.missing ?? 'Bitte eine Datei auswählen.' };
  }
  if (value.size === 0) return { ok: false, error: messages.empty ?? 'Die Datei ist leer.' };
  const max = maxUploadBytes(kind);
  if (value.size > max) {
    return {
      ok: false,
      error: `${messages.tooLarge ?? 'Datei zu groß'} (max. ${formatUploadLimit(max)}).`,
    };
  }
  return {
    ok: true,
    file: value,
    bytes: Buffer.from(await value.arrayBuffer()),
    fileName: value.name,
    mimeType: value.type,
  };
}
