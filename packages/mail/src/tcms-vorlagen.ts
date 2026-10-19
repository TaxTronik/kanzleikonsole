// =============================================================================
// Vorlagen der Mitteilungen des Tax-CMS (TCMS Stufe 4) – ohne Abhängigkeiten,
// damit auch die Vorlagenverwaltung (Client-Komponente) die Platzhalter
// anzeigen kann.
//
// Das Tax-CMS liefert je Mitteilung strukturierte Vorlagendaten (Vertrag,
// `OffeneNachricht.daten`); der Worker tcms-nachrichten-zustellen setzt daraus
// die Variablen unten und versendet über die Mail-Outbox mit dem System-Slug.
// Fehlt die Vorlage der Kanzlei (neue Kanzlei, gelöscht, deaktiviert), gilt
// der gleichlautende Ersatztext. Die Migration
// 20261019150200_tcms_mail_templates legt dieselben Texte für bestehende
// Kanzleien als bearbeitbare System-Vorlagen an (Test im Worker).
//
// Der Bestätigungscode steht nur in `{{code}}`; die Outbox speichert ihn als
// geheime Variable (Secret-Box) und entfernt ihn mit dem Endstatus. Betreffzeilen
// nennen ihn nie (Sperrbildschirme, Benachrichtigungen des Mailprogramms).
// =============================================================================

/** Versandanlässe der Mail-Outbox für Mitteilungen des Tax-CMS (= System-Slug). */
export const TCMS_MAIL_ANLAESSE = [
  'tcms-freigabe-angefordert',
  'tcms-freigabe-code',
  'tcms-freigabe-neu-adressiert',
] as const;
export type TcmsMailAnlass = (typeof TCMS_MAIL_ANLAESSE)[number];

/** Vorgangstyp der Outbox-Aufträge (resource_id = Zustellzeile der Mitteilung). */
export const TCMS_NACHRICHT_RESSOURCE = 'tcms_nachricht';

export interface TcmsMailVorlage {
  slug: TcmsMailAnlass;
  /** Name der System-Vorlage in der Vorlagenverwaltung. */
  name: string;
  subject: string;
  bodyMd: string;
}

const GRUSS = '\n\nMit freundlichen Grüßen\nIhre Steuerkanzlei';

export const TCMS_MAIL_VORLAGEN: Readonly<Record<TcmsMailAnlass, TcmsMailVorlage>> = {
  'tcms-freigabe-angefordert': {
    slug: 'tcms-freigabe-angefordert',
    name: 'Tax-CMS: Freigabe angefordert',
    subject: 'Freigabe angefordert: {{freigabe.titel}}',
    bodyMd:
      'Sehr geehrte/r {{contact.fullName}},\n\nfür {{client.name}} wartet im Mandantenportal eine Freigabe auf Sie:\n\n**{{freigabe.titel}}** ({{freigabe.art}})\n\nBitte melden Sie sich im Mandantenportal an und prüfen Sie die Freigabe:\n{{link}}\n\n{{freigabe.hinweis}}' +
      GRUSS,
  },
  'tcms-freigabe-code': {
    slug: 'tcms-freigabe-code',
    name: 'Tax-CMS: Bestätigungscode',
    subject: 'Ihr Bestätigungscode für {{freigabe.titel}}',
    bodyMd:
      'Sehr geehrte/r {{contact.fullName}},\n\nIhr Bestätigungscode für die Freigabe **{{freigabe.titel}}** ({{client.name}}) lautet:\n\n**{{code}}**\n\nDer Code gilt bis {{freigabe.gueltigBis}} und nur für diese Freigabe. Geben Sie ihn im Mandantenportal ein:\n{{link}}\n\n{{freigabe.pruefsumme}}\n\nHaben Sie keinen Code angefordert, geben Sie ihn nicht weiter und informieren Sie bitte Ihre Kanzlei.' +
      GRUSS,
  },
  'tcms-freigabe-neu-adressiert': {
    slug: 'tcms-freigabe-neu-adressiert',
    name: 'Tax-CMS: Freigabe neu adressiert',
    subject: 'Freigabe an Sie adressiert: {{freigabe.titel}}',
    bodyMd:
      'Sehr geehrte/r {{contact.fullName}},\n\ndie Kanzlei hat die Freigabe **{{freigabe.titel}}** ({{freigabe.art}}) für {{client.name}} an Sie adressiert. Sie wartet im Mandantenportal auf Sie:\n{{link}}\n\n{{freigabe.hinweis}}' +
      GRUSS,
  },
};

