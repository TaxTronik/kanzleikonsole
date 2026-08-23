---
id: INV-LIFECYCLE-FREEZE-001
title: Rechnungsinhalt nach Verlassen des Entwurfs festschreiben
domain: rechnungen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Rechnungswesen
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: Geschäftliche Felder und Positionen sind nach dem Entwurfsstatus durch Datenbankregeln unveränderlich; Korrekturen laufen über Storno.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, Festschreibung
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-23'
    primary: true
  - kind: product_documentation
    citation: Benutzerhandbuch Rechnungen, Grundprinzipien
    path: docs/anwenderdoku/rechnungen.md
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - packages/db/prisma/migrations/20260801001000_iter85_invoice_gob/migration.sql
  - apps/web/src/app/staff/(protected)/invoices/actions.ts
  - apps/web/src/server/invoicing/number.ts
  - apps/web/src/server/invoicing/storno.ts
test_refs:
  - packages/db/src/__tests__/invoice-festschreibung.test.ts
  - apps/web/src/server/invoicing/__tests__/number.test.ts
  - apps/web/src/server/invoicing/__tests__/storno.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/rechnungen.md
  - docs/development/module/fakturierung.md
related_rules:
  - INV-ARCHIVE-EINVOICE-001
  - INV-PORTAL-SHARING-001
tags:
  - festschreibung
  - rechnung
  - storno
---

# INV-LIFECYCLE-FREEZE-001 — Rechnungsinhalt nach Verlassen des Entwurfs festschreiben

## Kurzfassung

Solange eine In-App-Rechnung Entwurf ist, dürfen ihre Geschäftsdaten technisch
geändert werden. Sobald sie den Entwurfsstatus verlässt, sind Nummer, Beträge,
Daten, Steuerangaben und Positionen unveränderlich. Eine fachliche Korrektur
erfolgt über den vorgesehenen Storno- und Neuausstellungsprozess, nicht durch
Überschreiben des Originalbelegs.

## Wann gilt die Regel?

Die Regel gilt für in TaxTronik geführte Rechnungen mit den Status `DRAFT`,
`SENT`, `PAID`, `OVERDUE` und `CANCELLED`. Sie beschreibt die technische
Festschreibung des Beleginhalts. Ob ein konkreter Korrekturbeleg steuerlich
ausreicht, bleibt eine fachliche Einzelfallfrage.

## Benötigte Angaben

- aktueller Rechnungsstatus
- gewünschte Statusänderung
- vollständiger Rechnungsinhalt einschließlich Positionen und Steuerangaben
- bei Korrektur Bezug zum Ursprungsbeleg
- Berechtigung für Verwaltung, Versand oder Storno

## Entscheidungslogik

| Ausgangslage                             | Zulässige Wirkung                                                    |
| ---------------------------------------- | -------------------------------------------------------------------- |
| Rechnung ist `DRAFT`                     | Geschäftsfelder und Positionen sind auf Datenbankebene noch änderbar |
| `DRAFT` soll versendet werden            | Archiv muss zuerst erfolgreich entstehen; danach Wechsel zu `SENT`   |
| Rechnung hat `DRAFT` verlassen           | Geschäftsfelder und Positionen weder ändern, ergänzen noch löschen   |
| Rechnung soll fachlich korrigiert werden | Storno-/Korrekturprozess und gegebenenfalls Neuausstellung verwenden |
| Rechnung ist `CANCELLED`                 | Endstatus; kein weiterer Statuswechsel                               |

## Ausnahmen und Grenzfälle

Lebenszyklusfelder wie Zahlung, Versandzeitpunkt und Archivverknüpfung dürfen
innerhalb der erlaubten Statusmatrix weiterhin geführt werden. Ein nie
versendeter Entwurf kann storniert werden, ohne einen bereits kommunizierten
Beleg zu behaupten. Extern erzeugte Rechnungen folgen bei der Erfassung einem
anderen Ablauf, behalten aber ihre hochgeladenen Originalbytes.

## Beispiele

### Normalfall

Eine Rechnung wird vollständig geprüft und versendet. Danach versucht ein
Administrator, den Betrag zu ändern. Die Datenbank weist die Änderung auch für
privilegierte Verbindungen zurück; die Korrektur muss über Storno erfolgen.

### Grenzfall

Eine bereits bezahlte Rechnung enthält einen fachlichen Fehler. Der Status
„bezahlt“ erlaubt keine Änderung des Originals. TaxTronik erzeugt den
Korrekturbeleg im Stornoprozess; eine tatsächliche Rückzahlung wird außerhalb
dieser Regel abgewickelt.

## Umsetzung in TaxTronik

Anwendungscode prüft die Statusmatrix und Berechtigungen. Datenbank-Trigger
sperren nach Verlassen von `DRAFT` die Geschäftsfelder, alle Positionen und das
Löschen des Belegs unabhängig vom Anwendungspfad. Der Storno-Helfer bildet
Korrekturpositionen mit Belegbezug.

## Bekannte Abweichungen und Grenzen

Innerhalb des beschriebenen Festschreibungs-Scopes sind keine technischen
Abweichungen bekannt. Die aktuelle Oberfläche bietet auch bei Entwürfen keine
freie nachträgliche Bearbeitung oder Löschung an, obwohl die Datenbank dies bis
zum Statuswechsel grundsätzlich zulässt. Die fachliche Ausgestaltung einzelner
Storno- und Rückzahlungsfälle ist noch nicht berufsträgerlich freigegeben.

## Fachliche Prüffragen

- Zu welchem fachlichen Zeitpunkt soll die Festschreibung erfolgen: Ausgabe,
  Versandmarkierung oder ein anderer nachweisbarer Moment?
- Welche Korrekturarten benötigen neben Storno und Neuausstellung eigene
  Belegtypen?
- Reicht der Umgang mit bezahlten Rechnungen und externen Rückzahlungen aus?
- Soll ein Entwurf vor Vergabe beziehungsweise Verbrauch einer Nummer löschbar
  sein, oder ist die bestehende Nachvollziehbarkeit gewollt?

## Technische Nachweise

Die Migration enthält die unveränderlichen Feldmengen und Statusmatrix als
Datenbank-Backstop. Der DB-Test greift Beträge, Daten, Positionen, Löschen und
privilegierte Verbindungen an; Anwendungs-Tests decken Matrix und
Korrekturpositionen ab.
