---
id: WORKFLOW-LIFECYCLE-001
title: Workflow-Abschluss aus erledigten Schritten atomar ableiten und explizite Pausen erhalten
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
    Technischer Abschluss und Wiederöffnung sind für manuelle, externe und
    datenbankseitige Schritterledigungen serialisiert. Fachliche Freigabe und
    produktionsnahe organisatorische Abnahme stehen aus.
sources:
  - kind: product_documentation
    citation: Workflow-Erweiterungen und Abschlussgrenzen
    path: docs/development/module/workflow-expansion.md
    checked_at: '2026-09-06'
    primary: true
code_refs:
  - packages/db/src/workflow-lifecycle.ts
  - packages/db/src/workflow-feedback.ts
  - packages/db/prisma/migrations/20260906170251_workflow_lifecycle/migration.sql
  - apps/web/src/server/workflows/execute-step.ts
  - apps/web/src/server/workflows/auto-resume.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/workflows/actions.ts
  - apps/web/src/app/staff/(protected)/interactions/actions.ts
  - apps/worker/src/jobs/workflow-feedback.ts
test_refs:
  - apps/web/src/app/staff/(protected)/interactions/__tests__/feedback-configure.test.ts
  - packages/db/src/__tests__/workflow-lifecycle.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/workflows/__tests__/actions-lifecycle.test.ts
  - apps/web/src/server/workflows/__tests__/execute-step.test.ts
  - apps/web/src/server/workflows/__tests__/auto-resume.test.ts
feature_refs:
  - FEATURES.md
  - docs/development/module/workflow-expansion.md
related_rules:
  - CLIENT-FEEDBACK-001
  - WORKFLOW-DEPENDENCY-001
  - REQ-LIFECYCLE-001
tags:
  - workflow
  - parallelitaet
  - ungeprueft
---

# WORKFLOW-LIFECYCLE-001 — Workflow-Abschluss aus erledigten Schritten atomar ableiten und explizite Pausen erhalten

## Kurzfassung

Ein aktiver Workflow mit mindestens einem Schritt wird genau dann technisch abgeschlossen, wenn sämtliche vorhandenen Schritte erledigt sind. Der Abschluss betrifft den Arbeitsvorgang und trifft keine Aussage zur materiellen Vollständigkeit, Rechtsfrist oder fachlichen Freigabe.

## Wann gilt die Regel?

Für bestehende Workflows, manuelle Erledigungen, E-Mail-/n8n-Handoffs sowie die bereits definierten automatischen Schritterledigungen bei Anforderungsabschluss und Formularabgabe. Datenbanktrigger gelten unabhängig vom aufrufenden Prozess.

## Benötigte Angaben

Aktueller Workflowstatus, sämtliche zugehörigen Schritte und deren Erledigungsstand; bei manuellen Änderungen aktueller Kanzleizugriff. Feedback benötigt zusätzlich die Voraussetzungen aus CLIENT-FEEDBACK-001.

## Entscheidungslogik

- Änderungen sperren den einzelnen Schritt und anschließend dessen Instanz. Der gemeinsame Instanzlock serialisiert parallele Änderungen verschiedener Schritte; der Abschluss berücksichtigt die danach sichtbaren übrigen Schritte.
- Ein aktiver nichtleerer Workflow ohne offenen Schritt erhält COMPLETED und einen technischen Abschlusszeitpunkt. Ein abgeschlossener Workflow mit wieder offenem Schritt wird ACTIVE und verliert den Abschlusszeitpunkt. Leere Workflows werden nicht automatisch abgeschlossen.
- Manuelle Erledigung, Wiederöffnung und das Starten einer automatisierten Aktion sind bei PAUSED oder CANCELLED gesperrt. Ein alter Browserstand kann den aktuellen Status nicht überschreiben. Fehlgeschlagene manuelle Änderungen werden in der Oberfläche angezeigt und der optimistische Haken zurückgenommen.
- Bereits angestoßene externe Handlungen und tatsächliche Anforderungs-/Formularantworten dürfen ihren Schritt nachträglich erledigen. Eine bestehende Pause oder ein Abbruch bleibt dabei erhalten. Erst ausdrückliches Fortsetzen beziehungsweise Wiederherstellen bewertet die inzwischen eingegangenen Erledigungen erneut.
- Zeitgesteuertes Fortsetzen verlangt beim Schreiben weiterhin PAUSED und einen erreichten Pausentermin. Eine parallele Verlängerung oder ein Abbruch wird weder überschrieben noch als erfolgreicher Resume auditiert. Die Evidence beim Fortsetzen oder Wiederherstellen enthält den tatsächlichen Endstatus nach der Schritterledigungsprüfung, also gegebenenfalls bereits COMPLETED.
- Ein neuer technischer Abschluss mit vorgemerktem Kontakt und aktiviertem Feedback schreibt atomar eine dauerhafte Verarbeitungsmarkierung. Web oder Worker verarbeiten Einladung, Prüfungen, Evidence und Abschlussmarkierung gemeinsam. Doppelte Läufe oder erneute Schritterledigung erzeugen keine zweite Einladung für denselben Meilenstein.
- Die Feedback-Kontaktauswahl sperrt ausschließlich die Instanz und liest deren Status danach erneut. Ein paralleler letzter Schritt kann deshalb weder eine Auswahl übersehen noch deren Einladung durch einen veralteten ACTIVE-Stand verhindern. Die Auswahl verändert keine Schritte und hält die Sperrreihenfolge der Schritterledigung ein.