/** Ein Platzhalter einer System-Vorlage mit Erklärung für die Vorlagenverwaltung. */
export interface VorlagenPlatzhalter {
  name: string;
  beschreibung: string;
}

const KONTAKT_MANDANT: readonly VorlagenPlatzhalter[] = [
  { name: 'contact.fullName', beschreibung: 'Name des Kontakts (Empfänger) aus TaxTronik' },
  { name: 'client.name', beschreibung: 'Name des Mandanten aus TaxTronik' },
];
const FREIGABE: readonly VorlagenPlatzhalter[] = [
  { name: 'freigabe.titel', beschreibung: 'Titel der Freigabe im Tax-CMS' },
  { name: 'freigabe.art', beschreibung: 'Art der Freigabe, z. B. „CMS-Beschreibung“' },
  { name: 'freigabe.version', beschreibung: 'Version der CMS-Beschreibung, sonst leer' },
];
const LINK: VorlagenPlatzhalter = {
  name: 'link',
  beschreibung: 'Link zu den Freigaben im Mandantenportal',
};
const HINWEIS: VorlagenPlatzhalter = {
  name: 'freigabe.hinweis',
  beschreibung:
    'Hinweis zum Bestätigungscode (wird beim Freigeben angefordert; bei Kenntnisnahme nicht nötig)',
};

/** Platzhalter der System-Vorlagen des Tax-CMS (Anzeige in der Vorlagenverwaltung). */
export const TCMS_VORLAGEN_PLATZHALTER: Readonly<
  Record<TcmsMailAnlass, readonly VorlagenPlatzhalter[]>
> = {
  'tcms-freigabe-angefordert': [...KONTAKT_MANDANT, ...FREIGABE, LINK, HINWEIS],
  'tcms-freigabe-code': [
    ...KONTAKT_MANDANT,
    ...FREIGABE,
    {
      name: 'code',
      beschreibung:
        'Bestätigungscode (6 Ziffern); nur im Text verwenden, nie im Betreff. Wird nur verschlüsselt gespeichert und nach dem Versand gelöscht.',
    },
    { name: 'freigabe.gueltigBis', beschreibung: 'Ablauf des Codes (Datum und Uhrzeit, Berlin)' },
    {
      name: 'freigabe.pruefsumme',
      beschreibung: 'Satz mit der SHA-256-Prüfsumme des vorgelegten Dokuments, sonst leer',
    },
    LINK,
  ],
  'tcms-freigabe-neu-adressiert': [...KONTAKT_MANDANT, ...FREIGABE, LINK, HINWEIS],
};

/** Anzeigename der Freigabearten des Tax-CMS (wie in seiner Oberfläche). */
export const TCMS_FREIGABE_ART_LABEL: Readonly<Record<string, string>> = {
  ZIELE: 'Compliance-Ziele',
  BESCHREIBUNG: 'CMS-Beschreibung',
  RISIKOAKZEPTANZ: 'Risikoakzeptanz',
  AUFKLAERUNG: 'Risikoaufklärung',
  KENNTNISNAHME: 'Kenntnisnahme',
};

export function istTcmsMailAnlass(wert: string): wert is TcmsMailAnlass {
  return (TCMS_MAIL_ANLAESSE as readonly string[]).includes(wert);
}
