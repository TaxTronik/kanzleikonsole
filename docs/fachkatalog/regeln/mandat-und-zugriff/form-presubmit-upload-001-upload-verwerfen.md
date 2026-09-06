---
id: FORM-PRESUBMIT-UPLOAD-001
title: Eigene Formularuploads nur vor der Abgabe kontrolliert verwerfen
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Portalprozesse und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Ein Portal-Kontakt kann genau seinen eigenen, eindeutig an ein FILE-Feld
    gebundenen PENDING-/DRAFT-Upload verwerfen, solange der zugehörige Request
    offen ist. Datenbanklöschung und Cleanup-Journal werden atomar geschrieben;
    die physische Löschung erfolgt sofort oder durch den Orphan-Worker.
    Nach einer Kampagnenrückfrage werden historisch gebundene Dateien nur
    aus der aktuellen Antwort gelöst und bei Ersatz als neue Version ergänzt.
sources:
  - kind: product_documentation
    citation: Fachkatalog-Inventur, Self-Service vor Formularabgabe
    path: docs/fachkatalog/SCOPE.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. c und e sowie Art. 25 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/portal/(protected)/forms/[id]/actions.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/filler.tsx
  - packages/db/prisma/migrations/20260823160000_form_upload_relation/migration.sql
test_refs:
  - packages/db/src/__tests__/form-upload-discard-rls.test.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
feature_refs:
  - FEATURES.md
related_rules:
  - FORM-SCHEMA-SNAPSHOT-001
  - YEAR-END-CAMPAIGN-001
  - REQ-LIFECYCLE-001
  - ACCESS-TENANT-RLS-001
tags:
  - formular
  - upload
  - self-service
---

# FORM-PRESUBMIT-UPLOAD-001 — Eigene Formularuploads nur vor der Abgabe kontrolliert verwerfen

## Kurzfassung

Ein Mandant darf einen eigenen Formularupload vor dem Absenden wieder
entfernen. Die Datei muss eindeutig zu seiner Submission und dem konkreten
FILE-Feld gehören; Submission und gebundene Anforderung müssen noch offen
sein. Nach Submit oder Request-Abschluss verweigern App und Datenbank den Pfad.

## Wann gilt die Regel?

Die Regel gilt für Portal-Uploads der Klassifikation `GENERAL`, die als genau
eine saubere, veränderbare Dokumentversion an `formSubmissionId` und
`formFieldKey` gebunden wurden. Allgemeine Mandantendokumente, GwG-Belege,
GoBD-Objekte und bereits abgeschickte Formulare sind ausgeschlossen.

## Benötigte Angaben

- aktiver Portal-Kontakt und sein Mandant
- Submission, FILE-Feld und Dokument-ID
- Status PENDING oder DRAFT
- OPEN/IN_PROGRESS-Status aller gebundenen Requests
- genau eine CLEANe, nicht immutable Dokumentversion
- gespeicherte Bucket-, Key- und Versionsdaten

## Entscheidungslogik

| Wenn                                                        | Dann                                                                     | Begründung                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------- |
| Dokument gehört nicht exakt zu Mandant, Submission und Feld | nichts löschen; idempotent wie bereits verworfen behandeln               | kein Existenz- oder Fremddatenleck  |
| Submission oder Request ist nicht mehr offen                | Verwerfen fail-closed verweigern                                         | nach Abgabe/Abschluss unveränderbar |
| Version ist immutable, nicht CLEAN oder mehrdeutig          | Verwerfen verweigern                                                     | kein sicherer Löschscope            |
| Antwort verweist auf den Upload                             | Feldreferenz innerhalb der Tx lösen                                      | konsistenter Draft                  |
| alle Gates bestehen                                         | Audit und Storage-Orphan-Intent schreiben, Dokumentzeile löschen         | atomare logische Entfernung         |
| physische Sofortlöschung scheitert                          | Erfolg des logischen Verwerfens beibehalten und Worker nachziehen lassen | durable Cleanup-Absicht             |
| neuer Upload im selben Submission-/Feld-Paar                | höchstens eine lebende Zeile zulassen                                    | partieller Unique-Backstop          |

