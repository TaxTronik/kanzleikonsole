---
id: FORM-SCHEMA-SNAPSHOT-001
title: Neue Formularvorgänge an einen unveränderlichen Vorlagenstand binden
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Der beschriebene Produktumfang ist implementiert. Die fachliche Freigabe
    und eine produktionsnahe Datenbank- und Bedienabnahme stehen noch aus.
sources:
  - kind: product_documentation
    citation: Workflow-Erweiterungen und Abnahmegrenzen
    path: docs/development/module/workflow-expansion.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - apps/web/src/server/forms/schema-snapshot.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/actions.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/page.tsx
  - apps/web/src/server/forms/revision-download.ts
  - apps/web/src/components/form-revision-history.tsx
  - apps/web/src/server/workflows/year-end-return.ts
  - apps/web/src/app/staff/(protected)/forms/submissions/[id]/page.tsx
  - packages/db/prisma/migrations/20260831110000_workflow_expansion/migration.sql
  - packages/db/prisma/migrations/20260831280000_form_submission_revisions/migration.sql
  - packages/db/prisma/migrations/20260831300000_form_revision_source_guard/migration.sql
test_refs:
  - apps/web/src/server/forms/__tests__/schema-snapshot.test.ts
  - apps/web/src/server/forms/__tests__/revision-download.test.ts
  - apps/web/src/server/workflows/__tests__/year-end-return.test.ts
  - packages/db/src/__tests__/workflow-expansion.test.ts
feature_refs:
  - docs/development/module/workflow-expansion.md
related_rules:
  - FORM-PRESUBMIT-UPLOAD-001
  - REQ-LIFECYCLE-001
tags:
  - workflow
  - mandantenportal
  - ungeprueft
---

# FORM-SCHEMA-SNAPSHOT-001 — Neue Formularvorgänge an einen unveränderlichen Vorlagenstand binden

## Kurzfassung

Jede neu angelegte FormSubmission erhält in der Datenbank einen Snapshot aus Name, Beschreibung, Einleitung und sämtlichen Felddefinitionen einschließlich Pflichtfeldern, Optionen und Grenzen. Anzeige, Validierung und Dateifeldbindung verwenden denselben gespeicherten Stand. Schema und Vorlagen-ID können nach Anlage nicht geändert werden.

## Wann gilt die Regel?

Für den beschriebenen neuen Vorgang innerhalb eines Tenants bei aktivierten Modulen und aktuellem Mandantenzugriff.

## Benötigte Angaben

Aktueller Akteur, gebundener Fachvorgang, geprüfte Auswahl und der in der Entscheidungslogik beschriebene Vorlagen- beziehungsweise Quellstand.

## Entscheidungslogik

Bestehende Vorgänge mit NULL-Snapshot bleiben ausdrücklich Legacy: Die Oberfläche zeigt, dass kein historischer Vorlagenstand vorliegt, und verwendet wie bisher die aktuelle Vorlage. Die Migration erfindet keinen damaligen Inhalt. Ein vorhandener, aber ungültiger Snapshot führt zum Fehler statt zum stillen Rückfall.

Kampagnen dürfen einen bei Kampagnenanlage eingefrorenen Stand an neue Einzelvorgänge binden. Änderungen an einer Vorlage wirken deshalb nur auf neu eingefrorene Stände. Neue Feldänderungen ersetzen keine bereits eingereichten Antworten. Ein Snapshot ist kein Nachweis einer fachlich richtigen Vorlage.

Vor einer Kampagnenrückfrage erhält der abgegebene Stand eine zusätzliche unveränderliche FormSubmissionRevision mit ursprünglichem Schema, Antworten und Abgabezeit. Dateien binden die aufgezeichnete Version zum Abgabezeitpunkt, nicht eine später hochgeladene Fassung. Fehlende historische Schemata oder nicht eindeutig vorhandene Quellen sperren diesen Rückgabepfad. Es erfolgt keine nachträgliche Behauptung unbekannter historischer Stände. Die Historie wird erst bei dieser kontrollierten Rückgabe gesichert; sie ist kein nachträglich erfundener lückenloser Verlauf sämtlicher früherer Änderungen.

## Ausnahmen und Grenzfälle

Fehlender Zugriff, ungültiger oder veränderter Quellstand und geschlossene Vorgänge werden fail-closed behandelt. Die konkrete Legacy- und Korrekturbehandlung ist in der Entscheidungslogik abgegrenzt.

## Beispiele

Ein berechtigter Mitarbeiter bereitet den beschriebenen Vorgang vor und prüft seine Auswahl. Ein zweiter Kontakt erhält dadurch keine zusätzlichen Rechte; ein später geänderter Quellstand wird nicht still als ursprüngliche Grundlage dargestellt.

## Umsetzung in TaxTronik

Personenbezogene Fachdaten gehören zum privaten Workflowbestand des bestehenden Löschkonzepts. Diese Regel begründet keine neue Aufbewahrungsdauer. Unveränderliche Evidenz enthält IDs und knappe Statusmerkmale, keine Nachrichtentexte. Vor einer produktiven Nutzung sind Datenbankmigration, negative Zugriffsprüfungen und organisatorische Zuständigkeiten abzunehmen.

## Bekannte Abweichungen und Grenzen

Es fehlt die produktionsnahe Abnahme der neuen Migration und ihrer RLS-Regeln mit getrennten Owner-/App-Verbindungen sowie die fachliche Freigabe. Die Funktion behauptet keine gesetzliche Aufbewahrungsdauer und keinen Beweis der Vertretungsmacht.

## Fachliche Prüffragen

Wer ist für die Auswahl und Sichtung verantwortlich? Welche fachlichen Vorlagen dürfen eingesetzt werden? Wie werden abgebrochene oder falsch adressierte Vorgänge organisatorisch korrigiert? Welche Einzelfallgründe beeinflussen die Löschung?

## Technische Nachweise

Die referenzierten Unit- und Regressionstests prüfen den abgegrenzten technischen Umfang. Datenbanktests benötigen eine getrennte Owner- und App-Verbindung und sind ohne diese Umgebung als übersprungen auszuweisen. Eine Testdefinition ersetzt weder ihren erfolgreichen Datenbanklauf noch eine fachliche Freigabe.
