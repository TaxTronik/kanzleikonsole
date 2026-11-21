---
id: APPT-BERLIN-WALLCLOCK-001
title: Kanzleitermine und Terminwünsche in Berliner Ortszeit erfassen
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
    Der Termindialog zeigt als Startvorschlag die aktuelle Berliner Uhrzeit.
    Das Portal bietet ab dem nächsten Berliner Kalendertag bearbeitbare
    Terminwünsche an. Beide Serveraktionen lesen die Eingaben als Berliner Ortszeit.
sources:
  - kind: product_documentation
    citation: Anwenderdokumentation Kalender, Abschnitt 1 „Kanzleikalender und Terminanfragen“
    path: docs/anwenderdoku/kalender-fristen-bescheide.md
    checked_at: '2026-11-21'
    primary: true
code_refs:
  - apps/web/src/lib/fmt.ts
  - apps/web/src/app/staff/(protected)/calendar/new-appointment-dialog.tsx
  - apps/web/src/app/staff/(protected)/calendar/actions.ts
  - apps/web/src/app/portal/(protected)/appointments/request-form.tsx
  - apps/web/src/app/portal/(protected)/appointments/actions.ts
test_refs:
  - apps/web/src/components/__tests__/berlin-form-defaults.test.tsx
  - apps/web/src/app/staff/(protected)/calendar/__tests__/appointment-actions.test.tsx
  - apps/web/src/app/portal/(protected)/appointments/__tests__/page.test.tsx
  - apps/web/src/lib/__tests__/fmt.test.ts
feature_refs:
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules: []
tags: [kalender, terminuebernahme, ortszeit]
---

# APPT-BERLIN-WALLCLOCK-001 — Kanzleitermine und Terminwünsche in Berliner Ortszeit erfassen

## Kurzfassung

Für Start, Ende und Terminwünsche gilt die Zeitzone Europe/Berlin. Das gilt auch
für die bearbeitbaren Vorschläge beim Öffnen des Formulars.

## Wann gilt die Regel?

Bei Terminen im Kanzleikalender und Wunschterminen im Mandantenportal.

## Benötigte Angaben

- Für die Vorschläge der aktuelle Zeitpunkt und gegebenenfalls ein vorgegebener Start
- Für die Übermittlung der gewählte Kalendertag und die gewählte Uhrzeit

## Entscheidungslogik

| Wenn                                                          | Dann                                                                                        | Begründung                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Die Kanzlei öffnet einen neuen Termin ohne vorgegebenen Start | Aktuelle Berliner Ortszeit minutengenau vorschlagen                                         | Vorschlag und spätere Verarbeitung verwenden dieselbe Uhr       |
| Ein Mandant öffnet das Anfrageformular                        | Für morgen 10 bis 11 Uhr vorschlagen, für weitere Wünsche jeweils den folgenden Kalendertag | Die Vorschläge richten sich nach dem Berliner Kalender          |
| Ein Mandant wählt einen früheren Tag                          | Tage vor Berliner Heute im Picker sperren                                                   | Der Server verlangt einen in der Zukunft liegenden Wunschtermin |

## Ausnahmen und Grenzfälle

Ein ausdrücklich vorgegebener Start bleibt erhalten. Bei der Übermittlung
verwirft der Server nicht existierende Berliner Uhrzeiten. Für eine neue
Eingabe in der doppelten Herbststunde gilt deren späteres Vorkommen. Beim
Bearbeiten bleibt der gespeicherte Zeitpunkt einer unveränderten Uhrzeit erhalten.

## Beispiele

### Normalfall

Am 2. Juli schlägt das Portal den 3. Juli von 10 bis 11 Uhr vor. Der Mandant
kann Tag und Uhrzeit vor dem Absenden ändern.

### Grenzfall

Am 1. Juli um 22:30 UTC ist es in Berlin bereits der 2. Juli um 00:30 Uhr.
Auch ein Browser in UTC zeigt diesen Berliner Start im Kanzleidialog an.

## Umsetzung in TaxTronik

Beide Formulare leiten ihre Vorschläge aus dem aktuellen Zeitpunkt in Berlin
ab und übertragen die gewählte Wanduhrzeit minutengenau. Der Server prüft
die Eingabe und ermittelt den Zeitpunkt in UTC.

## Bekannte Abweichungen und Grenzen

Eine Terminanfrage wartet auf die Entscheidung der Kanzlei. Der Client
sperrt vergangene Tage, der Server prüft auch die genaue Startzeit.

## Fachliche Prüffragen

- Ist die einheitliche Berliner Ortszeit für alle beteiligten Mandanten weiterhin passend?

## Technische Nachweise

Die Formulartests prüfen den angezeigten Start, die übertragenen Portalwünsche
und die früheste wählbare Tageszelle an der Berliner Tagesgrenze mit einem
UTC-Browserdatum. Die bestehenden Zeitkonvertierungs- und Aktionstests prüfen
die beiden Berliner Zeitumstellungen sowie das Bearbeiten eines bestehenden Termins.
