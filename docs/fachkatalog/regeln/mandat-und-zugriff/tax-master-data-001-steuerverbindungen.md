---
id: TAX-MASTER-DATA-001
title: Steuerliche Stammdaten mit mehreren Steuerverbindungen getrennt vom GwG führen
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Steuerrecht und Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Eine USt-ID und mehrere Steuerverbindungen gehören zum Mandanten. Genau
    eine aktive Verbindung ist Standard. Länderformate werden strukturell in
    das ELSTER-Bundesformat umgerechnet; Finanzamtszuständigkeit und Erteilung
    werden nicht automatisch bestätigt. Portaländerungen benötigen die
    Entscheidung der Kanzlei und einen unveränderten Ausgangsstand.
sources:
  - kind: product_documentation
    citation: Steuerliche Stammdaten, Mehrfachverbindungen und Freigabe von Portalvorschlägen
    path: docs/fachkatalog/SCOPE.md
    checked_at: '2026-08-31'
    primary: true
  - kind: official_guidance
    citation: ELSTER Hilfe, Steuernummer und Tabelle Länderformat/Bundesschema
    url: https://www.elster.de/eportal/helpGlobal?themaGlobal=wo_ist_meine_steuernummer
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/change-requests/page.tsx
  - apps/web/src/lib/tax-registration.ts
  - apps/web/src/server/tax-master-data/schema.ts
  - apps/web/src/server/tax-master-data/service.ts
  - apps/web/src/app/portal/(protected)/stammdaten/tax-actions.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/elster/actions.ts
  - packages/db/prisma/migrations/20260831100000_tax_registrations/migration.sql
test_refs:
  - apps/web/src/app/portal/(protected)/stammdaten/__tests__/tax-actions.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/elster/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/__tests__/tax-data-actions.test.ts
  - apps/web/src/lib/__tests__/tax-registration.test.ts
  - apps/web/src/server/tax-master-data/__tests__/schema.test.ts
  - apps/web/src/server/tax-master-data/__tests__/service.test.ts
  - packages/db/src/__tests__/tax-master-data.test.ts
feature_refs:
  - FEATURES.md
related_rules:
  - GWG-REVERIFICATION-VALIDITY-001
  - ACCESS-CLIENT-MODE-001
  - ACCESS-TENANT-RLS-001
  - DSGVO-MANDATE-ANONYMIZATION-001
tags:
  - stammdaten
  - steuernummer
  - elster
  - portal
---

# TAX-MASTER-DATA-001 — Steuerliche Stammdaten mit mehreren Steuerverbindungen getrennt vom GwG führen

## Kurzfassung

Steuerdaten werden in einer eigenen Sektion geführt. Die USt-ID bleibt einmal
am Mandanten gespeichert; mehrere Steuernummern mit Bezeichnung und Finanzamt
werden als getrennte Steuerverbindungen geführt. Eine reine Steuerdatenänderung
löst keinen neuen GwG-Prüfzyklus aus. Diese Trennung ist eine ungeprüfte
Produktregel, keine vollständige Aussage über gesetzliche Aktualisierungspflichten.

## Wann gilt die Regel?

Die Regel gilt für Mitarbeiterbearbeitung, Portalvorschläge und die Auswahl
einer Steuerverbindung zur ELSTER-Kontoabfrage. Steuerverbindungen eines
Mandanten werden nicht auf andere Rechtsträger übertragen. Internationale
Steuernummern, mehrere USt-IDs, Zuständigkeitsrecherchen und Steuerartenrouting
sind nicht Bestandteil dieser Umsetzung.

## Benötigte Angaben

- Mandant und aktueller Mandantenzugriff
- optionale USt-ID
- je Verbindung Bezeichnung, Steuernummer, optional Bundesland und Finanzamtsname
- genau eine Standardverbindung, soweit aktive Verbindungen vorhanden sind
- Ausgangsrevision bei Änderung oder Portalvorschlag

## Entscheidungslogik

