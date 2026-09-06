---
id: CLIENT-FEEDBACK-001
title: Freiwillige Service-Rückmeldungen begrenzt und persönlich einholen
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
  - packages/db/src/workflow-feedback.ts
  - packages/db/src/workflow-lifecycle.ts
  - packages/db/prisma/migrations/20260906170251_workflow_lifecycle/migration.sql
  - apps/worker/src/jobs/workflow-feedback.ts
  - apps/web/src/server/workflows/interactions.ts
  - apps/web/src/server/workflows/interaction-policy.ts
  - apps/web/src/server/workflows/dashboard-policy.ts
  - apps/web/src/app/staff/(protected)/interactions/page.tsx
  - apps/web/src/app/staff/(protected)/interactions/actions.ts
  - apps/web/src/app/portal/(protected)/interactions/actions.ts
  - packages/db/prisma/migrations/20260831110000_workflow_expansion/migration.sql
test_refs:
  - apps/web/src/app/staff/(protected)/interactions/__tests__/feedback-configure.test.ts
  - packages/db/src/__tests__/workflow-lifecycle.test.ts
  - apps/web/src/server/workflows/__tests__/interaction-policy.test.ts
  - apps/web/src/server/workflows/__tests__/dashboard-policy.test.ts
  - packages/db/src/__tests__/workflow-expansion.test.ts
feature_refs:
  - docs/development/module/workflow-expansion.md
related_rules:
  - WORKFLOW-LIFECYCLE-001
  - ACCESS-NOTIFICATION-RECIPIENT-001
  - REQ-LIFECYCLE-001
  - DSGVO-MANDATE-ANONYMIZATION-001
tags:
  - workflow
  - mandantenportal
  - ungeprueft
---

# CLIENT-FEEDBACK-001 — Freiwillige Service-Rückmeldungen begrenzt und persönlich einholen

## Kurzfassung

Bei aktiviertem feedbackSurveys kann eine berechtigte Kanzleiperson einen aktiven Mandantenkontakt für einen Workflow auswählen. Ein abgeschlossener Workflow erzeugt die Einladung sofort; bei ACTIVE oder PAUSED wird der Kontakt für den bestehenden Abschlussübergang vorgemerkt.

## Wann gilt die Regel?

Für den beschriebenen neuen Vorgang innerhalb eines Tenants bei aktivierten Modulen und aktuellem Mandantenzugriff.

## Benötigte Angaben

Aktueller Akteur, gebundener Fachvorgang, geprüfte Auswahl und der in der Entscheidungslogik beschriebene Vorlagen- beziehungsweise Quellstand.

## Entscheidungslogik

Pro Mandant müssen zwischen Einladungen mindestens 90 mal 24 Stunden liegen; pro Workflow-Meilenstein ist höchstens eine Einladung möglich, auch nach Widerruf. Der Clientlock serialisiert parallele Versuche. Ein automatischer Abschluss überspringt einen zu kurzen Abstand oder einen inzwischen inaktiven Kontakt, statt den Workflowabschluss zu verhindern.

Kontaktauswahl und Workflowabschluss werden zusätzlich über dieselbe Instanzsperre serialisiert. Der Status wird erst nach Erwerb der Sperre gelesen: Gewinnt die Auswahl, sieht der nachfolgende Abschluss den vorgemerkten Kontakt; gewinnt der Abschluss, erstellt die Auswahl unmittelbar die Einladung unter den übrigen Voraussetzungen. Eine erfolgreiche Kontaktauswahl darf nicht zwischen Abschlussprüfung und Verarbeitungsmarkierung verloren gehen.

Nur der festgelegte Kontakt sieht und beantwortet die freiwillige Einladung einmal innerhalb des technischen Antwortfensters von 30 Tagen. Er kann einen bis fünf Sterne und optional eine Nachricht hinterlassen. Das Angebot ist ausdrücklich nicht anonym. Ein bis zwei Sterne erzeugen einen gezielten Hinweis an aktuell berechtigte Hauptbearbeiter, hilfsweise Ersteller oder ADMIN/PARTNER. Andere Bewertungen werden in der Übersicht sichtbar, ohne automatische Alarmierung.

