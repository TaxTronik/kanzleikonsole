---
id: PAYROLL-INTAKE-001
title: Personalfragebogen mit getrennten Angaben und gesperrtem DATEV-Importgate
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Lohn und Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Getrennte Erfassung, private Revisionen, Lohnanlagen und Prüfexporte sind implementiert.
    DATEV-Import ist mangels installierter Feldspezifikation und realer Importprobe gesperrt.
    Fachliche Freigabe und produktionsnahe Bedienabnahme stehen aus.
sources:
  - kind: product_documentation
    citation: Personalfragebogen mit getrennten Zugängen und Abnahmegrenzen
    path: docs/development/module/payroll-intake.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - apps/web/src/server/payroll/definition.ts
  - apps/web/src/server/payroll/capability.ts
  - apps/web/src/server/payroll/service.ts
  - apps/web/src/server/payroll/storage.ts
  - apps/web/src/server/payroll/export.ts
  - apps/web/src/server/payroll/pdf.ts
  - apps/web/src/server/documents/pdf-fonts.ts
  - apps/web/src/server/payroll/download.ts
  - apps/web/src/app/staff/(protected)/payroll/actions.ts
  - apps/web/src/app/portal/(protected)/payroll/actions.ts
  - apps/web/src/app/payroll/employee/actions.ts
  - packages/db/prisma/migrations/20260831160000_payroll_intake/migration.sql
  - packages/db/prisma/migrations/20260831210000_payroll_intake_guards/migration.sql
  - packages/db/prisma/migrations/20260831220000_payroll_external_evidence/migration.sql
  - packages/db/prisma/migrations/20260831230000_payroll_submission_guards/migration.sql
  - packages/db/prisma/migrations/20260831240000_payroll_pending_sources/migration.sql
test_refs:
  - apps/web/src/server/payroll/__tests__/definition.test.ts
  - apps/web/src/server/payroll/__tests__/pdf.test.ts
  - apps/web/src/server/payroll/__tests__/storage.test.ts
  - apps/web/src/server/payroll/__tests__/export.test.ts
  - apps/web/src/server/payroll/__tests__/capability.test.ts
  - apps/web/src/server/documents/__tests__/pdf-fonts.test.ts
  - packages/db/src/__tests__/payroll-intake.test.ts
feature_refs:
  - docs/development/module/payroll-intake.md
related_rules:
  - DOC-UPLOAD-JOURNAL-001
  - DOC-VERSION-IMMUTABILITY-001
  - DOC-PORTAL-SHARING-001
  - DOC-RETENTION-CLASS-001
  - FORM-PRESUBMIT-UPLOAD-001
tags:
  - lohn
  - mandantenportal
  - datenschutz
  - ungeprueft
---

# PAYROLL-INTAKE-001 — Personalfragebogen mit getrennten Angaben und gesperrtem DATEV-Importgate

## Kurzfassung

Ein standardmäßig deaktiviertes Modul bereitet einzelne Mitarbeiterneuanlagen für DATEV Lohn und Gehalt vor. Arbeitgeber und Arbeitnehmer geben getrennte Daten ab; nur berechtigte Lohnbearbeiter sehen den vollständigen Prüfstand. Das DATEV-Importgate bleibt mangels konkreter Formatspezifikation und realer Importprobe gesperrt.

## Wann gilt die Regel?

Für neu angelegte Personalvorgänge bei aktiviertem `payrollIntake`, aktivem Mandat und aktuellem Akteurszugriff. Der Arbeitnehmerlink gilt ausschließlich für den einen Vorgang, niemals für das Mandantenportal allgemein.

## Benötigte Angaben

Mandat, ausdrücklich berechtigter Arbeitgeberkontakt, Beschäftigtenbezeichnung, Zugriffsende und eingefrorener Formularstand. Der Arbeitgeber bestätigt Beschäftigung und Vergütung, der Arbeitnehmer seine eigenen Stammdaten. Berater-, Mandanten- und Personalnummer verlangen einen dokumentierten Abgleich mit dem Zielbestand. Nicht vergebene persönliche Nummern sind ausdrücklich auswählbar.

## Entscheidungslogik

`DRAFT` und `RETURNED` erlauben Änderungen am jeweils eigenen Bereich. Abgaben und Änderungen verlangen die aktuelle Revision. `SUBMITTED` verlangt beide Bestätigungen; `REVIEWED` zusätzlich die Kanzleiprüfung. Eine Rückgabe verlangt beide Bestätigungen erneut. Änderungen bestätigter DATEV-Zuordnungen oder externer Nachweise erzeugen eine neue private Revision und heben eine bestehende Kanzleiprüfung auf.

