---
id: GWG-PERSON-LINKS-001
title: Personen nur ausdrücklich und ohne gemeinsame Fachdaten mandatsübergreifend verbinden
domain: gwg
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Geldwäscheprävention und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Technische mandatslokale Personenanker und ausdrücklich bestätigte
    Paarverknüpfungen bündeln sichtbare Unternehmenszuordnungen. Stammdaten,
    Ausweise und Freigaben bleiben in den jeweiligen Mandatsprüfungen.
sources:
  - kind: product_documentation
    citation: Produktumfang der Personenübersicht
    path: FEATURES.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - packages/db/prisma/migrations/20260831101000_gwg_person_links/migration.sql
  - apps/web/src/server/gwg/person-links.ts
  - apps/web/src/server/gwg/control-list-model.ts
  - apps/web/src/server/gwg/control-list.ts
  - apps/web/src/server/gwg/reverification.ts
  - apps/web/src/server/gwg-onboarding/submission-transaction.ts
  - apps/web/src/app/staff/(protected)/gwg/actions.ts
test_refs:
  - apps/web/src/server/gwg/__tests__/person-links.test.ts
  - apps/web/src/server/gwg/__tests__/control-list-model.test.ts
  - apps/web/src/server/gwg/__tests__/control-list.test.ts
  - apps/web/src/server/gwg/__tests__/snapshot-copy.test.ts
  - packages/db/src/__tests__/gwg-person-links.test.ts
feature_refs:
  - FEATURES.md
related_rules:
  - ACCESS-CLIENT-MODE-001
  - ACCESS-TENANT-RLS-001
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-REVERIFICATION-VALIDITY-001
  - GWG-RETENTION-DESTRUCTION-001
  - GWG-CONTROL-EXPORT-001
tags:
  - personenverknuepfung
  - mandantenzugriff
  - keine-gemeinsamen-stammdaten
---

# GWG-PERSON-LINKS-001 — Personen nur ausdrücklich und ohne gemeinsame Fachdaten mandatsübergreifend verbinden

## Kurzfassung

Ein Mitarbeiter kann zwei bekannte Personen aus unterschiedlichen sichtbaren
Mandanten ausdrücklich als dieselbe Person verbinden. Ein Personenanker trägt
nur technische Zuordnungsdaten. Namen, Anschriften, Ausweisnummern und
Freigaben werden weder zentral gespeichert noch zwischen Mandaten übernommen.
Die Verbindung ist eine organisatorische Anzeigehilfe, keine Identitätsprüfung.

## Wann gilt die Regel?

Die Regel gilt für die interne Kontrollliste und ihre Paarverknüpfungen. Der
öffentliche Einladungswizard erhält keine mandatsübergreifenden Verbindungen.

## Benötigte Angaben

- zwei mandatslokale Personenanker desselben Tenants
- Zugriff des Mitarbeiters auf beide aktuellen Mandatsprüfungen
- ausdrückliche Bestätigung sowie Mitarbeiter und Zeitpunkt
- stabile Rollenreferenzen statt Namensvergleichen

## Entscheidungslogik

| Wenn                                                           | Dann                                                                                    |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Gleiche Namen, aber keine ausdrückliche Verbindung             | Getrennte Einträge behalten                                                             |
| Mitarbeiter bestätigt zwei zugängliche lokale Personen         | Genau diese Paarverbindung speichern und auditieren                                     |
| Einer der Mandanten ist nicht zugänglich                       | Verknüpfung und Trennung abweisen                                                       |
| Vertreter und Berechtigter sind ausdrücklich dieselbe Person   | Einen lokalen Anker verwenden                                                           |
| Neuer Prüfzyklus kopiert eine bestehende lokale Person         | Anker anhand der tatsächlichen Kopierzuordnung fortführen, keine Bestätigung übernehmen |
| Neuer Personen-Datensatz ohne bestehende Referenz              | Neuen lokalen Anker erzeugen                                                            |
| Personenmitglied oder Verbindungsweg ist verborgen             | Nicht in Anzeige, Gruppierung, Zähler oder Export einbeziehen                           |
| Anonymisierung oder Ende aller lebenden lokalen Prüfreferenzen | Mandatsübergreifende Verbindungen entfernen; unreferenzierte Anker bereinigen           |

## Ausnahmen und Grenzfälle

Eine Gruppe kann bei eingeschränkten Berechtigungen anders erscheinen als bei
einem Admin. Unsichtbare Zwischenpersonen verbinden keine sichtbaren Gruppen.
Das Lösen einer direkten Verbindung löst nicht zusätzlich andere ausdrücklich
gespeicherte Verbindungen. Mehrere Ausweise verschiedener Mandanten bleiben
sichtbar getrennt. Historische Daten werden nicht anhand gleicher Namen
nachträglich verknüpft.

## Beispiele

Erika Beispiel ist Vertreterin bei Mandant A und wirtschaftlich Berechtigte
bei Mandant B. Erst die ausdrückliche Paarverbindung bündelt ihre Zuordnungen.
Eine korrigierte Anschrift bei A ändert weder B noch dessen Nachweisprüfung.

Die sichtbaren Personen A und C sind nur über eine für den Mitarbeiter
verborgene Person B verbunden. Die Übersicht zeigt A und C als getrennte
Gruppen und verrät weder B noch die verborgenen Verbindungswege.

## Umsetzung in TaxTronik

Zwei Tenant-Tabellen speichern lokale Anker und kanonisch geordnete Paare mit
RLS und zusätzlichen Scope-Triggern. Neue Rollen erhalten Anker automatisch;
explizite Doppelrollen verwenden den Owner-Anker. Ergänzt die Kanzlei einem
Vertreter die Owner-Rolle, wird sein bestehender Anker beibehalten. Kopie und
gebundener Re-Onboarding-Submit bewahren Anker anhand bestehender Rollen-IDs.
Die Gruppenbildung erfolgt erst nach dem Mandantenzugriffsfilter. Änderungen
an Verbindungen ändern weder Fachsnapshot noch Freigabe.

## Bekannte Abweichungen und Grenzen

Der Mensch entscheidet über Personenidentität. Die Software prüft keine
Echtheit, Namensgleichheit oder Ähnlichkeit. Datenbanktests benötigen eine
migrierte Testdatenbank; ohne sie wird kein ausgeführter DB-Nachweis behauptet.
Nach Anonymisierung werden Verbindungen getrennt; gegebenenfalls noch
aufzubewahrende lokale Fachsnapshots werden dadurch nicht verändert.

## Fachliche Prüffragen

- Welche organisatorische Kontrolle ist für die ausdrückliche Zuordnung nötig?
- Ist der bestehende Mandantenzugriff für diese Übersicht ausreichend eng?

## Technische Nachweise

Tests prüfen beide Zugriffsgrenzen, identische Namen ohne Verbindung, verborgene
Zwischenknoten, Zyklen, getrennte Mandatsdaten und das Fortführen tatsächlicher
Kopien. Datenbanktests prüfen lokale Scope-Grenzen, Doppelrollen und Trennung
bei Anonymisierung. Sie belegen keine materielle Personenidentität.
