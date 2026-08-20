export interface LlmCapabilityStatus {
  binaryVorhanden: boolean | null;
  modellGeladen: boolean | null;
}

export interface LlmOptionalSetupNotice {
  detail: string;
  title: string;
}

export interface LlmPerformanceStatus {
  backend?: string | null;
  performanceBottleneck?: boolean;
}

export function llmPerformanceNotice(
  status: LlmPerformanceStatus | null | undefined,
): string | null {
  if (!status?.performanceBottleneck && status?.backend?.toLowerCase() !== 'cpu') return null;
  return 'CPU-Bottleneck: Die KI-Vertiefung ist vollständig verfügbar, Modellstart und Analyse können aber mehrere Minuten dauern.';
}

/**
 * Schicht 2 kann nur gestartet werden, wenn sowohl llama-server als auch ein
 * lokales Modell vorhanden sind. `null` bedeutet bei alten/unerreichbaren
 * Engines "unbekannt" und darf keinen optimistischen Startknopf freischalten.
 */
export function canStartLlm(status: LlmCapabilityStatus | null | undefined): boolean {
  return status?.binaryVorhanden === true && status.modellGeladen === true;
}

/**
 * Signal selbst ist bereits erreichbar, wenn diese Statusdaten vorliegen.
 * Fehlende LLM-Artefakte dürfen deshalb nicht als fehlende "KI-Engine"
 * dargestellt werden: Sie betreffen nur die optionale generative Vertiefung.
 */
export function llmOptionalSetupNotice(status: LlmCapabilityStatus): LlmOptionalSetupNotice | null {
  if (status.binaryVorhanden === false) {
    return {
      detail: 'KI-Vertiefung nicht eingerichtet (optional)',
      title:
        'Signal ist installiert und nutzbar. Nur die optionale lokale LLM-Vertiefung (llama-server) ist in diesem Setup nicht eingerichtet.',
    };
  }
  if (status.modellGeladen === false) {
    return {
      detail: 'KI-Vertiefungsmodell nicht eingerichtet (optional)',
      title:
        'Signal ist installiert und nutzbar. Für die optionale lokale LLM-Vertiefung ist kein Modell eingerichtet.',
    };
  }
  return null;
}

export function llmCapabilityError(status: LlmCapabilityStatus | null | undefined): string {
  if (!status) return 'Der KI-Status konnte nicht ermittelt werden.';
  if (status.binaryVorhanden === false) {
    return 'Signal ist verfügbar. Die optionale lokale KI-Vertiefung (llama-server) ist in diesem Setup nicht eingerichtet.';
  }
  if (status.modellGeladen === false) {
    return 'Signal ist verfügbar. Für die optionale lokale KI-Vertiefung ist kein Modell eingerichtet.';
  }
  return 'Signal ist verfügbar, die optionale lokale KI-Vertiefung aber noch nicht vollständig bereit.';
}
