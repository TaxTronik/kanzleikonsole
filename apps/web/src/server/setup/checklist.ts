// Reine Entscheidungsfunktion der Inbetriebnahme-Checkliste — bewusst OHNE
// jeden Import (kein DB/IO), damit Unit-Tests die Wahrheitstabelle ziehen
// können, ohne die Owner-Client-Importkette zu laden (Muster:
// staff-action-policy.ts). Den IST-Zustand lädt status.ts.

export interface SetupItem {
  key: string;
  label: string;
  done: boolean;
  href: string;
  hint?: string;
}

export interface SetupState {
  brandingComplete: boolean;
  regionSet: boolean;
  sellerComplete: boolean;
  smtpConfigured: boolean;
  modulesConfigured: boolean;
  privacyComplete: boolean;
  activeClientCount: number;
  contactCount: number;
}

/** Reihenfolge entspricht der empfohlenen Inbetriebnahme (Anwenderdoku „Erste Schritte"). */
export function buildSetupItems(state: SetupState): SetupItem[] {
  return [
    {
      key: 'branding',
      label: 'Erscheinungsbild (Logo + Anzeigename)',
      done: state.brandingComplete,
      href: '/staff/admin/settings/branding',
      hint: 'Logo und Anzeigename erscheinen in Mitarbeiter- und Mandanten-Oberfläche.',
    },
    {
      key: 'region',
      label: 'Bundesland gesetzt',
      done: state.regionSet,
      href: '/staff/admin/settings/region',
      hint: 'Steuert die Werktagsverschiebung bei Steuerterminen.',
    },
    {
      key: 'seller',
      label: 'Kanzlei-Stammdaten vollständig (für E-Rechnung)',
      done: state.sellerComplete,
      href: '/staff/admin/settings/seller',
      hint: 'Name, Anschrift, USt-ID sowie E-Mail und Telefon — Letztere sind Pflichtangaben der XRechnung.',
    },
    {
      key: 'smtp',
      label: 'E-Mail-Versand konfiguriert',
      done: state.smtpConfigured,
      href: '/staff/admin/settings/mail',
      hint: 'Sonst kein Magic-Link-Login fürs Portal und keine Reminder-Mails.',
    },
    {
      key: 'modules',
      label: 'Module & Rechnungsmodus festgelegt',
      done: state.modulesConfigured,
      href: '/staff/admin/settings/modules',
      hint: 'Einmal bewusst speichern — auch wenn die Voreinstellung passt (Rechnungsmodus: In-App, Extern oder Aus).',
    },
    {
      key: 'privacy',
      label: 'Datenschutzangaben vollständig',
      done: state.privacyComplete,
      href: '/staff/admin/privacy',
      hint: 'Pflichtangaben fürs Onboarding und die öffentliche Datenschutzerklärung zentral hinterlegen.',
    },
    {
      key: 'client',
      label: 'Erster Mandant angelegt und GwG-geprüft (aktiv)',
      done: state.activeClientCount > 0,
      href: '/staff/clients',
      hint: 'Ohne abgeschlossene GwG-Prüfung bleibt ein Mandant inaktiv — keine Anforderungen, keine Rechnungen.',
    },
    {
      key: 'contacts',
      label: 'Mindestens ein Portal-Kontakt aktiv',
      done: state.contactCount > 0,
      href: '/staff/clients',
      hint: 'Mandanten brauchen mindestens einen Kontakt mit E-Mail-Adresse, um sich einzuloggen.',
    },
  ];
}
