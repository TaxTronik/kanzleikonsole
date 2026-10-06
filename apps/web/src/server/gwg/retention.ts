// =============================================================================
// GwG § 8 Abs. 4 — Löschprüfung nach Fristablauf (Web-Adapter)
//
// Satz 1 schreibt grundsätzlich fünf Jahre Aufbewahrung vor, soweit nicht eine
// andere gesetzliche Bestimmung eine längere Frist verlangt. Satz 2 ordnet in
// jedem Fall die Vernichtung spätestens nach zehn Jahren an. Diese Anwendung
// bildet keine zusätzliche Rechtsgrundlage ab und führt deshalb nach Ablauf der
// regulären Fünfjahresfrist eine manuelle Löschprüfung durch
// (DSGVO Art. 5 Abs. 1 lit. e); die eigentliche Vernichtung bestätigt der
// Berufsträger (kein stilles Auto-Delete von Rechtsbelegen).
//
// K-01: Fristprädikate und Datenbankfilter (@taxtronik/gwg/retention, auch vom
// Worker-Job gwg-expiry-check genutzt) sowie die Review-Queue-Abfragen
// (@taxtronik/gwg/review-queue) liegen unverändert im Paket. Dieses Modul
// behält den bestehenden Importpfad der Web-App (Admin-Kachel, Review-Queue,
// DSGVO-Anonymisierungsfrist).
// =============================================================================

export {
  dueGwgCheckDeletionsWhere,
  dueGwgDeletionDocsWhere,
  GWG_MAX_RETENTION_YEARS,
  GWG_RETENTION_YEARS,
  gwgDeletionDeadline,
  gwgDocumentEffectiveStart,
  gwgEffectiveStart,
  gwgMaximumDeletionDeadline,
  isGwgDeletionDue,
  type GwgDocumentRetentionContext,
} from '@taxtronik/gwg/retention';
export {
  countDueGwgDeletionDocs,
  findDueGwgCheckDeletions,
  findDueGwgDeletionDocs,
  type GwgCheckDeletionItem,
  type GwgDeletionItem,
} from '@taxtronik/gwg/review-queue';
