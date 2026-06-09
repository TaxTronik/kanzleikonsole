// =============================================================================
// Erlaubte Status-Übergänge für Bescheide (TaxNoticeStatus).
//
// Eigenes Modul (kein 'use server'-File darf Nicht-Funktionen exportieren):
// die Server Action validiert hiergegen, die Page rendert daraus die
// Quick-Action-Auswahl. Liberal-pragmatisch entlang des Einspruchs-
// Lebenszyklus (§ 347 ff. AO):
//   - NEU → GEPRUEFT (Normalfall) oder direkt EINSPRUCH (impliziert Prüfung)
//   - GEPRUEFT → EINSPRUCH / RECHTSKRAEFTIG; zurück auf NEU (Fehlklick)
//   - EINSPRUCH → ABGEHOLFEN / ZURUECKGEWIESEN
//   - ABGEHOLFEN / ZURUECKGEWIESEN → RECHTSKRAEFTIG
//   - RECHTSKRAEFTIG ist final
//
// Portal-Relevanz: erst ab GEPRUEFT wird der Bescheid dem Mandanten gezeigt
// (VISIBLE_NOTICE_STATUSES in portal/(protected)/steuer/page.tsx) — ohne
// diese Transition konnte der Portal-Block nie erscheinen.
// =============================================================================

export const NOTICE_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  NEU: ['GEPRUEFT', 'EINSPRUCH'],
  GEPRUEFT: ['NEU', 'EINSPRUCH', 'RECHTSKRAEFTIG'],
  EINSPRUCH: ['ABGEHOLFEN', 'ZURUECKGEWIESEN'],
  ABGEHOLFEN: ['RECHTSKRAEFTIG'],
  ZURUECKGEWIESEN: ['RECHTSKRAEFTIG'],
  RECHTSKRAEFTIG: [],
};
