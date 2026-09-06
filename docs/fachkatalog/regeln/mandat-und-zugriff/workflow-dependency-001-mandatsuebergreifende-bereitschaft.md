---
id: WORKFLOW-DEPENDENCY-001
title: Mandatsübergreifende Workflow-Bereitschaft aus ausdrücklich verbundenen Vorgängern anzeigen
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
    Die abgegrenzte Produktfunktion ist implementiert; eine fachliche Freigabe
    und weitergehende materielle oder externe Vollständigkeitszusagen fehlen.
sources:
  - kind: product_documentation
    citation: Modulbeschreibung Mandatsorganisation und Erweiterungsgrenzen
    path: docs/development/module/mandate-expansion.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - packages/db/prisma/migrations/20260906170251_workflow_lifecycle/migration.sql
  - apps/web/src/server/mandate-expansion/service.ts
  - apps/web/src/server/mandate-expansion/dependencies.ts
  - apps/web/src/app/staff/(protected)/mandate-expansion/dependencies/page.tsx
  - packages/db/prisma/migrations/20260831120000_mandate_expansion/migration.sql
  - packages/db/prisma/migrations/20260831270000_workflow_dependency_period/migration.sql
test_refs:
  - packages/db/src/__tests__/workflow-lifecycle.test.ts
  - apps/web/src/server/mandate-expansion/__tests__/model.test.ts
  - packages/db/src/__tests__/workflow-dependencies.test.ts
feature_refs:
  - docs/development/module/mandate-expansion.md
related_rules:
  - WORKFLOW-LIFECYCLE-001
  - ACCESS-CLIENT-MODE-001
  - REQ-LIFECYCLE-001
tags:
  - mandatsorganisation
  - arbeitsstand
  - menschliche-pruefung
---

# WORKFLOW-DEPENDENCY-001 — Mandatsübergreifende Workflow-Bereitschaft aus ausdrücklich verbundenen Vorgängern anzeigen

## Kurzfassung

Die Kanzlei kann Schritte verschiedener Mandanten ausdrücklich miteinander verbinden. Die Arbeitsübersicht zeigt einen abhängigen Schritt als bereit, wenn sämtliche dokumentierten Vorgänger erledigt und deren Vorgänge weder pausiert noch abgebrochen sind. Es werden keine Steuerfristen, Workflows oder Mandantenantworten automatisch abgeschlossen.

## Wann gilt die Regel?

Die Regel gilt im optionalen Modul `workflowDependencies`. Sie ist eine organisatorische Bereitschaftsanzeige und keine gesetzliche Frist- oder Bearbeitungssperre in sämtlichen Fachmodulen.

## Benötigte Angaben

Vorgänger- und Nachfolgerschritt mit bestehender Workflow- und Mandantenreferenz, ausdrücklich bestätigtes Veranlagungsjahr beider Vorgänge, Tenant und berechtigter Mitarbeiter.

## Entscheidungslogik

- Anlage und Entfernung prüfen Zugriff auf beide Mandanten.
- Verbindungen verlangen dasselbe ausdrücklich bestätigte Veranlagungsjahr. Bestehende Vorgänge bleiben ohne Bestätigung unzugeordnet; Namen und Erstellungsdatum begründen keinen historischen Jahresbezug. Vor einer Änderung des Jahres müssen vorhandene Verbindungen ausdrücklich entfernt werden.
- Selbstverknüpfungen, gleichmandatige Verbindungen und direkte oder mittelbare Zyklen werden abgewiesen.
- Alle dokumentierten Vorgänger müssen erledigt sein. Ein wieder geöffneter, pausierter oder abgebrochener Vorgänger hebt die Bereitschaftsanzeige beim erneuten Laden auf.
- Nicht zugängliche Vorgänger werden nicht aus der Bewertung weggelassen: der Nachfolger erhält keine positive Bereitschaftszusage. Namen oder Inhalte des fremden Vorgängers werden nicht ausgegeben.
- Ein hinzugefügter oder entfernter Zusammenhang wird auditiert; der fachliche Status beider Workflow-Schritte bleibt unverändert.
- Eine Wiederöffnung eines erledigten Vorgängerschritts erzeugt bei aktivem Modul eine interne Nachricht an den aktuell zugänglichen, aktiven Bearbeiter des Nachfolgers, hilfsweise dessen Workflow-Ersteller. Die Nachricht enthält weder Namen noch Kennungen des Vorgängers. Entfällt der Mandantenzugriff, wird kein neuer Hinweis erzeugt; alte Hinweise werden durch die vorhandene Empfänger-RLS unsichtbar.