| Wenn                                                | Dann                                                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Länderformat eingegeben                             | Bundesland verlangen und nach veröffentlichter ELSTER-Tabelle umrechnen                                    |
| 13-stelliges Format eingegeben                      | Struktur prüfen; Ziffern einschließlich führender Nullen erhalten                                          |
| Nummer strukturell gültig                           | Keine Aussage über Erteilung, Prüfziffer oder zuständiges Amt ableiten                                     |
| Mehrere Verbindungen vorhanden                      | Genau eine explizite Standardverbindung führen                                                             |
| Verbindung aus Arbeitsliste entfernt                | Archivieren; vorhandene ELSTER-Historie nicht umschreiben                                                  |
| Mitarbeiter speichert                               | Mandantenzugriff und unveränderte Revision prüfen, atomar speichern und auditieren                         |
| Portal schlägt Änderung vor                         | Nur Anfrage speichern, noch keine steuerlichen Stammdaten ändern                                           |
| Kanzlei genehmigt Vorschlag mit veralteter Revision | Entscheidung samt Datenänderung zurückrollen; neu prüfen lassen                                            |
| ELSTER-Abfrage ausgeführt                           | Ausgewählte aktive Verbindung serverseitig laden und verwendete Nummer als Snapshot zur Historie speichern |

## Ausnahmen und Grenzfälle

Ein Mandant ohne Steuerverbindungen bleibt zulässig. Historische
ELSTER-Abfragen ohne aufgezeichnete Steuernummer werden ausdrücklich als
Altbestand gekennzeichnet und nicht aus heutigen Daten ergänzt. Eine
Standardverbindung ist nur eine Vorauswahl und bestimmt nicht automatisch,
welche Nummer fachlich für eine Steuerart zu verwenden ist.

## Beispiele

### Normalfall

Die Kanzlei führt zwei Steuernummern desselben Mandanten mit unterschiedlichen
Zweckbezeichnungen. Vor der Kontoabfrage wählt sie die passende Verbindung.
Eine spätere Nummernänderung verändert den alten Abrufnachweis nicht.

### Grenzfall

Während ein Portalvorschlag auf Freigabe wartet, berichtigt die Kanzlei das
Finanzamt. Der Vorschlag darf den neuen Stand nicht überschreiben; die
Revision verhindert die Genehmigung ohne erneute Prüfung.

## Umsetzung in TaxTronik

`ClientTaxRegistration` speichert Verbindungen mit zusammengesetztem
Tenant-/Mandantenbezug, RLS, einer eindeutigen aktiven Standardverbindung und
Archivierung. Die bisherige `Client.steuernummer` wird bei Migration unverändert
in eine Standardverbindung kopiert; neue Arbeitsabläufe lesen und schreiben
ausschließlich die Verbindungsliste. Der Altwert bleibt nur für den
Deployment-Übergang erhalten und ist kein zweites Bearbeitungsfeld.

Die Normalisierung ist eine deterministische Strukturumrechnung. Das Finanzamt
wird manuell nach Aktenlage erfasst; es besteht keine Live-Anbindung an ein
amtliches Verzeichnis. Portalvorschläge verwenden den bestehenden
Stammdaten-Freigabeworkflow mit einer eigenen steuerlichen Payload-Version und
einer Ausgangsrevision. Bereits ausgestellte Rechnungen bleiben unverändert;
neue Rechnungen können die aktuelle USt-ID weiterhin verwenden.

Die bestätigte NATPERS-Anonymisierung redigiert auch archivierte Verbindungen
und den Legacy-Wert. Leere Verbindungen sind danach nur archiviert zulässig;
aktive Verbindungen müssen DB-seitig weiterhin eine Nummer führen. Die
separat gespeicherten ELSTER-Nummernsnapshots bleiben ihrem eigenen
Aufbewahrungspfad unterworfen. Anonymisierte Mandanten können nicht erneut
über den Steuerdaten-Service befüllt werden.

## Bekannte Abweichungen und Grenzen

Die Formatprüfung bestätigt weder die Existenz der Nummer noch Zuständigkeit,
Vollmacht, Übermittlungsberechtigung oder fachliche Auswahl der Steuerart.
ELSTER prüft Übermittlungen zusätzlich im bestehenden Bridge-Verfahren. Die
steuerlichen Abrufnachweise bleiben in dessen getrenntem Aufbewahrungspfad;
Archivieren einer Verbindung ist keine personenbezogene Löschung.

## Fachliche Prüffragen

- Welche Verbindung ist für welchen Bearbeitungsfall maßgeblich?
- Wie prüft die Kanzlei Finanzamtswechsel und tatsächliche Nummernerteilung?
- Welche steuerlichen Nachweise unterliegen im Einzelfall welcher Aufbewahrung?

## Technische Nachweise

Tests prüfen alle 16 Länderformate, Normalisierung und führende Nullen,
eindeutige Standardwahl, doppelte Nummern, veraltete Vorschläge, fremde
Verbindungs-IDs und Archivierung ohne Umschreiben von Abrufhistorie. Diese
Tests ersetzen keine fachliche Freigabe der Produktregel.
