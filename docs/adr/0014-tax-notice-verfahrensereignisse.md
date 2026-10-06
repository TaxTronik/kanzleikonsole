# ADR 0014 — TaxNotice: Verfahrensereignisse als Zeilen statt Spaltengruppen

**Status**: Vorschlag (umzusetzen mit der nächsten fachlichen Änderung am Bescheidverfahren)
**Datum**: 2026-10-06
**Kontext**: Review-Finding D-02. `tax_notice` ist die mit Abstand breiteste Tabelle
(`packages/db/prisma/schema.prisma`, Modell `TaxNotice`). Bescheid, Bekanntgabe/Zugang,
Datenabruf nach § 122a AO, zwei Feiertagskontexte, Fristberechnung und jeder
Rechtsbehelfsschritt stehen als Spaltengruppen nebeneinander; die Regeln dazu stecken in
CHECKs und Triggern derselben Tabelle.

## Befund (Stand 2026-10-06, frisch migrierte Datenbank)

- 81 Spalten, davon 50 nullable; die nächstbreite Tabelle (`power_of_attorney`) hat 32.
- 19 CHECK-Constraints, davon 18 `NOT VALID` (nur `tax_notice_delivery_method_check` ist
  validiert): Jede Verschärfung musste für Altbestand ungeprüft bleiben.
- 5 Trigger: `00_tenant_client_pair_integrity` (generisch) sowie
  `tax_notice_appeal_deadline_trigger` (feuert auf 40 Spalten),
  `tax_notice_progress_evidence_trigger`, `tax_notice_partial_relief_evidence_guard` und
  `tax_notice_00_retrieval_legacy_fallback_guard`.
- Spaltengruppen:

| Gruppe                                      | Spalten | Beispiele                                                                           |
| ------------------------------------------- | ------: | ----------------------------------------------------------------------------------- |
| Bezug und Verwaltung                        |      11 | `tenant_id`, `client_id`, `kind`, `period`, `document_id`, `filing_id`              |
| Bescheidinhalt und Prüfung                  |      11 | `notice_date`, `status`, Beträge, `reviewed_at`, `reviewed_by`                      |
| Bekanntgabe, Zugang, Rechtsbehelfsbelehrung |      11 | `delivery_method`, `received_at`, `date_basis`, `access_status`                     |
| Datenabruf (§ 122a AO)                      |      11 | `retrieval_issued_at`, `retrieval_consent_status`                                   |
| Feiertagskontext Empfänger                  |       7 | `recipient_name`, `recipient_region`, `recipient_holiday_context_status`            |
| Feiertagskontext Behörde                    |       7 | `authority_name`, `authority_region`, `authority_holiday_context_status`            |
| gemeinsame Feiertagsnotiz                   |       1 | `holiday_context_note`                                                              |
| Fristberechnung                             |       8 | `appeal_deadline`, `deadline_calculation_status`, `manual_review_required`          |
| Einspruch                                   |       4 | `appeal_filed_at`, `appeal_filed_by`, `appeal_reason`, `appeal_resolved_at`         |
| Teilabhilfe                                 |       2 | `partial_relief_received_at`, `partial_relief_received_by`                          |
| Einspruchsentscheidung                      |       3 | `appeal_decision_received_at`, `…_legal_remedy_instruction_valid`, `klage_deadline` |
| Klage                                       |       2 | `klage_filed_at`, `klage_filed_by`                                                  |
| Bestandskraft                               |       3 | `legal_final_at`, `legal_final_by`, `legal_final_reason`                            |

Jeder neue Rechtsbehelfsweg (Wiedereinsetzung, dokumentierter Verzicht, parallele Zweige
nach einer Teil-Einspruchsentscheidung — alle in `TAX-CONTROL-STATUS-001` als Lücke
geführt) bedeutet heute neue Spalten, neue CHECKs und eine Revision von
`app.tax_notice_require_progress_evidence`. Der Status ist ein frei gesetztes Feld, dessen
Konsistenz mit den Ereignisspalten nur Constraints und Trigger sichern; die Reihenfolge
der Ereignisse prüfen ein CHECK über alle Datumsspalten
(`tax_notice_event_sequence_check`) und der Fortschrittstrigger.