## Ausnahmen und Grenzfälle

Ein bereits bestätigter externer Versand kann durch einen anschließend abgebrochenen Workflow nicht rückgängig gemacht werden. Sein Erledigungsnachweis bleibt erhalten, ohne den Abbruch umzudeuten. Bereits inkonsistente historische Instanzen werden durch die Migration nicht rückwirkend als abgeschlossen freigegeben; bei einer nachfolgenden ausdrücklichen Schrittänderung wird der aktuelle Stand neu bewertet. Historische Feedbackeinladungen werden nicht nachträglich versandt.

## Beispiele

Zwei Mitarbeiter erledigen gleichzeitig die letzten zwei Schritte. Nach beiden Transaktionen ist die Instanz abgeschlossen. Eine während eines pausierten Workflows eingereichte Portalantwort erledigt den zugehörigen Schritt; die Instanz bleibt pausiert, bis sie ausdrücklich fortgesetzt wird.

## Umsetzung in TaxTronik

Die Forward-Migration installiert gemeinsame Sperr- und Reconcile-Trigger. Der Webadapter verwendet dieselbe Sperrreihenfolge für das atomare Statusgate. Die gespeicherten Felder feedbackPendingAt und feedbackProcessedAt bilden eine begrenzte interne Dispatch-Queue; der minütliche Worker revalidiert Kontakt, Mandat, Modul und aktuellen Zugriff des Workflow-Erstellers. Technische Fehler bleiben mit verzögertem erneutem Versuch offen, ohne spätere Vorgänge dauerhaft zu blockieren.

## Bekannte Abweichungen und Grenzen

Historische Instanzen mit bereits vollständig erledigten Schritten und weiterhin ACTIVE werden durch diese Migration nicht rückwirkend repariert. Ohne eine nachfolgende Schrittänderung oder ein ausdrückliches Fortsetzen bleibt deren bisheriger Status bestehen; eine Bestandsbereinigung und die organisatorische Prüfung dieser Altvorgänge stehen aus.

Keine fachliche Freigabe. Der technische Abschluss ersetzt keine Kanzleiprüfung, Fristenkontrolle oder rechtliche Wirksamkeitsprüfung. Ein physischer SMTP-/n8n-Handoff bleibt von der späteren lokalen Speicherung und einer zwischenzeitlichen organisatorischen Entscheidung zu unterscheiden.

## Fachliche Prüffragen

Welche Schritte bilden den beabsichtigten Arbeitsvorgang vollständig ab? Welche Kontrollen müssen vor manueller Erledigung erfolgen? Welche Zuständigkeit überwacht Antworten während einer Pause und entscheidet über Fortsetzen oder Abbruch?

## Technische Nachweise

Die referenzierten PostgreSQL-Tests mit getrenntem Owner-/App-Zugang prüfen parallele letzte Schritte, Abbruchgrenzen, Request- und Portal-Formulartrigger, Fortsetzen sowie Feedback-Idempotenz, Mindestabstand und Rollback bei Evidence-Fehlern. Unit-Tests prüfen manuelle Statusgates und Resume-CAS. Diese Nachweise sind keine fachliche Freigabe.
