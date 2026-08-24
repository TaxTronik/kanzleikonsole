// =============================================================================
// Erlaubte Status-Übergänge für Bescheide (TaxNoticeStatus).
//
// Eigenes Modul (kein 'use server'-File darf Nicht-Funktionen exportieren):
// die Server Action validiert hiergegen, die Page rendert daraus die
// Quick-Action-Auswahl. Liberal-pragmatisch entlang des Einspruchs-
// Lebenszyklus (§ 347 ff. AO):
//   - NEU → GEPRUEFT (Normalfall) oder direkt EINSPRUCH (impliziert Prüfung)
//   - GEPRUEFT → EINSPRUCH / BESTANDSKRAEFTIG; zurück auf NEU (Fehlklick)
//   - EINSPRUCH → ABGEHOLFEN / TEILABHILFE /
//     TEILEINSPRUCHSENTSCHEIDUNG / ZURUECKGEWIESEN
//   - ABGEHOLFEN → BESTANDSKRAEFTIG (voll abgeholfen, kein Klageanlass)
//   - TEILABHILFE → ABGEHOLFEN / TEILEINSPRUCHSENTSCHEIDUNG /
//     ZURUECKGEWIESEN. Der Änderungsbescheid
//     wird nach § 365 Abs. 3 AO Gegenstand des laufenden Einspruchsverfahrens;
//     er ist keine (Teil-)Einspruchsentscheidung und eröffnet keine Klagefrist.
//   - Eine TEILEINSPRUCHSENTSCHEIDUNG eröffnet nur für den entschiedenen Teil
//     eine Klagefrist; das übrige Einspruchsverfahren kann weiterlaufen.
//   - ZURUECKGEWIESEN → KLAGE oder BESTANDSKRAEFTIG
//     (keine Klage; Klagefrist verstrichen/verzichtet)
//   - KLAGE → BESTANDSKRAEFTIG (fachlicher Abschluss des Verwaltungsakts;
//     ein gerichtlicher Rechtskraftstatus wird hier nicht behauptet)
//   - BESTANDSKRAEFTIG ist final und wird nie allein durch Zeitablauf gesetzt.
//
// Klagefrist (§ 47 Abs. 1 FGO, 1 Monat ab Bekanntgabe der Einspruchs-
// entscheidung) wird erst bei einer Einspruchs- oder
// Teil-Einspruchsentscheidung gesetzt und im Kontrollbuch überwacht.
//
// Portal-Relevanz: erst ab GEPRUEFT wird der Bescheid dem Mandanten gezeigt
// (VISIBLE_NOTICE_STATUSES in portal/(protected)/steuer/page.tsx) — ohne
// diese Transition konnte der Portal-Block nie erscheinen.
// =============================================================================

export const NOTICE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  NEU: ['GEPRUEFT', 'EINSPRUCH'],
  GEPRUEFT: ['NEU', 'EINSPRUCH', 'BESTANDSKRAEFTIG'],
  EINSPRUCH: [
    'ABGEHOLFEN',
    'TEILABHILFE',
    'TEILEINSPRUCHSENTSCHEIDUNG',
    'ZURUECKGEWIESEN',
  ],
  ABGEHOLFEN: ['BESTANDSKRAEFTIG'],
  TEILABHILFE: ['ABGEHOLFEN', 'TEILEINSPRUCHSENTSCHEIDUNG', 'ZURUECKGEWIESEN'],
  TEILEINSPRUCHSENTSCHEIDUNG: ['ABGEHOLFEN', 'ZURUECKGEWIESEN', 'KLAGE'],
  ZURUECKGEWIESEN: ['KLAGE', 'BESTANDSKRAEFTIG'],
  KLAGE: ['BESTANDSKRAEFTIG'],
  BESTANDSKRAEFTIG: [],
};