## Entscheidung

Bei der nächsten fachlichen Änderung am Bescheidverfahren wird das Verfahren in zwei
Teile zerlegt; vorher wird das Schema nicht geändert.

### 1. Verfahrensereignisse als Zeilen in `tax_notice_event`

Jeder fachliche Verfahrensschritt ist eine unveränderliche Zeile:

| Spalte                         | Bedeutung                                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `id`, `tenant_id`, `client_id` | wie alle Mandantentabellen; RLS mit `FORCE`, Tenant-/Mandantenpaar per Trigger                       |
| `notice_id`                    | Fremdschlüssel auf `tax_notice`                                                                      |
| `type`                         | Ereignistyp (Enum, siehe unten)                                                                      |
| `occurred_on`                  | fachlicher Ereignistag (Kalendertag)                                                                 |
| `recorded_at`                  | Zeitpunkt der Erfassung nach Datenbankuhr                                                            |
| `actor_staff_id`               | handelnde beziehungsweise dokumentierende Person                                                     |
| Nachweis                       | `evidence_document_id` (optional, Fremdschlüssel auf `document`), `evidence_status`, `evidence_note` |
| typspezifisch                  | `decision_kind`, `legal_remedy_instruction_valid`, `reason`; je Typ per CHECK Pflicht oder leer      |
| `supersedes_event_id`          | Korrektur als neues Ereignis statt `UPDATE`                                                          |

Die Tabelle ist append-only (kein `UPDATE`/`DELETE` für die App-Rolle, Trigger wie bei
den Audit-Tabellen). Typspezifische Angaben stehen in wenigen typisierten Spalten mit
CHECK je Typ, nicht in JSONB, damit Prisma-Typen und Constraints greifen.

Ereignistypen beim Umstieg, abgeleitet aus den heutigen Spalten:

| Ereignistyp                | heutige Spalten                                                                                       | abgeleiteter Status                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `NOTICE_REVIEWED`          | `reviewed_at`, `reviewed_by`                                                                          | `GEPRUEFT`                                          |
| `APPEAL_FILED`             | `appeal_filed_at`, `appeal_filed_by`, `appeal_reason`                                                 | `EINSPRUCH`                                         |
| `PARTIAL_RELIEF_RECEIVED`  | `partial_relief_received_at`, `partial_relief_received_by`                                            | `TEILABHILFE`                                       |
| `APPEAL_GRANTED`           | `appeal_resolved_at` bei Abhilfe                                                                      | `ABGEHOLFEN`                                        |
| `APPEAL_DECISION_RECEIVED` | `appeal_decision_received_at`, `appeal_decision_legal_remedy_instruction_valid`, `appeal_resolved_at` | `TEILEINSPRUCHSENTSCHEIDUNG` oder `ZURUECKGEWIESEN` |
| `COURT_ACTION_FILED`       | `klage_filed_at`, `klage_filed_by`                                                                    | `KLAGE`                                             |
| `LEGAL_FINALITY_RECORDED`  | `legal_final_at`, `legal_final_by`, `legal_final_reason`                                              | `BESTANDSKRAEFTIG`                                  |

Ein neuer Rechtsbehelfsweg ist danach ein neuer Ereignistyp und eine neue Zeile der
Übergangstabelle, keine Spaltengruppe.

### 2. Status aus den Ereignissen abgeleitet

`tax_notice.status` bleibt als Projektion erhalten (Indizes wie
`tax_notice_tenant_id_status_appeal_deadline_idx`, Prisma-Lesepfade und RLS bleiben
unverändert), wird aber nur noch vom Ereignis-Trigger gesetzt; direkte Statusänderungen
lehnt die Datenbank nach dem Umstieg ab. Ein `BEFORE INSERT`-Trigger auf
`tax_notice_event` übernimmt die heutige Fortschrittsprüfung: zulässiges Ereignis für den
abgeleiteten Stand (Übergangstabelle), vollständige Nachweise, Reihenfolge der
Ereignistage und Fristablauf vor Bestandskraft. Die Klagefrist wird aus dem
Entscheidungsereignis berechnet und bleibt als Fristspalte am Bescheid. Jedes Ereignis
aktualisiert `tax_notice.updated_at`, damit die Bindung persönlicher Rückfragen an den
Bescheidstand (`TAX-NOTICE-DECISION-001`) Änderungen weiter erkennt. Das Audit-Log bleibt
der technische Änderungsnachweis; Ereignisse sind die fachlichen Tatsachen.