Die Anforderung besitzt keinen Reminder-Zieltermin. Es gibt keine automatischen Mahnungen, keinen E-Mail-Versand und keine Veröffentlichung. Die Auswertung zählt nur aktuell zugängliche Einladungen und ist kein repräsentativer Zufriedenheitsnachweis. Ein Monatsverlauf zeigt die letzten zwölf Berliner Kalendermonate bis zum angegebenen Auswertungszeitpunkt: Durchschnitt gültiger Bewertungen und Rücklauf als Antworten geteilt durch Einladungen desselben Einladungsmonats. Spätere Antworten zählen zu ihrem Einladungsmonat. Der Nenner umfasst auch später zurückgezogene Einladungen. Ohne Einladungen beziehungsweise Bewertungen wird kein Durchschnitt oder Prozentsatz erfunden. Junge Monate sind wegen des noch laufenden Antwortfensters nicht mit ausgereiften Zeiträumen gleichzusetzen. Bei mehr als 5.000 zugänglichen Einladungen wird nur der ausdrücklich ausgewiesene jüngste Ausschnitt ausgewertet; alle Nenner beziehen sich dann auf diesen Ausschnitt. Die technische Antwortfrist und der 90-Tage-Abstand sind Produktregeln, keine gesetzlichen Aufbewahrungsfristen.

## Ausnahmen und Grenzfälle

Fehlender Zugriff, ungültiger oder veränderter Quellstand und geschlossene Vorgänge werden fail-closed behandelt. Die konkrete Legacy- und Korrekturbehandlung ist in der Entscheidungslogik abgegrenzt.

## Beispiele

Ein berechtigter Mitarbeiter bereitet den beschriebenen Vorgang vor und prüft seine Auswahl. Ein zweiter Kontakt erhält dadurch keine zusätzlichen Rechte; ein später geänderter Quellstand wird nicht still als ursprüngliche Grundlage dargestellt.

## Umsetzung in TaxTronik

WORKFLOW-LIFECYCLE-001 bindet sämtliche neuen Abschlusswege an dieselbe Datenbankentscheidung. Bei aktiviertem Feedback und vorgemerktem Kontakt schreibt der Abschluss eine dauerhafte Verarbeitungsmarkierung. Der manuelle Webpfad verarbeitet sie unmittelbar, der minütliche Worker übernimmt insbesondere E-Mail-/n8n- und Request-/Formularabschlüsse. Beide verwenden denselben Service und dieselben Sperren. Der Worker prüft zusätzlich den aktuellen Zugriff des Workflow-Erstellers; bei fehlendem Zugriff, inaktivem Mandat/Kontakt, deaktiviertem Modul oder unterschrittenem Mindestabstand wird ohne Einladung abgeschlossen. Technische Fehler bleiben mit verzögertem Wiederholungsversuch offen. Einladung, Evidence und Verarbeitungsmarkierung sind atomar. Bestehende historische Abschlüsse erhalten durch die Migration keine nachträglichen Einladungen.

Personenbezogene Fachdaten gehören zum privaten Workflowbestand des bestehenden Löschkonzepts. Verbundene Requests sind gemäß DSGVO-OPERATIONAL-RETENTION-001 vom automatischen Request-Purge ausgenommen, bis der gesamte verbundene Fachvorgang in einem geprüften Löschprozess bewertet wird. Diese Regel begründet keine neue Aufbewahrungsdauer. Unveränderliche Evidenz enthält IDs und knappe Statusmerkmale, keine Nachrichtentexte. Vor einer produktiven Nutzung sind Datenbankmigration, negative Zugriffsprüfungen und organisatorische Zuständigkeiten abzunehmen.

## Bekannte Abweichungen und Grenzen

Es fehlt die produktionsnahe Abnahme der neuen Migration und ihrer RLS-Regeln mit getrennten Owner-/App-Verbindungen sowie die fachliche Freigabe. Die Funktion behauptet keine gesetzliche Aufbewahrungsdauer und keinen Beweis der Vertretungsmacht.

## Fachliche Prüffragen

Wer ist für die Auswahl und Sichtung verantwortlich? Welche fachlichen Vorlagen dürfen eingesetzt werden? Wie werden abgebrochene oder falsch adressierte Vorgänge organisatorisch korrigiert? Welche Einzelfallgründe beeinflussen die Löschung?

## Technische Nachweise

Die referenzierten Unit- und Regressionstests prüfen den abgegrenzten technischen Umfang. Datenbanktests benötigen eine getrennte Owner- und App-Verbindung und sind ohne diese Umgebung als übersprungen auszuweisen. Eine Testdefinition ersetzt weder ihren erfolgreichen Datenbanklauf noch eine fachliche Freigabe.
