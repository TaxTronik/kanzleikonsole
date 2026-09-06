---
id: KNOWLEDGE-CONTEXT-001
title: Interne Kanzleileitfäden kontextbezogen anzeigen
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
  - apps/web/src/app/staff/(protected)/knowledge/context/actions.ts
  - apps/web/src/components/knowledge-context.tsx
  - apps/web/src/app/staff/(protected)/requests/[id]/page.tsx
  - apps/web/src/server/workflows/execute-step.ts
  - packages/db/prisma/migrations/20260831110000_workflow_expansion/migration.sql
test_refs:
  - apps/web/src/server/workflows/__tests__/execute-step.test.ts
feature_refs:
  - docs/development/module/workflow-expansion.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - REQ-INTERNAL-COMMENT-001
tags:
  - workflow
  - mandantenportal
  - ungeprueft
---

# KNOWLEDGE-CONTEXT-001 — Interne Kanzleileitfäden kontextbezogen anzeigen

## Kurzfassung

ADMIN/PARTNER verknüpft höchstens zehn veröffentlichte Wissensartikel mit einem Workflow-Schritt oder einer Anforderungsvorlage. Die neuen Funktionen verlangen knowledgeContext und knowledge; Workflowbezüge zusätzlich workflows. Alle Verweise müssen innerhalb desselben Tenants liegen.

## Wann gilt die Regel?

Für den beschriebenen neuen Vorgang innerhalb eines Tenants bei aktivierten Modulen und aktuellem Mandantenzugriff.

## Benötigte Angaben

Aktueller Akteur, gebundener Fachvorgang, geprüfte Auswahl und der in der Entscheidungslogik beschriebene Vorlagen- beziehungsweise Quellstand.

## Entscheidungslogik

Die Artikel-IDs werden beim Start in das WorkflowItem beziehungsweise bei der Anforderungsanlage in den Request übernommen. Spätere Vorlagenänderungen ändern die Auswahl laufender Vorgänge nicht. Die Artikeltexte bleiben hingegen bewusst aktuell: Nur weiterhin veröffentlichte Artikel werden bei einer ausdrücklichen Staff-Abfrage geladen, als bereinigtes Markdown gerendert und im Kontext geöffnet.

Portalansichten enthalten keine Leitfadeninhalte. Der Staff-Ladepfad prüft den aktuellen Mandantenzugriff. IDs können nach Entpublizieren bestehen bleiben; daraus entsteht kein Zugriff auf einen unveröffentlichten Text. Diese Funktion ist kein historisches Wiki-Versionierungsmodell und gibt keine fachliche Richtigkeit frei.

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