### 3. Feiertagskontext als Wertobjekt je Partei

Die je sieben parallelen `recipient_*`- und `authority_*`-Spalten werden zu
`tax_notice_party_context` mit Primärschlüssel (`notice_id`, `party`), `party` aus
`RECIPIENT` oder `AUTHORITY`, und den Feldern Name, Land, Region, Ort, örtliche
Feiertage, Bayern-Annahme, Kontextstatus und Notiz. Die Regionsregel steht dann einmal als
CHECK der Zeile statt zweimal in `tax_notice_region_code_check`. Regeln, die beide
Parteien zusammen mit der Fristberechnung verlangen (heute in
`tax_notice_calculation_result_check` und `tax_notice_input_documentation_check`), kann
ein CHECK über zwei Tabellen nicht ausdrücken; sie wandern in die Berechnungsfunktion,
die bei Änderungen an Bescheid oder Kontext läuft. Ob die Feiertagsnotiz je Partei oder
gemeinsam geführt wird, entscheidet die fachliche Prüfung bei der Umsetzung.

### Zuordnung der heutigen Regeln

| Heute                                            | Ziel                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| `tax_notice_appeal_filing_evidence_check`        | Pflichtspalten von `APPEAL_FILED`; Status nur noch abgeleitet              |
| `tax_notice_partial_relief_evidence_check`       | Pflichtspalten von `PARTIAL_RELIEF_RECEIVED`                               |
| `tax_notice_decision_deadline_check`             | Pflichtspalten von `APPEAL_DECISION_RECEIVED`; Klagefrist daraus berechnet |
| `tax_notice_court_filing_evidence_check`         | Pflichtspalten von `COURT_ACTION_FILED`                                    |
| `tax_notice_legal_final_evidence_check`          | `LEGAL_FINALITY_RECORDED` (Begründung) und Übergangsprüfung (Fristablauf)  |
| `tax_notice_event_sequence_check`                | Reihenfolgeprüfung im Ereignis-Trigger                                     |
| `tax_notice_region_code_check`                   | CHECK von `tax_notice_party_context`, einmal je Zeile                      |
| `tax_notice_calculation_result_check`            | bleibt am Bescheid; Bedingungen an die Feiertagskontexte in die Berechnung |
| `tax_notice_input_documentation_check`           | Namen und Notizen an den Kontext, übrige Notizen bleiben am Bescheid       |
| übrige 10 CHECKs (Zugang, Belehrung, § 122a AO)  | bleiben an `tax_notice`                                                    |
| `app.tax_notice_require_progress_evidence`       | wird der `BEFORE INSERT`-Trigger von `tax_notice_event`                    |
| `app.tax_notice_guard_partial_relief_evidence`   | entfällt: Ereignisse sind unveränderlich                                   |
| `app.tax_notice_set_appeal_deadline`             | bleibt; liest die Kontexte und läuft auch bei deren Änderung               |
| `app.tax_notice_guard_retrieval_legacy_fallback` | bleibt; Spaltenliste ohne Feiertagsfelder                                  |
| `00_tenant_client_pair_integrity`                | bleibt und kommt auf beide neuen Tabellen                                  |

### Fachkatalog

Betroffen sind `TAX-CONTROL-STATUS-001` (Statusableitung, Nachweise, Kontrollbuch),
`TAX-NOTICE-APPEAL-001` (Eingaben der Fristberechnung), `TAX-NOTICE-DATARETRIEVAL-001`
(§-122a-Felder bleiben, Berechnung liest die Kontexte), `TAX-DEADLINE-WORKDAY-001`
(Feiertagskontext je Partei), `TAX-NOTICE-DECISION-001` (Bindung an den Bescheidstand) und
`CLIENT-OFFBOARDING-001` (liest offene Bescheidverfahren); für die neuen Tabellen zusätzlich
`ACCESS-TENANT-RLS-001`. Dieses ADR ändert den Katalog nicht. Die Umsetzung aktualisiert
die Regeln, Umsetzungshinweise und Nachweise im selben Commit (AGENTS.md).

