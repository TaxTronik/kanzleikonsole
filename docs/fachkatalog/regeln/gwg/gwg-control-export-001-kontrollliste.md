---
id: GWG-CONTROL-EXPORT-001
title: Aktuelle GwG-Kontrollliste auf sichtbare Mandate begrenzen und als Excel exportieren
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
    Die aktuelle Kontrollliste bündelt ausdrücklich verbundene Personen mit
    getrennten Mandatsnachweisen. Excel enthält Personenübersicht und Nachweisdetails mit
    denselben Gruppennummern, vollständigen Ausweisnummern und einer harten
    Grenze von 10.000 Detailzeilen. Sie ist kein vollständiges GwG-Dossier.
sources:
  - kind: product_documentation
    citation: Produktumfang der GwG-Kontrollliste und des Excel-Exports
    path: FEATURES.md
    checked_at: '2026-08-31'
    primary: true
code_refs:
  - apps/web/src/server/gwg/control-list.ts
  - apps/web/src/server/gwg/control-list-model.ts
  - apps/web/src/server/gwg/control-xlsx.ts
  - apps/web/src/app/staff/(protected)/gwg/page.tsx
  - apps/web/src/app/api/staff/gwg/export/route.ts
test_refs:
  - apps/web/src/server/gwg/__tests__/control-list-model.test.ts
  - apps/web/src/server/gwg/__tests__/control-list.test.ts
  - apps/web/src/server/gwg/__tests__/control-xlsx.test.ts
feature_refs:
  - FEATURES.md
related_rules:
  - GWG-PERSON-LINKS-001
  - ACCESS-CLIENT-MODE-001
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-RISK-REVIEW-001
  - GWG-RETENTION-DESTRUCTION-001
tags:
  - kontrollliste
  - excel-export
  - ausweisnummer
---

# GWG-CONTROL-EXPORT-001 — Aktuelle GwG-Kontrollliste auf sichtbare Mandate begrenzen und als Excel exportieren

## Kurzfassung

Die interne Liste und der Excel-Export zeigen je sichtbarem Mandanten dessen
neuesten nicht vernichteten Prüfstand mit aktuellen Ausweissätzen. Eine
Personengruppe bündelt Unternehmenszuordnungen; Ausweise und Entscheidungen
bleiben je Mandat getrennt. Vollständige Ausweisnummern sind für Mitarbeiter
mit bestehendem Mandantenzugriff sichtbar und exportierbar.

## Wann gilt die Regel?

Die Regel gilt für `/staff/gwg` und `/api/staff/gwg/export`. Die Kontrollliste
ist eine Arbeitsübersicht und keine Vollständigkeitsbestätigung der GwG-Akte.

## Benötigte Angaben

- aktueller Mitarbeiter, Tenant und Mandantenzugriff
- neuester nicht vernichteter Check je sichtbarem Mandanten
- lokale Personen, Rollen und nicht abgelöste Ausweissätze
- Dokumentnummer, Gültigkeit, Verfügbarkeit und Prüfbestätigungen
- separate Mitarbeiter-/Zeitangaben für Ausweisprüfung und finale GwG-Freigabe

## Entscheidungslogik

| Wenn                                                              | Dann                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| Mandant ist verborgen oder anonymisiert                           | Keine Zeile, Gruppeninformation oder Zähler exportieren |
| Mehrere Prüfzyklen existieren                                     | Nur neuesten nicht vernichteten Check auswerten         |
| Person, Ausweis oder Prüfung fehlt                                | Fehlzustand ausdrücklich zeigen                         |
| Nachweis ist abgelaufen, ungeprüft oder nicht verfügbar           | Unterschiedlichen Kontrollstatus ausweisen              |
| Vorder- und Rückseite gehören zum gleichen Ausweissatz            | Eine Detailzeile erzeugen                               |
| Verschiedene Mandate haben verschiedene Ausweise derselben Person | Getrennte Detailzeilen mit gemeinsamer Gruppennummer    |
| Mehr als 10.000 Detailzeilen wären erforderlich                   | Export ablehnen statt still kürzen                      |

## Ausnahmen und Grenzfälle

„Ausweis geprüft“ bedeutet weder „Mandat freigegeben“ noch rechtliche
Vollständigkeit. Die finale GwG-Freigabe steht in eigenen Spalten. Gruppennummern
sind lokal zum sichtbaren Export und keine fachliche Personenkennung. Nach dem
Download liegt die Weitergabe und Aufbewahrung der Datei bei der Kanzlei.

## Beispiele

Eine ausdrücklich verbundene Person besitzt bei Mandant A den Ausweis 00123
und bei Mandant B den Ausweis 00999. Das Blatt „Personenübersicht“ führt eine Gruppe,
das Blatt „Nachweisdetails“ zwei Mandatszeilen mit unveränderten Ausweisnummern. Ist B
für den exportierenden Mitarbeiter verborgen, enthalten beide Blätter nur A.

Ein Ausweissatz ohne dokumentierte Prüfung erscheint als ungeprüft; aus der
fehlenden Prüfung wird weder ein Prüfername noch eine GwG-Freigabe abgeleitet.

## Umsetzung in TaxTronik

Liste und Export verwenden dieselbe Projektion und denselben Zugriffspredikat.
Der Export liest einen konsistenten Datenbank-Snapshot, schreibt zwei echte
XLSX-Blätter „Personenübersicht“ und „Nachweisdetails“, fixiert Kopfzeilen und setzt Autofilter.
Alle Zellen werden ausdrücklich als Text geschrieben: führende Nullen bleiben
erhalten und eingegebene Formeln werden nicht ausgeführt. Rate-Limit,
No-Store-Header und ein Auditereignis mit Umfang und Filterart ergänzen den
Leseschutz. Der Audittext enthält keine vollständige Ausweisdatenliste.

## Bekannte Abweichungen und Grenzen

Historische Akten, Registerbelege, Eigentumsstrukturen und Risikobegründungen
sind nicht Bestandteil des Exports. Mitarbeiter sehen nur ihren erlaubten
Ausschnitt und erhalten deshalb keine vollständige Kanzleiliste zugesichert.
Sehr große Bestände müssen nach Mandant eingegrenzt werden.
Überschreitet eine zusammengefasste Zelle des Personenblatts die Excel-Grenze,
wird allein diese Zusammenfassung mit einem sichtbaren Verweis auf das
Detailblatt gekürzt; alle zugehörigen Mandatszeilen bleiben dort vollständig.

## Fachliche Prüffragen

- Ist der vorhandene Mandantenzugriff für vollständige Ausweisnummern angemessen?
- Wie organisiert die Kanzlei sichere Weitergabe und Aufbewahrung der Exporte?

## Technische Nachweise

Tests prüfen getrennte Fehlzustände, einschließlich Ablauf am Kalendertag,
sichtbare Gruppierung ohne verborgene Verbindungswege, getrennte Mandatsnummern,
die Struktur beider XLSX-Blätter, Formelsicherheit und die harte Exportgrenze.
