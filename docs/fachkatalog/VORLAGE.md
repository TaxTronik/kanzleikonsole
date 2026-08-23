# Vorlage für eine Fachregel

Diese Datei ist eine Kopiervorlage und wird nicht als Regel validiert. Werte in
spitzen Klammern ersetzen; `null` nur dort stehen lassen, wo noch keine
fachliche Freigabe vorliegt.

Amtliche Gesetze, Verwaltungsanweisungen und Rechtsprechung werden nur von den
im Validator freigegebenen Original-Domains akzeptiert. Fehlt ein zuständiges
amtliches Portal, wird die Allowlist bewusst im Review erweitert; die Quelle
darf nicht ersatzweise falsch typisiert werden.

```yaml
---
id: AREA-THEMA-001
title: Kurzer, entscheidbarer Regeltitel
domain: fachbereich
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger <Fachbereich>
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: not_assessed
  summary: Der Abgleich mit der Software ist noch offen.
sources:
  - kind: product_documentation
    citation: Interne Anforderung oder Dokumentation
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: true
code_refs: []
test_refs: []
feature_refs:
  - FEATURES.md
related_rules: []
tags:
  - suchwort
---
```

Danach folgen diese Abschnitte in genau dieser Reihenfolge:

## Kurzfassung

Die fachliche Aussage in zwei bis vier verständlichen Sätzen. Automatische
Ergebnisse als Vorschlag kennzeichnen, wenn eine manuelle Prüfung nötig bleibt.

## Wann gilt die Regel?

Positiv und negativ abgrenzen, für welche Fälle und Zeiträume die Regel gilt.

## Benötigte Angaben

- Eingabe oder Nachweis
- weitere Eingabe

## Entscheidungslogik

| Wenn | Dann | Begründung |
| ---- | ---- | ---------- |
| …    | …    | …          |

## Ausnahmen und Grenzfälle

Sonderfälle, Beweisfragen, manuelle Kontrollen und nicht erfasste Fälle.

## Beispiele

### Normalfall

Eingaben und nachvollziehbares Ergebnis.

### Grenzfall

Eingaben, Ergebnis und erforderliche manuelle Entscheidung.

## Umsetzung in TaxTronik

In Alltagssprache erklären, was das Produkt wann berechnet, sperrt, anzeigt
oder bewusst nicht entscheidet.

## Bekannte Abweichungen und Grenzen

„Keine bekannten Abweichungen innerhalb des beschriebenen Scopes“ nur nach
einem tatsächlichen Abgleich schreiben. Sonst jede Abweichung konkret nennen.

## Fachliche Prüffragen

- Welche Aussage muss ein Berufsträger vor einer Freigabe bestätigen?

## Technische Nachweise

Metadaten enthalten die maschinenlesbaren Pfade. Hier deren Aussagekraft kurz
erklären, ohne neue fachliche Behauptungen einzuführen.