## Migration

Expand/Contract nach `docs/operations/release.md`, Abschnitt 4:

1. **Expand (Release N):** `tax_notice_event` und `tax_notice_party_context` mit RLS,
   Triggern und Indizes anlegen. Backfill in derselben Migration: zwei Kontextzeilen je
   Bescheid aus den heutigen Spalten; Ereignisse nur für eindeutig dokumentierte
   Tatsachen (Tag und Person vorhanden). Altbestände ohne solche Tatsachen erhalten keine
   geschätzten Ereignisse; sie behalten ihren historischen Status, bis ein Mitarbeiter
   den nächsten Schritt mit bestätigten Tatsachen erfasst (wie heute bei Teilabhilfe).
   Mehrdeutige Fälle (etwa die Art einer Einspruchsentscheidung nach späterer Abhilfe)
   werden gezählt und als manuelle Prüfung gemeldet, nicht geraten.
2. **Doppeltes Schreiben (Release N):** Die Statusübergänge schreiben Spalten und
   Ereignisse in derselben Transaktion. Eine Invariante in `packages/db/invariants`
   vergleicht den abgeleiteten Status mit der Spalte und meldet Abweichungen; der
   CI-Job `upgrade-path` prüft sie nach dem Kunden-Update.
3. **Umstieg (Release N+1):** Kontrollbuch-Adapter (`apps/web/src/server/fristen/quellen`),
   Bescheidseite, Portal-Sichtbarkeit, Zeitachse, Offboarding und
   `reminders-daily` lesen Ereignisse und Kontexte; geschrieben werden nur noch
   Ereignisse. Die alten Spalten sind schreibgeschützt, bleiben aber für ein App-Rollback
   lesbar.
4. **Contract (Release N+2 oder später):** alte Spalten, die gewanderten CHECKs und die
   entfallenden Triggerteile entfernen; `schema.prisma` und die kanonischen SQL-Quellen
   (`pnpm db:sql:migration`, D-01) nachziehen.

## Konsequenzen

- Ein neuer Rechtsbehelfsweg ändert eine Enum-Liste und die Übergangstabelle statt
  Spalten, CHECKs und Trigger. Teilverfahren und parallele Zweige lassen sich später über
  einen Gegenstandsbezug am Ereignis abbilden.
- Ereignisse können auf ein Belegdokument verweisen; damit lässt sich die in
  `TAX-CONTROL-STATUS-001` genannte Lücke „Zeit und Person, aber kein Beweisdokument“
  schließen.
- Historie und Korrekturen sind sichtbar statt überschrieben.
- Kosten: zusätzliche Tabellen und Joins, ein Projektionstrigger, eine Phase mit
  doppeltem Schreiben, Backfill mit dokumentierten Lücken und neue Tests für Trigger,
  RLS und Ableitung. Löschkonzept, Anonymisierung und Backup-Prüfungen müssen die neuen
  Tabellen einschließen.

## Alternativen verworfen

- **Spaltenmodell beibehalten:** jede Erweiterung kostet weiter Spalten, `NOT VALID`-CHECKs
  und Triggerrevisionen; der Status bleibt ein frei gesetztes Feld.
- **Historie als JSONB am Bescheid:** keine Fremdschlüssel auf Personen und Belege, keine
  Typprüfung, keine eigenen RLS-Regeln.
- **Composite Types für den Feiertagskontext:** Prisma unterstützt PostgreSQL-Composite-
  Types nicht.
- **Eine Tabelle je Rechtsbehelf** (`tax_notice_appeal`, `tax_notice_court_action`, …):
  wieder eine Schemaänderung je neuem Weg, und die Reihenfolge über mehrere Tabellen
  braucht tabellenübergreifende Prüfungen.
- **Reines Event-Sourcing ohne Statusspalte:** bricht Indizes und bestehende
  Prisma-Lesepfade auf einmal; die Projektion erreicht dasselbe schrittweise.
