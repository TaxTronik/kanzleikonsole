// =============================================================================
// Feste Texte zu ungeklärten Anlagen aus Portal-Meldungen (kk-tcms-s10nach,
// kk-tcms-s11 Punkt 3; TCMS-NACHWEIS-001). Gemeinsam für die Anzeige im
// Ereigniseingang und die Aktionen „zuordnen“ und „freigeben“ – nie Texte des
// Dienstes.
// =============================================================================

export const UNGEKLAERT_TEXT =
  'Für diese Anlagen aus Portal-Meldungen hat das Tax-CMS den Eingang der Meldung nicht innerhalb von 23 Stunden bestätigt. Ob die Meldung eingegangen ist, ist offen; die Dokumente bleiben deshalb gegen Löschen und neue Versionen gesperrt. Bitte prüfen Sie den Ereigniseingang: Enthält ein Ereignis die Anlage, ordnen Sie sie ihm zu. Führt kein Ereignis die Anlage, können Admins und Partner sie freigeben – das Tax-CMS bestätigt das vorher.';

export const ZUORDNEN_NUR_ADMIN =
  'Ungeklärte Anlagen ordnen Admins und Partner der Kanzlei zu oder geben sie frei.';

export const FREIGEBEN_HINWEIS =
  'Freigegeben wird nur, wenn das Tax-CMS bestätigt, dass kein Ereignis dieses Mandanten die Anlage führt – auch kein verworfenes. Die Freigabe ist endgültig und wird mit Ihrer Begründung protokolliert; danach lässt sich das Dokument wieder löschen und versionieren.';

/** Länge der Pflichtbegründung (Zeichenregel des Vertrags für Freitexte). */
export const FREIGABE_BEGRUENDUNG = { min: 20, max: 1000 } as const;

export const ANLAGE_NICHT_OFFEN =
  'Diese Anlage ist nicht mehr ungeklärt. Bitte laden Sie die Seite neu.';
export const ANLAGE_IN_KLAERUNG =
  'Die Meldung zu dieser Anlage kann noch übermittelt werden. Bitte versuchen Sie es in einigen Minuten erneut.';
export const ANLAGE_IM_EREIGNIS =
  'Das Tax-CMS führt diese Anlage an einem Ereignis (auch verworfene Meldungen zählen). Freigeben ist deshalb nicht möglich; bitte ordnen Sie die Anlage dem Ereignis zu.';
export const ANLAGE_NICHT_BESTAETIGT =
  'Das Tax-CMS hat nicht bestätigt, dass keine Meldung diese Anlage führt. Die Anlage bleibt gesperrt.';
export const ANLAGE_FREIGEGEBEN =
  'Die Anlage ist freigegeben. Das Dokument lässt sich wieder löschen und versionieren.';
