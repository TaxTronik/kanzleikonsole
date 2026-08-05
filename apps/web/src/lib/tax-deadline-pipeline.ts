// =============================================================================
// Abgeleiteter Pipeline-Zustand der Auto-Anforderung eines Steuertermins.
//
// Kein eigener TaxDeadlineStatus — der Zustand ergibt sich aus requestId,
// autoRequestSuppressedAt, staffNotifiedAt und der Config. Pure Funktion,
// damit UI (Gruppen-/Listenseite) und Tests dieselbe Ableitung teilen.
//
// Die Datumslogik spiegelt materialize.ts (packages/tax): Versand erst, wenn
// die Vorwarnung mindestens einen vollen Tageslauf alt ist; nie nach
// Fälligkeit. `today` ist die UTC-Mitternacht des Berlin-Kalendertags
// (berlinCalendarDate) — dieselbe Kodierung wie TaxDeadline.dueDate.
// =============================================================================

const DAY_MS = 24 * 60 * 60 * 1000;

export type AutoRequestPipeline =
  /** Keine Auto-Anforderung (abgeschaltet, Config fehlt/inaktiv, Termin vorbei). */
  | { state: 'NONE' }
  /** Versand geplant, Vorwarnung steht noch aus bzw. ist nicht konfiguriert. */
  | { state: 'SCHEDULED'; sendDate: Date }
  /** Vorwarnung ist raus — Stopp-Fenster läuft bis zum Versanddatum. */
  | { state: 'WARNED'; sendDate: Date }
  /** Von einem Mitarbeiter gestoppt (aufhebbar). */
  | { state: 'SUPPRESSED' }
  /** Anforderung wurde erzeugt und versendet. */
  | { state: 'SENT' };

export interface PipelineInput {
  status: string;
  requestId: string | null;
  staffNotifiedAt: Date | null;
  autoRequestSuppressedAt: Date | null;
  dueDate: Date;
  config: {
    active: boolean;
    autoRequest: boolean;
    reminderDaysBefore: number;
    staffLeadDays: number;
  } | null;
  /** UTC-Mitternacht des heutigen Berlin-Kalendertags (berlinCalendarDate). */
  today: Date;
}

export function deriveAutoRequestPipeline(input: PipelineInput): AutoRequestPipeline {
  if (input.requestId !== null) return { state: 'SENT' };
  if (input.autoRequestSuppressedAt !== null) return { state: 'SUPPRESSED' };
  if (input.status !== 'PLANNED') return { state: 'NONE' };
  const cfg = input.config;
  if (!cfg || !cfg.active || !cfg.autoRequest || cfg.reminderDaysBefore <= 0) {
    return { state: 'NONE' };
  }
  // Nach Fälligkeit wird nie mehr automatisch angefordert (Härtung im Kern).
  if (input.dueDate.getTime() < input.today.getTime()) return { state: 'NONE' };

  const sendFrom = new Date(input.dueDate.getTime() - cfg.reminderDaysBefore * DAY_MS);
  const tomorrow = new Date(input.today.getTime() + DAY_MS);

  if (cfg.staffLeadDays > 0 && input.staffNotifiedAt !== null) {
    // Vorwarnung raus: der nächste Tageslauf nach dem Warn-Tag versendet.
    const sendDate = sendFrom.getTime() > tomorrow.getTime() ? sendFrom : tomorrow;
    return { state: 'WARNED', sendDate };
  }

  if (cfg.staffLeadDays === 0) {
    // Ohne Vorwarnung versendet der nächste Lauf im Fenster — frühestens heute.
    const sendDate = sendFrom.getTime() > input.today.getTime() ? sendFrom : input.today;
    return { state: 'SCHEDULED', sendDate };
  }

  // Vorwarnung steht noch aus: sie kommt frühestens mit dem nächsten Lauf
  // (bzw. am Warn-Tag), der Versand einen Tageslauf später.
  const warnFrom = new Date(sendFrom.getTime() - cfg.staffLeadDays * DAY_MS);
  const warnDate = warnFrom.getTime() > input.today.getTime() ? warnFrom : input.today;
  const earliestAfterWarn = new Date(warnDate.getTime() + DAY_MS);
  const sendDate = sendFrom.getTime() > earliestAfterWarn.getTime() ? sendFrom : earliestAfterWarn;
  return { state: 'SCHEDULED', sendDate };
}
