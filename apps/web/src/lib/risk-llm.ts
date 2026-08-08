export interface LlmCapabilityStatus {
  binaryVorhanden: boolean | null;
  modellGeladen: boolean | null;
}

/**
 * Schicht 2 kann nur gestartet werden, wenn sowohl llama-server als auch ein
 * lokales Modell vorhanden sind. `null` bedeutet bei alten/unerreichbaren
 * Engines "unbekannt" und darf keinen optimistischen Startknopf freischalten.
 */
export function canStartLlm(status: LlmCapabilityStatus | null | undefined): boolean {
  return status?.binaryVorhanden === true && status.modellGeladen === true;
}

export function llmCapabilityError(status: LlmCapabilityStatus | null | undefined): string {
  if (!status) return 'Der KI-Status konnte nicht ermittelt werden.';
  if (status.binaryVorhanden === false) {
    return 'Die lokale KI-Engine (llama-server) ist nicht installiert.';
  }
  if (status.modellGeladen === false) {
    return 'Es ist kein lokales KI-Modell installiert.';
  }
  return 'Die lokale KI-Installation ist noch nicht vollständig verfügbar.';
}