Arbeitgeberrechte sind durch aktive vorgangsbezogene Kontaktfreigaben beschränkt. Arbeitnehmer erhalten einen einmaligen, gehashten Zugangsschlüssel und eine separate kurze Session. Jede Operation prüft Session, Einladung, Ablauf, Widerruf, Mandat und Modul neu. Neue Einladungen sperren alte Einladungen und deren Sessions. Gastzugriffe verwenden ausschließlich eng begrenzte Datenbankfunktionen in leerem Kontext; sie erhalten keine allgemeinen Tenant- oder Mandantenrechte.

Anlagen haben eigene Lohnrechte und ein persistentes Uploadjournal. Quellen sind nach Abschluss unveränderlich. PDF und ZIP binden den geprüften Revisionsstand und die exakten Anlagenversionen; erfolgreiche DATEV-Importe können nicht vorgespiegelt werden. Sofortmeldung bleibt eine getrennte externe Aufgabe mit revisionsgebundener Dokumentation, ohne automatische Übermittlung oder Fristerledigung.

## Ausnahmen und Grenzfälle

Ein abgelaufener, widerrufener, deaktivierter oder beendeter Vorgang sperrt Gastoperationen unmittelbar. Ein abgefangener Link stellt bis zum Widerruf ein Risiko dar; er ist kein Identitätsnachweis. Die Kanzlei verantwortet sichere Zustellung. Der gemeinsame Rückgabevermerk darf keine vertraulichen Arbeitnehmerdetails enthalten. Veraltete Revisionen, unbekannte Felder und widersprüchliche Nummernangaben werden abgewiesen. Offene Uploadjournale müssen vor der jeweiligen Abgabe abgeschlossen werden.

## Beispiele

Ein ausgewählter Arbeitgeberkontakt bestätigt Arbeitsbeginn und Vergütung. Ein zweiter Kontakt desselben Mandanten sieht den Vorgang nicht. Die beschäftigte Person trägt über ihren Link IBAN und Versicherungsnummer ein; diese Antworten und Anlagen bleiben dem Arbeitgeber verborgen. Nach beiderseitiger Abgabe erzeugt die Kanzlei einen geprüften PDF-Stand. Trotz bestätigter DATEV-Nummern bleibt der DATEV-Import ohne reale Formatabnahme gesperrt.

## Umsetzung in TaxTronik

Die Oberflächen liegen unter `/staff/payroll`, `/portal/payroll` und `/payroll/employee`. Kanzleizugriff verlangt `PAYROLL_MANAGE`. Fachlich relevante Antworten, Bestätigungen, externe Nachweise und Quellen werden privat revisionsgebunden; technische Audit-Evidenz enthält keine Antworttexte oder persönlichen Nummern. Lohnanlagen sind keine allgemein sichtbaren Dokumente. Private Vorgangsbestände gehören zum bestehenden Löschkonzept, ohne erfundene gesetzliche Frist oder zusätzlichen Massenlöschlauf.

## Bekannte Abweichungen und Grenzen

Der DATEV-Import ist bewusst nicht implementiert. Die Anwendung ersetzt keine Lohnabrechnung, rechtliche Beschäftigungsbeurteilung, Sofortmeldung oder weitere elektronische Meldungen. Steuer-ID erhält nur eine ausgewiesene Formatprüfung; IBAN- und Versicherungsnummer-Prüfziffern beweisen keine Vergabe oder Kontoinhaberschaft. Die IBAN-Prüfung ist keine vollständige länderspezifische Registerprüfung. Fachliche Freigabe, Datenschutz-/Aufbewahrungsorganisation und produktionsnahe Bedienabnahme bleiben offen.

## Fachliche Prüffragen

Welche Felder und Nachweise sind für den konkreten Beschäftigungsfall erforderlich und zulässig? Wer bestätigt Arbeitgeberangaben und prüft externe Meldungen? Wie werden Links sicher zugestellt und falsche Adressierungen korrigiert? Welche Aufbewahrungs- und Löschgründe gelten für den gesamten privaten Vorgang? Welche installierte DATEV-Version und reale Importprobe erlauben später eine Formatabnahme?

## Technische Nachweise

Die referenzierten Tests prüfen Plausibilitätsgrenzen, Revisionsbindung, Arbeitgebertrennung, Gastisolation, einmalige Einlösung, Widerruf und das gesperrte DATEV-Gate. Datenbanktests benötigen getrennte Owner-/App-Verbindungen einer isolierten Testdatenbank; ein übersprungener Test ist kein erfolgreicher Nachweis. Storage- und Bedienabnahme sowie fachliche Freigabe sind davon getrennt zu dokumentieren.