## Ausnahmen und Grenzfälle

Die physische Objektlöschung liegt außerhalb der Datenbanktransaktion. Ein
Fehler führt daher zu einer zeitversetzten Bereinigung, nicht zu einem
Rollback des für den Mandanten bereits konsistent verworfenen Drafts. Für
Legacy-Antworten wurde nur bei eindeutigem Auditnachweis zurückverknüpft; nicht
eindeutige Altdateien sind bewusst nicht über diesen Pfad löschbar.

Bei einer kontrollierten Kampagnenrückfrage (YEAR-END-CAMPAIGN-001) bleibt eine
in FormSubmissionRevisionFile gebundene Quelle erhalten. „Aus Formular entfernen“
löst hier nur die aktuelle Antwortreferenz und schreibt einen entsprechenden
Audit-Hinweis; weder Dokument noch Storage-Version werden gelöscht. Eine
anschließende Ersatzdatei wird als weitere Version desselben gebundenen Dokuments
angefügt. Die aktuelle Dateiliste ignoriert ausdrücklich gelöste historische
Referenzen; ein staler Browser darf weiterhin keinen aktiven Upload übergehen.

## Beispiele

### Normalfall

Ein Mandant lädt im offenen Formular eine falsche PDF hoch und klickt
„Entfernen“. Die Feldreferenz, das Dokument und der Cleanup-Intent werden
atomar angepasst; anschließend wird die konkrete Storage-Version gelöscht.

### Grenzfall

Während des Löschversuchs schließt die Kanzlei die verknüpfte Anforderung. Der
Zeilenlock serialisiert beide Vorgänge; gewinnt der Close, weist die
Datenbankfunktion den späteren Discard als nicht mehr verwerfbar zurück.

## Umsetzung in TaxTronik

Die Portal-Action sperrt die Submission, validiert Feld, Dokument und Version,
journalisiert den Storage-Cleanup über eine eng gebundene
SECURITY-DEFINER-Funktion und löscht danach die Dokumentzeile. Bucket und Key
werden ausschließlich aus persistierten Daten übernommen. Der Orphan-Worker
schließt fehlgeschlagene physische Deletes später ab.

Für neue Vorgänge stammen FILE-Felddefinition und Validierungsgrenzen aus dem
unveränderlichen Submission-Snapshot (FORM-SCHEMA-SNAPSHOT-001). Legacy-Vorgänge
ohne Snapshot verwenden ausdrücklich weiter die aktuelle Vorlage; ein vorhandener
ungültiger Snapshot wird nicht still durch diese ersetzt. Der Nachweis steht in
`apps/web/src/server/forms/__tests__/schema-snapshot.test.ts` und die gemeinsame
Umsetzungsbeschreibung in `docs/development/module/workflow-expansion.md`.

## Bekannte Abweichungen und Grenzen

Keine bekannte Abweichung in der beschriebenen Vorabgabe-Semantik. „Physisch
verworfen“ kann bei Storagefehlern jedoch erst nach dem Worker-Lauf erreicht
sein. Die Regel sagt nichts über Backupkopien oder die spätere Retention eines
bereits eingereichten Belegs aus.

## Fachliche Prüffragen

- Ist die Abgrenzung ausschließlich auf PENDING/DRAFT und offene Requests richtig?
- Welche Rückmeldung braucht der Mandant bei verzögerter physischer Bereinigung?
- Wie werden Backup- und Replikatkopien des verworfenen Uploads behandelt?
- Sollen weitere vorvertragliche Uploadarten denselben Pfad nutzen dürfen?

## Technische Nachweise

Der DB-Test belegt Portalidentität, Mandantenscope, Akteurtyp, Unique-Index und
die Race zum Request-Close. Actiontests belegen Feldbindung, logische Löschung,
Audit, Cleanup-Journal und den unmittelbaren Storage-Versuch.
