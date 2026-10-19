// Vorlagen für Compliance-Ziele (Einrichtungsassistent, Schritt 3).
import type { Klasse } from '../types';

export interface ZielVorlage {
  key: string;
  text: string;
  wesentlichkeitEur: number;
  risikoappetit: Klasse;
}

export const ZIEL_VORLAGEN: readonly ZielVorlage[] = [
  {
    key: 'ust-erklaerung',
    text: 'Vollständige, richtige und fristgerechte Erfüllung der umsatzsteuerlichen Erklärungs- und Zahlungspflichten in allen Ländern mit Steuerpflicht.',
    wesentlichkeitEur: 5000,
    risikoappetit: 'MITTEL',
  },
  {
    key: 'erloese',
    text: 'Lückenlose und abgestimmte Erfassung aller Erlöse aus Shop, Marktplätzen und Zahlungsdienstleistern.',
    wesentlichkeitEur: 2500,
    risikoappetit: 'MITTEL',
  },
  {
    key: 'berichtigung',
    text: 'Erkannte Fehler werden unverzüglich gewürdigt und, soweit erforderlich, berichtigt.',
    wesentlichkeitEur: 0,
    risikoappetit: 'MITTEL',
  },
];