## Ausnahmen und Grenzfälle

Der Zugriff auf einen Nachfolgeschritt beinhaltet keinen Zugriff auf dessen Vorgänger. Die Anzeige ist der aktuelle Stand beim Seitenabruf, kein dauerhaft gespeicherter Freigabesnapshot. Ein Schritt ohne Abhängigkeiten erhält durch dieses Modul keine zusätzliche Bereitschaftszusage.

## Beispiele

### Normalfall

Die berechtigte Kanzleiperson prüft den zugänglichen Arbeitsstand und protokolliert die ausdrücklich gewählte fachliche Handlung. Der aktuelle Stand und seine Nachweise bleiben getrennt erkennbar.

### Grenzfall

Der Arbeitsstand hat sich zwischen Anzeige und Bestätigung geändert oder ein erforderlicher Zugriff entfällt. Die Aktion bricht ab; die Person lädt neu und prüft erneut. Es wird keine Freigabe unterstellt.

## Umsetzung in TaxTronik

WORKFLOW-LIFECYCLE-001 vereinheitlicht die technische Schritterledigung. Parallele letzte Schritte und automatische Abschlüsse stimmen den Elternstatus atomar ab. Pausierte oder abgebrochene Vorgänger behalten ihre organisatorische Entscheidung auch bei einer verspäteten Quellantwort; die Bereitschaft wird dadurch nicht unbeabsichtigt positiv. Eine spätere ausdrückliche Wiederaufnahme bewertet den aktuellen Erledigungsstand erneut.

Eine normalisierte Kante referenziert beide bestehenden WorkflowItem-Datensätze. Tenant-RLS, Scope- und Perioden-Trigger sowie ein serialisierter Zykluscheck schützen die Beziehungen. Jahresbestätigungen werden mit erwartetem Altstand auditiert. Die Übersicht verlinkt auf die vorhandenen Workflow-Akten. Ein nicht öffentlich aufrufbarer DB-Trigger erkennt ausschließlich den Übergang von erledigt zu offen und erstellt einen generischen, an den Nachfolgermandanten gebundenen Hinweis. Modulaktivierung und Empfängerzugriff werden vor dem Insert erneut geprüft.

## Bekannte Abweichungen und Grenzen

Die bestehenden Bearbeitungsactions bleiben unverändert; die Abhängigkeit ist keine harte Ausführungssperre. Es gibt keine automatische fachliche Aussage, ob etwa eine Feststellung für eine Einkommensteuererklärung genügt. Ändert sich die zugrunde liegende fachliche Abhängigkeit, muss die Kanzlei sie ausdrücklich korrigieren.

## Fachliche Prüffragen

Welcher Vorgängerschritt dokumentiert tatsächlich die erforderliche Vorleistung? Muss ein konkreter Prozess über die Anzeige hinaus organisatorisch gesperrt werden?

## Technische Nachweise

Tests prüfen Zyklen, mehrere Vorgänger, pausierte/abgebrochene Vorgänge und fehlenden Zugriff auf einen Endpunkt. Echte PostgreSQL-Tests belegen fehlende beziehungsweise unterschiedliche Jahre, gesperrte nachträgliche Jahresänderungen, Wiederöffnungsnachrichten, Modulpausen und aktuellen Empfängerzugriff. Sie belegen keine steuerrechtliche Abhängigkeit.
