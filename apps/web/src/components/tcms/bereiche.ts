// =============================================================================
// Unterseiten des Tax-CMS-Bereichs eines Mandanten (TCMS Stufe 3). Eine Liste
// für die Unternavigation (./navigation.tsx), den Leitfaden der
// Bereichs-Agenten (docs/development/tcms-oberflaechen.md) und Tests. Pfade
// relativ zu `/staff/clients/<id>/tcms`. Seiten, die noch fehlen, liefern die
// Bereichs-Agenten; der Link darf vorher auf eine 404 zeigen.
// =============================================================================

export const TCMS_MANDANT_BEREICHE = [
  { pfad: '', label: 'Cockpit' },
  { pfad: '/kontakte', label: 'Kontakte & Rollen' },
  { pfad: '/einrichtung', label: 'Einrichtung' },
  { pfad: '/profil', label: 'Profil' },
  { pfad: '/beschreibung', label: 'Beschreibung' },
  { pfad: '/risiken', label: 'Risiken' },
  { pfad: '/kontrollen', label: 'Kontrollen' },
  { pfad: '/durchfuehrungen', label: 'Durchführungen' },
  { pfad: '/feststellungen', label: 'Feststellungen' },
  { pfad: '/ereignisse', label: 'Ereignisse' },
  { pfad: '/laender', label: 'Länder' },
  { pfad: '/kalender', label: 'Kalender' },
  { pfad: '/pruefung', label: 'Prüfung' },
  { pfad: '/kommunikation', label: 'Kommunikation' },
] as const;

export type TcmsMandantBereich = (typeof TCMS_MANDANT_BEREICHE)[number];

/** Aktiver Bereich zu einem Pfad: längstes passendes Präfix, Cockpit nur exakt. */
export function aktiverTcmsBereich(basis: string, pfad: string): TcmsMandantBereich | null {
  if (pfad === basis || pfad === `${basis}/`) return TCMS_MANDANT_BEREICHE[0];
  let bester: TcmsMandantBereich | null = null;
  for (const bereich of TCMS_MANDANT_BEREICHE) {
    if (bereich.pfad === '') continue;
    const ziel = basis + bereich.pfad;
    if (
      (pfad === ziel || pfad.startsWith(`${ziel}/`)) &&
      (!bester || bereich.pfad.length > bester.pfad.length)
    ) {
      bester = bereich;
    }
  }
  return bester;
}

const KALENDERTAG = /^\d{4}-\d{2}-\d{2}$/;

/** Link in einen Bereich; ein gültiger Stichtag (`?stand=`) bleibt erhalten. */
export function tcmsBereichHref(basis: string, pfad: string, stand: string | null): string {
  return `${basis}${pfad}${stand && KALENDERTAG.test(stand) ? `?stand=${stand}` : ''}`;
}
