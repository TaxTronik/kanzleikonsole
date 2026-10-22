/**
 * GWG-OCR-ASSIST-001: Texte der Ausweishilfe je Zielgruppe. Die Kanzlei sieht
 * die fachlich präzise Fassung (MRZ, Prüfziffer, Sichttext); Mandanten im
 * öffentlichen Onboarding eine verständliche Fassung in Sie-Form. Inhaltlich
 * bleibt beides gleich: nur Vorschläge, jede Angabe am Ausweis prüfen.
 */
import { IDENTITY_FIELD_LABELS, type IdentityWarning } from './identity-ocr';

export type IdentityAudience = 'staff' | 'client';

/** Verständlicher Hinweis für Mandanten; fällt nie hinter den Fachtext zurück. */
export function clientWarningText(warning: IdentityWarning): string {
  const field = warning.field ? IDENTITY_FIELD_LABELS[warning.field] : 'Diese Angabe';
  switch (warning.code) {
    case 'low-confidence':
      return 'Ihr Ausweis war nicht ganz gut lesbar. Bitte vergleichen Sie jede Angabe genau mit Ihrem Ausweis.';
    case 'issue-date-short-year':
      return 'Bitte tragen Sie das Ausstellungsdatum selbst ein. Es steht auf der Rückseite unter „Datum“.';
    case 'date-conflict':
      return `${field}: Die Angabe passt nicht zu den Zeichenreihen unten auf der Rückseite. Bitte prüfen Sie das Datum auf Ihrem Ausweis.`;
    case 'number-conflict':
      return 'Die Ausweisnummer wurde auf Vorder- und Rückseite unterschiedlich gelesen. Bitte prüfen Sie die Nummer oben rechts auf der Vorderseite.';
    case 'mrz-number-invalid':
      return 'Die Ausweisnummer konnte nicht sicher gelesen werden. Bitte übernehmen Sie sie von der Vorderseite (oben rechts).';
    case 'mrz-date-century':
      return `${field}: Bitte übernehmen Sie das Datum von der Vorderseite Ihres Ausweises.`;
    case 'mrz-name':
      return 'Ihr Name wurde aus den Zeichenreihen der Rückseite gelesen. Dort fehlen Umlaute (ä, ö, ü) und ß – bitte prüfen Sie die Schreibweise.';
    case 'nothing-found':
      return 'Wir konnten leider keine Angaben sicher erkennen. Bitte tragen Sie die Daten selbst ein – das geht genauso.';
    case 'side-mismatch':
      return `Das sieht nach der ${warning.side === 'back' ? 'Rückseite' : 'Vorderseite'} Ihres Ausweises aus. Falls die Fotos vertauscht sind, tauschen Sie sie mit „Seiten tauschen“.`;
  }
}

/**
 * Widersprüche und eine vertauschte Seite verlangen Aufmerksamkeit; alles andere
 * ist ein ruhiger Hinweis, damit ein gut gelesener Ausweis nicht wie ein Fehler wirkt.
 */
export function warningTone(warning: IdentityWarning): 'attention' | 'info' {
  return ['date-conflict', 'number-conflict', 'mrz-number-invalid', 'side-mismatch'].includes(
    warning.code,
  )
    ? 'attention'
    : 'info';
}

export function warningText(warning: IdentityWarning, audience: IdentityAudience): string {
  if (audience === 'client') return clientWarningText(warning);
  return warning.acrossSides ? `Abgleich der Ausweisseiten: ${warning.text}` : warning.text;
}

/** Feste Texte der Erfassung je Zielgruppe. */
export const IDENTITY_UI_TEXT = {
  staff: {
    intro:
      'Die Erkennung erfolgt nur auf diesem Gerät. Vorschläge sind ungeprüft. Originaldateien bleiben unverändert.',
    missing: 'Nicht erkannt, bitte manuell ergänzen oder andere Ausweisseite erfassen:',
    noneMissing: 'keine fehlenden Felder',
    compare: 'Mit dem Original vergleichen und gewünschte Felder auswählen:',
    previous: (value: string) => `Bisher: ${value} — wird nur nach Auswahl ersetzt.`,
    printed: (value: string) =>
      `Ausweis: ${value} — Groß-/Kleinschreibung angepasst; Umlaute und ß am Original prüfen.`,
    yearCompleted: (value: string) =>
      `Ausweis: ${value} — Jahrhundert ergänzt (eindeutig, da höchstens zehn Jahre alt); am Original bestätigen.`,
    matching: (labels: string[]) =>
      `Entspricht der bisherigen Angabe (abweichend nur Groß-/Kleinschreibung oder Umlaute), nicht zum Ersetzen angeboten: ${labels.join(', ')}.`,
    apply: 'Ausgewählte Daten übernehmen (ungeprüft)',
    imageAlt: 'Ausweisausschnitt zum Vergleich',
    applied: (labels: string[]) => `Übernommen (ungeprüft): ${labels.join(', ')}.`,
  },
  client: {
    intro:
      'Die Texterkennung läuft nur auf Ihrem Gerät. Sie schlägt Angaben vor – bitte prüfen Sie jede davon mit Ihrem Ausweis. Ihre hochgeladene Datei bleibt unverändert.',
    missing: 'Bitte selbst eintragen:',
    noneMissing: 'nichts',
    compare: 'Bitte vergleichen Sie jede Angabe mit Ihrem Ausweis und haken Sie an, was stimmt:',
    previous: (value: string) =>
      `Bisher eingetragen: ${value} – wird nur ersetzt, wenn Sie hier anhaken.`,
    printed: (value: string) =>
      `Auf dem Ausweis steht ${value}. Bitte prüfen Sie die Schreibweise, besonders ä, ö, ü und ß.`,
    yearCompleted: (value: string) =>
      `Auf dem Ausweis steht ${value}. Das vollständige Jahr haben wir ergänzt – bitte prüfen Sie es.`,
    matching: (labels: string[]) =>
      `Passt bereits zu Ihrer Eingabe: ${labels.join(', ')}. Ihre Schreibweise bleibt erhalten.`,
    apply: 'Angehakte Angaben übernehmen',
    imageAlt: 'Ihr Ausweis zum Vergleich',
    applied: (labels: string[]) =>
      `${labels.length === 1 ? '1 Angabe' : `${labels.length} Angaben`} übernommen und im Formular grün markiert: ${labels.join(', ')}. Bitte kontrollieren Sie sie dort noch einmal.`,
  },
} as const;
