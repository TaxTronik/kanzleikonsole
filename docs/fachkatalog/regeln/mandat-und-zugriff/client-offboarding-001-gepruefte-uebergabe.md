---
id: CLIENT-OFFBOARDING-001
title: Mandatsübergabe vorbereiten und Mandatsende getrennt bestätigen
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
  - apps/web/src/server/mandate-expansion/offboarding.ts
  - apps/web/src/server/mandate-expansion/artifacts.ts
  - apps/web/src/server/mandate-expansion/pdf.ts
  - apps/web/src/server/documents/pdf-fonts.ts
  - packages/db/prisma/migrations/20260831120000_mandate_expansion/migration.sql
  - packages/db/prisma/migrations/20260831180000_mandate_artifacts/migration.sql
  - packages/db/prisma/migrations/20260831200000_mandate_history_integrity/migration.sql
test_refs:
  - apps/web/src/server/mandate-expansion/__tests__/model.test.ts
  - apps/web/src/server/mandate-expansion/__tests__/service.test.ts
  - apps/web/src/server/mandate-expansion/__tests__/pdf.test.ts
  - apps/web/src/server/mandate-expansion/__tests__/artifacts.test.ts
  - apps/web/src/server/documents/__tests__/pdf-fonts.test.ts
  - packages/db/src/__tests__/mandate-assistance-expansion.test.ts
feature_refs:
  - docs/development/module/mandate-expansion.md
related_rules:
  - CLIENT-MANDATE-LIFECYCLE-001
  - DOC-RETENTION-CLASS-001
  - GWG-RETENTION-DESTRUCTION-001
  - DSGVO-MANDATE-ANONYMIZATION-001
tags:
  - mandatsorganisation
  - arbeitsstand
  - menschliche-pruefung
---

# CLIENT-OFFBOARDING-001 — Mandatsübergabe vorbereiten und Mandatsende getrennt bestätigen

## Kurzfassung

ADMIN/PARTNER bereitet einen überprüfbaren Übergabeumfang vor und bestätigt das Mandatsende anschließend gesondert. Die Vorbereitung sammelt offene Steuertermine, Bescheid-/Einspruchskontrollen, Anforderungen, aktive Portal-Kontakte und nicht vernichtete GwG-Prüfungen. Der Abschluss setzt das tatsächliche Mandatsende und sperrt Portalzugänge über den aktuellen Mandatsstatus.

## Wann gilt die Regel?

Die Regel gilt für das optionale Modul `mandateOffboarding`. Sie ergänzt die bisherige einfache Mandatsende-Aktion um Vorbereitung und Protokoll; sie entscheidet nicht automatisch über die rechtliche Herausgabepflicht einzelner Unterlagen.

## Benötigte Angaben

Bestehendes Mandat, tatsächliches Enddatum bis zum heutigen Datum, bestätigter Empfänger mit eindeutiger Kontakt-/Zustellangabe, ausdrücklich ausgewählte Dokumentfassungen mit zusätzlicher Freigabe sensibler Fassungen, Übergabevermerk zu offenen Vorgängen, Aufbewahrungsvermerk einschließlich ungeklärter Einzelfälle sowie getrennte Bedienbestätigungen.

## Entscheidungslogik

- Nur ADMIN/PARTNER mit Mandantenzugriff kann vorbereiten oder abschließen.
- Die Auswahl umfasst saubere, verfügbare Dokumentfassungen desselben Mandanten. Portalsichtbarkeit ist keine Herausgabefreigabe und kein Auswahlkriterium. Jede Auswahl speichert eigene Freigabe, handelnde Person, Zeitpunkt und bestätigten Empfänger. GwG-, interne, private und Personalunterlagen benötigen zusätzlich eine ausdrückliche sensible Freigabe pro Fassung; Personalunterlagen verlangen außerdem PAYROLL_MANAGE.
- Ein Hash bindet die bei der Vorbereitung gelesene Arbeitsgrundlage. Hat sie sich vor Abschluss geändert, ist eine erneute Vorbereitung erforderlich.
- Der Abschluss bestätigt zusätzlich den in der Oberfläche angezeigten Freigabehash aus Empfänger, ausgewählten Fassungen, Einzelbestätigungen und Vermerken. Ein alter Browserstand darf keinen zwischenzeitlich geänderten Übergabeumfang beenden.
- Eine ausdrückliche Archivierungsaktion legt ein getrenntes PDF-Prüfprotokoll und ZIP-Teile nach Schutzklasse und Größenlimit ab. ZIPs enthalten exakt ausgewählte Originalfassungen und ihr Inhalts-/Hash-/Freigabeverzeichnis. PDF und Manifest binden Freigabestand und Generatorversion; Uploadjournal und konkrete Dokumentfassung binden die erzeugten Bytes. Größe und Hash geladener Originale werden geprüft.
- Personalteile und ein entsprechendes Protokoll bleiben zusätzlich payroll-geschützt. GwG-Kopien und ein GwG-enthaltendes Protokoll verwenden die GwG-Klasse und den vorhandenen Vernichtungspfad. Quelldokumente und deren Aufbewahrungsfristen bleiben unverändert. Keine Ausgabe wird pauschal über das Portal geteilt.
- Download liefert nur archivierte saubere Fassungen und prüft weiterhin Quellenverfügbarkeit, Schutzklasse und Zugriff. Entfällt eine Quelle durch Vernichtung, wird die Ausgabe nicht neu aus historischen Angaben erzeugt. Fehlende Fremdschlüsselziele werden nur bei tatsächlicher Quellenvernichtung gelöst.
- Vor dem gesonderten Abschluss müssen Protokoll und alle Teile des aktuellen Freigabestands vollständig abgelegt sein. Eingebettete Unicode-Schriften verhindern stille Namensersetzungen; nicht unterstützte Zeichen sperren die PDF-Ausgabe ausdrücklich.
- Der gesonderte Abschluss setzt `mandateEndedAt` und protokolliert den Vorgang. Offene Fristen und Anforderungen bleiben unverändert.
- Portal-Authentifizierung prüft den aktuellen Mandatsstatus; zusätzliche Session-Widerrufe entkräften bestehende Tokens. Ein fehlgeschlagener zusätzlicher Widerruf wird ausdrücklich gemeldet.
- Vorhandene GwG-/DSGVO-Queues verwenden ihren bestehenden Mandatsende-Anker. Dokumentbezogene GoBD-Fristen werden nicht auf den Endtag umgestellt.

