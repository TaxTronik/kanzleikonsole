---
id: TAX-NOTICE-DECISION-001
title: Bescheid-Rückmeldungen an Kontakt und Dokumentstand binden
domain: fristen-und-bescheide
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
  - apps/web/src/app/portal/(protected)/requests/[id]/page.tsx
  - apps/web/src/app/staff/(protected)/interactions/actions.ts
  - apps/web/src/app/portal/(protected)/interactions/actions.ts
  - apps/web/src/app/api/portal/interactions/[id]/document/route.ts
  - packages/db/prisma/migrations/20260831110000_workflow_expansion/migration.sql
test_refs:
  - apps/web/src/server/workflows/__tests__/interaction-policy.test.ts
  - packages/db/src/__tests__/workflow-expansion.test.ts
feature_refs:
  - docs/development/module/workflow-expansion.md
related_rules:
  - TAX-NOTICE-APPEAL-001
  - TAX-CONTROL-STATUS-001
  - DOC-PORTAL-SHARING-001
  - ACCESS-NOTIFICATION-RECIPIENT-001
  - REQ-LIFECYCLE-001
tags:
  - workflow
  - mandantenportal
  - ungeprueft
---

# TAX-NOTICE-DECISION-001 — Bescheid-Rückmeldungen an Kontakt und Dokumentstand binden

## Kurzfassung

Eine berechtigte Kanzleiperson erstellt zu einem GEPRUEFT-Bescheid mit berechnetem Fristvorschlag ohne offenen manuellen Prüfbedarf eine persönliche Rückfrage. Erforderlich sind eine Erklärung, ein aktiver Mandantenkontakt, eine bereits geteilte saubere Dokumentfassung und eine künftige Antwortfrist, die den gespeicherten Einspruchsfristtag nicht überschreitet.

## Wann gilt die Regel?

Für den beschriebenen neuen Vorgang innerhalb eines Tenants bei aktivierten Modulen und aktuellem Mandantenzugriff.

## Benötigte Angaben

Aktueller Akteur, gebundener Fachvorgang, geprüfte Auswahl und der in der Entscheidungslogik beschriebene Vorlagen- beziehungsweise Quellstand.

## Entscheidungslogik

Der unveränderliche Stand enthält Bescheidänderungszeit, Erklärung, Betrag, Fristvorschlag sowie Dokument- und Versions-ID mit SHA-256. Der Download liefert genau diese gespeicherte Storage-Version mit Hashprüfung. Die normale Portalanforderung verweist auf die gesonderte Kontaktansicht; andere Kontakte desselben Mandats erhalten weder die persönliche Rückfrage noch ein Antwortrecht.

Der gewählte Kontakt kann einmal „Einspruch beauftragen“ oder „Keine Einwände“ sowie eine Nachricht übermitteln. Status, Frist, Kontakt, offener Request und aktueller Bescheid-/Dokumentstand werden bei Abgabe erneut geprüft. Geänderter Bescheid oder neuere Dokumentfassung erfordert Widerruf und eine neue Rückfrage. Bereits abgegebene Antworten bleiben unverändert; eine weitere Rückfrage erhält eine neue Revision.

Die Kanzlei erhält einen gezielten, inhaltsarmen Hinweis und kann die Antwort als gesichtet markieren. Weder Antwort noch Sichtung setzen den Bescheidstatus, einen Einspruch, Bestandskraft oder eine gesetzliche Frist automatisch fort oder auf erledigt. „Keine Einwände“ wird nicht als Rechtsbehelfsverzicht interpretiert. Das Portal belegt auch keine Vertretungsmacht, Kenntnisnahme oder tatsächliche Rechtsbehelfseinlegung.

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
