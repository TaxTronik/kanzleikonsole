---
id: YEAR-END-CAMPAIGN-001
title: Jahreswechsel-Checklisten nachvollziehbar und idempotent ausrollen
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
  - apps/web/src/app/staff/(protected)/year-end/actions.ts
  - apps/web/src/app/staff/(protected)/year-end/page.tsx
  - apps/web/src/server/workflows/dashboard-policy.ts
  - apps/web/src/server/workflows/year-end-return.ts
  - apps/web/src/server/forms/revision-download.ts
  - apps/web/src/components/form-revision-history.tsx
  - apps/web/src/app/api/staff/form-revision-files/[id]/route.ts
  - apps/web/src/app/api/portal/form-revision-files/[id]/route.ts
  - apps/web/src/app/staff/(protected)/forms/submissions/[id]/page.tsx
  - apps/web/src/app/portal/(protected)/forms/[id]/actions.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/page.tsx
  - packages/db/prisma/migrations/20260831110000_workflow_expansion/migration.sql
  - packages/db/prisma/migrations/20260831280000_form_submission_revisions/migration.sql
  - packages/db/prisma/migrations/20260831300000_form_revision_source_guard/migration.sql
test_refs:
  - apps/web/src/server/forms/__tests__/schema-snapshot.test.ts
  - apps/web/src/server/workflows/__tests__/dashboard-policy.test.ts
  - apps/web/src/server/workflows/__tests__/year-end-return.test.ts
  - apps/web/src/server/forms/__tests__/revision-download.test.ts
  - apps/web/src/app/portal/(protected)/forms/[id]/__tests__/actions.test.ts
  - packages/db/src/__tests__/workflow-expansion.test.ts
feature_refs:
  - docs/development/module/workflow-expansion.md
related_rules:
  - FORM-SCHEMA-SNAPSHOT-001
  - REQ-LIFECYCLE-001
  - FORM-PRESUBMIT-UPLOAD-001
tags:
  - workflow
  - mandantenportal
  - ungeprueft
---

# YEAR-END-CAMPAIGN-001 — Jahreswechsel-Checklisten nachvollziehbar und idempotent ausrollen

## Kurzfassung

ADMIN/PARTNER legt eine Kampagne mit Name, Jahr, aktivem Formular und internem Zieltermin an. Der vollständige Formularstand wird dabei eingefroren. Vor dem Ausrollen wählt die Person ausdrücklich maximal 200 zugängliche aktive Mandate mit freigeschaltetem Portal aus.

## Wann gilt die Regel?

Für den beschriebenen neuen Vorgang innerhalb eines Tenants bei aktivierten Modulen und aktuellem Mandantenzugriff.

## Benötigte Angaben

Aktueller Akteur, gebundener Fachvorgang, geprüfte Auswahl und der in der Entscheidungslogik beschriebene Vorlagen- beziehungsweise Quellstand.

## Entscheidungslogik

Der Lauf erzeugt pro Kampagne und Mandant genau eine Submission und eine gebundene Anforderung. Ein Unique-Backstop und Kampagnenlock machen Wiederholungen idempotent. Die gesamte Auswahl wird atomar verarbeitet; Fehler erzeugen keinen teilweise erfolgreichen Lauf. Bereits zugeordnete Mandanten werden übersprungen.

Die Übersicht unterscheidet noch nicht begonnen, in Bearbeitung, Rückfrage mit erneuter Abgabe, eingereicht mit offener Kanzleiprüfung und REVIEWED; geschlossene beziehungsweise abgebrochene Anforderungen sind separat erkennbar. Der Fortschritt zählt technisch gültig beantwortete Eingabefelder des eingefrorenen Schemas, ergänzt um erfüllte Pflichtfelder. INFO_TEXT zählt nicht als Eingabefeld. Nullbeträge und zulässige Nein-Antworten werden nicht als leer behandelt; eine notwendige Checkboxbestätigung muss wahr sein. Fehlende historische oder beschädigte Schemata erhalten keine erfundene Prozentangabe. Diese Anzeige und ein Submit beweisen keine inhaltliche Vollständigkeit. Die Dokumente folgen den bestehenden allgemeinen Formularrechten, nicht einem eigenen Personal-ACL.

