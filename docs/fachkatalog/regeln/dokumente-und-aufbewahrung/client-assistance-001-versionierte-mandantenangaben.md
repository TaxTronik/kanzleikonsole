---
id: CLIENT-ASSISTANCE-001
title: Mandantenangaben und externe Word-Fassungen getrennt dokumentieren
domain: dokumente-und-aufbewahrung
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Belegprüfung und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Angaben, Vorlagenstände, Prüfung und Ausgaben sind versioniert und technisch
    gebunden. Steuerliche Anerkennung, Vollständigkeit und gelebte Verfahren
    werden nicht automatisch entschieden.
sources:
  - kind: product_documentation
    citation: Modulbeschreibung Belegassistenten und mandantenbezogene Verfahrensdokumentation
    path: docs/development/module/client-assistance.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - apps/web/src/server/client-assistance/service.ts
  - apps/web/src/server/client-assistance/snapshot.ts
  - apps/web/src/server/client-assistance/outputs.ts
  - apps/web/src/server/client-assistance/download.ts
  - apps/web/src/server/client-assistance/report.ts
  - apps/web/src/server/documents/pdf-fonts.ts
  - packages/db/prisma/migrations/20260831140000_client_assistance/migration.sql
  - packages/db/prisma/migrations/20260831170000_assistance_outputs/migration.sql
test_refs:
  - apps/web/src/server/client-assistance/__tests__/snapshot.test.ts
  - apps/web/src/server/client-assistance/__tests__/service.test.ts
  - apps/web/src/server/client-assistance/__tests__/outputs.test.ts
  - apps/web/src/server/documents/__tests__/pdf-fonts.test.ts
  - packages/db/src/__tests__/mandate-assistance-expansion.test.ts
feature_refs:
  - docs/development/module/client-assistance.md
related_rules:
  - DOC-UPLOAD-JOURNAL-001
  - DOC-RETENTION-CLASS-001
  - DOC-PORTAL-SHARING-001
  - GOBD-VERFAHRENSDOKU-001
tags:
  - eigenbeleg
  - bewirtung
  - verfahrensdokumentation
  - menschliche-pruefung
---

# CLIENT-ASSISTANCE-001 — Mandantenangaben und externe Word-Fassungen getrennt dokumentieren

## Kurzfassung

Assistenten dokumentieren Tatsachenangaben für Bewirtungsergänzungen, Eigenbelege und Mandantenverfahren. Einreichung, Kanzleiprüfung, Archivierung und externe Word-Bearbeitung bleiben getrennt. Keine technische Handlung stellt automatisch steuerliche Anerkennung, Vorsteuerabzug oder GoBD-Konformität fest.

## Wann gilt die Regel?

Für Staff und Portal in `expenseAssistance` und `clientProcedures`. Die Regel ersetzt weder inhaltliche Belegprüfung noch den getrennten installationsbezogenen IST-Baustein.

## Benötigte Angaben

Aktives Mandat, bestätigte Tatsachen, gespeicherte Felddefinition; bei Bewirtung eine fest gebundene geprüfte Originalfassung; bei Kanzleiprüfung ein Vermerk; bei Word-Reimport eine geprüfte DOCX desselben Mandanten. Jede Ausgabe benötigt konkrete Revision, Format und Freigabeentscheidung.

## Entscheidungslogik

- Entwürfe dürfen unvollständig bleiben. Einreichung benötigt Pflichtangaben der gespeicherten Vorlage und Bestätigung.
- Eingereichte/geprüfte Antworten werden nicht überschrieben. Korrekturen und Entscheidungen schreiben weitere Revisionen.
- Der Snapshot bindet Vorlage, Antworten, Original-/Word-Fassung, Vermerk, Bestätigung, Status und Zeit.
- Quellen müssen mandatsgebunden, sauber und verfügbar sein. GwG-, Personal-, private und Payroll-Dateien dürfen nicht in allgemeine Assistentenausgaben überführt werden.
- Word-Reimport verlangt erneute Prüfung und übernimmt keine alte Prüfentscheidung. Automatische Textgewinnung überschreibt keine Strukturantworten.
- Ausgabeerzeugung ist eine ausdrückliche Schreibaktion aus fester Revision über das Uploadjournal. Wiederholung verwendet denselben Intent.
- Download liefert vorhandene Fassungen nach Zugriff, Quellenfreigabe, Größen-/Hashvergleich. Original, Ergänzung und Manifest bleiben unterscheidbar.
- PDF verwendet eingebettete geprüfte Unicode-Schriften. Nicht unterstützte Zeichen sperren die Ausgabe ausdrücklich; Namen werden nicht still ersetzt. DOCX bleibt eine eigenständige Dateiausgabe.

## Ausnahmen und Grenzfälle

Althistorie ohne vollständigen Snapshot gilt nicht nachträglich als vollständig belegt. Das PDF einer externen Word-Fassung ist nur das gekennzeichnete Prüfprotokoll; allgemeine Word-Konvertierung ist nicht implementiert. Entzogene Freigaben sperren Portalabrufe trotz früherer Erzeugung.

## Beispiele

### Normalfall

Ein Portal-Kontakt ergänzt Teilnehmer und Anlass zu einem freigegebenen Bewirtungsbeleg und bestätigt die Einreichung. Die Kanzlei prüft diese Revision und legt die Ergänzung ab. Der Originalbeleg bleibt unverändert.

### Grenzfall

Extern bearbeitetes Word wird als neue eingereichte Fassung mit Dateihash übernommen. Alte Prüfentscheidungen gelten nicht automatisch weiter; alte Formularantworten werden nicht als neuer Word-Inhalt dargestellt.

## Umsetzung in TaxTronik

`ClientAssistanceCase`, `ClientAssistanceRevision` und `ClientAssistanceOutput` verbinden aktuellen Zustand, append-only Historie und gespeicherte Ausgaben. Dokumentversions-Fremdschlüssel verhindern stille Neuzuordnung. RLS, Trigger und aktuelle Modul-/Mandatsguards ergänzen einander. Generator, Snapshot- und Quellenhash stehen im Manifest. Die technische 8-/10-Jahresklasse und der Anker am Revisionsjahr ersetzen keine individuelle Aufbewahrungsentscheidung.

## Bekannte Abweichungen und Grenzen

Begrenzte Dokumentationshilfe: fehlende Nachweise, materielle Anerkennung, gelebte Kontrollen, vollständige Verfahren, individuelle Retention und Berufsträgerqualifikation werden nicht automatisch festgestellt. Keine allgemeine Lösch-/Legal-Hold-Engine, automatische Buchung oder Versand.

## Fachliche Prüffragen

Reichen Angaben und Originale im Einzelfall? Welche Kontrollen und Nachweise fehlen? Entspricht die dokumentierte Fassung dem gelebten Verfahren? Wer darf fachlich prüfen, freigeben und wie lange aufbewahren?

## Technische Nachweise

Tests mit `Fachkatalog: CLIENT-ASSISTANCE-001` prüfen gefrorene Vorlagen, vollständige Snapshots, Word-Revisionen, erneute Prüfung, Zugriff, identische PDF-/DOCX-Recoverybytes, konkrete Store-Versionen und Byteintegrität. Tests sind keine fachliche Freigabe.
