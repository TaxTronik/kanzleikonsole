/**
 * Fachkatalog: REMINDER-TICKET-001
 * Kurze Ticketverweise in einfachen Beschreibungstexten und Kommentaren.
 * Der Parser erkennt nur die Schreibweise; Sichtbarkeit und Existenz prüft
 * der Server. Insbesondere erzeugt eine Nummer niemals ein Zugriffsrecht.
 */
const MAX_TICKET_NUMBER = 2_147_483_647;

export interface TicketReferenceSegment {
  text: string;
  ticketNumber: number | null;
}

/** URL-Fragmente, Hashtags, Dezimalzahlen und führende Nullen sind keine Tickets. */
export function splitByTicketReferences(text: string): TicketReferenceSegment[] {
  const pattern = /(?<![\p{L}\p{N}_/#&=])#([1-9]\d{0,9})(?![\p{L}\p{N}_/]|[.,]\d)/gu;
  const segments: TicketReferenceSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const ticketNumber = Number(match[1]);
    if (ticketNumber > MAX_TICKET_NUMBER) continue;
    if (match.index > cursor) {
      segments.push({ text: text.slice(cursor, match.index), ticketNumber: null });
    }
    segments.push({ text: match[0], ticketNumber });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ text: text.slice(cursor), ticketNumber: null });
  }
  return segments;
}

/** Eindeutige Nummern in der Reihenfolge ihrer ersten Erwähnung. */
export function extractTicketNumbers(text: string): number[] {
  return [
    ...new Set(
      splitByTicketReferences(text)
        .map((segment) => segment.ticketNumber)
        .filter((number): number is number => number !== null),
    ),
  ];
}