Eine aktuell berechtigte Kanzleiperson kann einen eingereichten, nicht abgebrochenen Kampagnenvorgang mit ausdrücklicher mandantensichtbarer Rückfrage erneut freigeben. Vor der Freigabe sichert dieselbe Transaktion unveränderlich die ursprüngliche Fragenfassung, Antworten, Abgabezeit, Kontakt-ID und die zum Abgabezeitpunkt letzte aufgezeichnete saubere Dateiversion je Dateifeld. Ist ein solcher Quellstand nicht eindeutig verfügbar oder fehlt der historische Schema-Snapshot, scheitert die Rückgabe vollständig; die aktuelle Vorlage wird nie als frühere Abgabe ausgegeben. Die Transaktion setzt erst danach den vorhandenen Formularstatus auf DRAFT und die Anforderung auf IN_PROGRESS. Die letzte Abgabezeit bleibt erkennbar, die Kanzleiprüfung wird zurückgesetzt, und die Rückfrage wird als öffentliche RequestResponse gespeichert. Interne Reviewnotizen werden nicht veröffentlicht. Korrekturen bearbeiten den aktuellen Antwortstand, während die vor jeder Rückfrage gesicherte Einreichung in Staff und Portal getrennt einsehbar bleibt. Die Darstellung „Rückfrage“ wird aus DRAFT mit vorhandener früherer Abgabe abgeleitet. Steuerliche Fristen und andere Workflow-Erledigungen werden nicht geändert.

Historische Dateiverweise binden DocumentVersion-ID, Storage-Version und Hash; spätere Uploads ersetzen diese Quellen nicht. Der historische Download verwendet den eingefrorenen Dateinamen, prüft aktuelle Formular-/Mandantenrechte und Freigabe vor und nach dem Storagezugriff und verweigert inzwischen gelöschte oder quarantänisierte Quellen. Ein Entfernen nach Rückfrage löst nur die aktuelle Antwortreferenz. Ersatzdateien werden nach ausdrücklichem Lösen als neue Version desselben gebundenen Dokuments angefügt. Diese Semantik erhält die alten Bytes und vermeidet einen Konflikt mit der eindeutigen Feldbindung. Die gebundene Version darf auch durch allgemeines Retagging nicht auf andere Bytes umgebogen werden; eine solche Änderung scheitert kontrolliert.

Bereitstellung erfolgt im Portal ohne gesonderten Massen-E-Mail-Versand. Bestehende Anforderungsreminder folgen dem internen Zieltermin. Es erfolgt keine steuerrechtliche Fristberechnung und keine automatische Kanzleiprüfung. Kampagnen sind nach Anlage unveränderlich; Korrekturen benötigen eine neue Kampagne.

## Ausnahmen und Grenzfälle

Fehlender Zugriff, ungültiger oder veränderter Quellstand und geschlossene Vorgänge werden fail-closed behandelt. Die konkrete Legacy- und Korrekturbehandlung ist in der Entscheidungslogik abgegrenzt.

## Beispiele

Ein berechtigter Mitarbeiter bereitet den beschriebenen Vorgang vor und prüft seine Auswahl. Ein zweiter Kontakt erhält dadurch keine zusätzlichen Rechte; ein später geänderter Quellstand wird nicht still als ursprüngliche Grundlage dargestellt.

## Umsetzung in TaxTronik

Personenbezogene Fachdaten gehören zum privaten Workflowbestand des bestehenden Löschkonzepts. Verbundene Requests sind gemäß DSGVO-OPERATIONAL-RETENTION-001 vom automatischen Request-Purge ausgenommen, bis der gesamte verbundene Fachvorgang in einem geprüften Löschprozess bewertet wird. Diese Regel begründet keine neue Aufbewahrungsdauer. Unveränderliche Evidenz enthält IDs und knappe Statusmerkmale, keine Nachrichtentexte. Vor einer produktiven Nutzung sind Datenbankmigration, negative Zugriffsprüfungen und organisatorische Zuständigkeiten abzunehmen.

## Bekannte Abweichungen und Grenzen

Es fehlt die produktionsnahe Abnahme der neuen Migration und ihrer RLS-Regeln mit getrennten Owner-/App-Verbindungen sowie die fachliche Freigabe. Die Funktion behauptet keine gesetzliche Aufbewahrungsdauer und keinen Beweis der Vertretungsmacht.

## Fachliche Prüffragen

Wer ist für die Auswahl und Sichtung verantwortlich? Welche fachlichen Vorlagen dürfen eingesetzt werden? Wie werden abgebrochene oder falsch adressierte Vorgänge organisatorisch korrigiert? Welche Einzelfallgründe beeinflussen die Löschung?

## Technische Nachweise

Die referenzierten Unit- und Regressionstests prüfen den abgegrenzten technischen Umfang. Datenbanktests benötigen eine getrennte Owner- und App-Verbindung und sind ohne diese Umgebung als übersprungen auszuweisen. Eine Testdefinition ersetzt weder ihren erfolgreichen Datenbanklauf noch eine fachliche Freigabe.