## Ausnahmen und Grenzfälle

Ein Download beweist keine tatsächliche Herausgabe oder Kenntnisnahme des Nachfolgeberaters. Ungeklärte individuelle Aufbewahrungsgründe sind im Vermerk offenzuhalten; das Modul ist keine allgemeine Legal-Hold-Engine. Eine Wiederaufnahme stellt weder vernichtete Daten wieder her noch löscht sie bereits erzeugte Übergabenachweise.

## Beispiele

### Normalfall

ADMIN/PARTNER bestätigt einen Nachfolgeberater und gibt zwei interne Dokumentfassungen ausdrücklich einschließlich ihres Schutzbedarfs frei. Die Anwendung archiviert Protokoll und passenden ZIP-Teil. Nach Prüfung der gespeicherten Ausgaben bestätigt die Person das Mandatsende; die Originale bleiben unverändert.

### Grenzfall

Ein gemischter Umfang enthält Rechnungen, Personal- und GwG-Unterlagen. Ohne zusätzliche sensible Freigabe oder erforderliches Personalrecht scheitert die Aktion. Mit geprüfter Freigabe entstehen getrennte Teile unter ihren Schutzklassen. Ein nachträglich vernichtetes GwG-Original wird weder aus einem gespeicherten Intent rekonstruiert noch über allgemeine Dokumentwege ausgegeben.

## Umsetzung in TaxTronik

Vorbereitung, Empfänger und einzelne Freigaben sind tenantgebunden gespeichert; Fassungen besitzen echte DocumentVersion-Fremdschlüssel. MandateArtifact und MandateArtifactSource binden Ausgaben und Quellen. Restriktive Dokument-RLS schützt auch generische Downloads; SQL-Trigger sichern Schutzklasse, interne Ablage und unveränderliche Nachweise. FK-getriebene Nullsetzung nach Vernichtung ist eng begrenzt. Der Abschluss serialisiert am Mandanten und prüft den Ausgangsstand erneut. Grenzen: 200 Dokumente, zusammen 100 MiB, je Fassung und ZIP-Quellenumfang 24 MiB. Quellobjekte werden weder gelöscht noch verschoben. Aufbewahrungsprüfung und Beendigung bleiben verschiedene Entscheidungen.

## Bekannte Abweichungen und Grenzen

Der Vollständigkeitsumfang ist begrenzt: andere Fachbestände sind nicht pauschal Teil des Pakets; Auswahl und tatsächliche Herausgabepflicht bleiben Einzelfallentscheidungen. Es gibt keinen automatischen Versand, keine Fristbeendigung, keine automatische Löschung und keine automatische Löschfreigabe. Die Rolle ADMIN/PARTNER beweist keine Berufsträgerqualifikation. Zusätzliche Protokoll-/Arbeitsmetadaten haben keine zugesagte automatische allgemeine Löschregel; ihre organisatorische Aufbewahrungsprüfung bleibt offen.

## Fachliche Prüffragen

Welche Unterlagen müssen im konkreten Fall herausgegeben werden? Wer überwacht offene Fristen nach der Übergabe? Welche zusätzlichen Aufbewahrungsgründe und Fristanker bestehen?

## Technische Nachweise

Tests prüfen echte Kalenderdaten, Zukunftsausschluss, PDF-Paginierung sowie die Ausgangsstand-, Rollen- und Umfangsgrenzen. Der technische Hash ersetzt keine fachliche Entscheidung.
