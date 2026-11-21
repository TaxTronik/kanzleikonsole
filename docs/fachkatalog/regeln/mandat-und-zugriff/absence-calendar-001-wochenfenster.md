---
id: ABSENCE-CALENDAR-001
title: Die aktuelle Woche und offene Abwesenheiten im Wandkalender nach Berliner Kalendertag anzeigen
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
  status: implemented
  summary: >-
    Der Wandkalender beginnt mit dem Montag der laufenden Berliner Woche.
    Dasselbe Tagesdatum begrenzt die Markierung einer offenen Abwesenheit.
sources:
  - kind: product_documentation
    citation: Funktionskatalog zu Abwesenheiten und Wandkalender
    path: FEATURES.md
    checked_at: '2026-11-21'
    primary: true
code_refs:
  - apps/web/src/app/staff/(protected)/absences/calendar/page.tsx
  - apps/web/src/app/staff/(protected)/calendar/page.tsx
  - apps/web/src/server/absences/coverage.ts
test_refs:
  - apps/web/src/app/staff/(protected)/absences/calendar/__tests__/page.test.tsx
feature_refs:
  - FEATURES.md
related_rules: []
tags: [kalender, abwesenheit, wochenbeginn]
---

# ABSENCE-CALENDAR-001 — Die aktuelle Woche und offene Abwesenheiten im Wandkalender nach Berliner Kalendertag anzeigen

## Kurzfassung

Der Wandkalender zur Teamabsprache beginnt am Montag der aktuellen Woche in
Europe/Berlin. Ein laufender Eintrag ohne Enddatum markiert die Tage vom
gemeldeten Beginn bis einschließlich des aktuellen Berliner Tages.

## Wann gilt die Regel?

Beim Laden des Abwesenheitskalenders in der Kanzlei.

## Benötigte Angaben

- Aktueller Zeitpunkt, Länge des gewählten Wochenfensters
- Beginn und gegebenenfalls Ende der Abwesenheit als gespeicherte Kalendertage

## Entscheidungslogik

| Wenn                                         | Dann                                                                | Begründung                                        |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| In Berlin beginnt der Montag                 | Das angezeigte Wochenfenster beginnt an diesem Montag               | Abfrage und Spalten folgen derselben Kanzleiwoche |
| Eine begonnene Abwesenheit hat kein Enddatum | Die sichtbaren Tage bis einschließlich heute als abwesend markieren | Für spätere Tage liegt kein bestätigtes Ende vor  |

## Ausnahmen und Grenzfälle

Ein gespeichertes Enddatum begrenzt die Markierung anstelle von heute.
Die Darstellung hält die Art der Abwesenheit gegenüber dem Team vertraulich.

## Beispiele

Am 5. Juli 2026 um 23:59 Uhr in Berlin beginnt das Fenster am Montag,
dem 29. Juni. Ab Montag, dem 6. Juli um 00:00 Uhr, beginnt es am 6. Juli.
Eine seit dem 3. Juli offene Abwesenheit ist dann für den 6. Juli markiert.
Die Zelle für den 7. Juli bleibt leer.

## Umsetzung in TaxTronik

Die Staff-Seite ermittelt den Berliner Kalendertag einmal beim Laden. Daraus
leitet sie Montag, Abfragezeitraum und Markierungsende offener Meldungen ab.
Die Vertretungssicht und der Kanzleikalender verwenden bereits den Berliner Tag.

## Bekannte Abweichungen und Grenzen

Die Darstellung gibt den bei der Abfrage gespeicherten Stand wieder.
Ein bereits geöffnetes Wochenfenster wechselt beim erneuten Laden.

## Fachliche Prüffragen

- Entspricht die Wochenansicht dem Bedarf der Kanzlei bei der Vertretungsplanung?

## Technische Nachweise

Der Seitentest rendert das Wochenfenster unmittelbar vor und ab Berliner
Mitternacht zum 6. Juli. Er prüft die angezeigte Datumszeile, die
Abfragegrenzen und die letzte markierte Tageszelle einer offenen Abwesenheit.
