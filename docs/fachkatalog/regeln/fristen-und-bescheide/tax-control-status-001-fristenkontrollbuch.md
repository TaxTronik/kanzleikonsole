---
id: TAX-CONTROL-STATUS-001
title: Offene und erledigte Fristen aus dem Quellstatus ableiten
domain: fristen-und-bescheide
rule_type: office_policy
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Kanzleileitung Fristenkontrolle
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: Das Kontrollbuch leitet den Erledigungsstand ohne eigenen Parallelstatus aus den Fachmodulen ab und behält offene Überfälligkeiten sichtbar.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Fristenkontrollbuch
    path: docs/anwenderdoku/kalender-fristen-bescheide.md
    checked_at: '2026-08-23'
    primary: true
  - kind: product_documentation
    citation: Funktionskatalog Fristenkontrollbuch
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - apps/web/src/server/fristen/eintrag.ts
  - apps/web/src/server/fristen/kontrollbuch.ts
test_refs:
  - apps/web/src/server/fristen/__tests__/eintrag.test.ts
  - apps/web/src/server/fristen/__tests__/kontrollbuch.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-NOTICE-APPEAL-001
  - TAX-DEADLINE-AUTOREQUEST-001
tags:
  - fristenkontrollbuch
  - erledigung
  - status
---

# TAX-CONTROL-STATUS-001 — Offene und erledigte Fristen aus dem Quellstatus ableiten

## Kurzfassung

Das Fristenkontrollbuch führt keinen eigenen Erledigt-Schalter. Es liest den
Erledigungsstand aus dem jeweiligen Fachmodul, damit Kontrollsicht und
Originalvorgang nicht auseinanderlaufen. Offene überfällige Fristen bleiben
ohne zeitliche Untergrenze sichtbar, bis der Quellvorgang einen definierten
Erledigungsstatus erreicht.

## Wann gilt die Regel?

Die Regel gilt für Steuertermine, Einspruchsfristen, Klagefristen,
Mandantenanforderungen und Wiedervorlagen, die im zentralen Kontrollbuch
zusammengeführt werden. Sie beschreibt die kanzleiinterne Kontrollsicht und
nicht die materiell-rechtliche Wirksamkeit eines Rechtsbehelfs.

## Benötigte Angaben

- Quellart und Quellstatus
- Fälligkeitsdatum
- gegebenenfalls Erledigungsdatum und erledigende Person
- verantwortliche Person beziehungsweise Mandantenzuordnung
- Berechtigung der betrachtenden Person für den Mandanten

## Entscheidungslogik

| Quelle          | Offen                                   | Erledigt                                                                                       |
| --------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Steuertermin    | jeder Status außer `DONE` und `SKIPPED` | `DONE`, `SKIPPED`                                                                              |
| Einspruchsfrist | `NEU`, `GEPRUEFT`                       | ab `EINSPRUCH` sowie `ABGEHOLFEN`, `TEILABHILFE`, `ZURUECKGEWIESEN`, `KLAGE`, `RECHTSKRAEFTIG` |
| Klagefrist      | `ZURUECKGEWIESEN`, `TEILABHILFE`        | `KLAGE`, `RECHTSKRAEFTIG`                                                                      |
| Anforderung     | `OPEN`, `IN_PROGRESS`, `RESPONDED`      | `CLOSED`, `CANCELLED`                                                                          |
| Wiedervorlage   | kein Erledigungsdatum                   | Erledigungsdatum vorhanden                                                                     |

Offene Einträge erscheinen bis zum Zukunftshorizont ohne untere Datumsgrenze.
Erledigte Einträge erscheinen nur im gewählten Rückschaufenster.

## Ausnahmen und Grenzfälle

`GEPRUEFT` schließt die Einspruchsfrist bewusst nicht; eine Sichtung allein
beweist weder Einspruch noch bewusste Bestandskraft. `RESPONDED` schließt eine
Mandantenanforderung ebenfalls nicht, weil die Kanzleiprüfung noch aussteht.
`RECHTSKRAEFTIG` ist ein bewusster fachlicher Abschlussstatus und darf nicht
allein aus Zeitablauf gesetzt werden.

## Beispiele

### Normalfall

Ein Bescheid ist geprüft, aber es wurde noch keine Entscheidung zu Einspruch
oder Bestandskraft dokumentiert. Die Einspruchsfrist bleibt im Kontrollbuch
offen und wird nach Überschreiten des Datums als überfällig einsortiert.

### Grenzfall

Ein Mandant hat Unterlagen geliefert; die Anforderung steht auf `RESPONDED`.
Da die Kanzlei die Antwort noch nicht geschlossen hat, bleibt der Eintrag als
offen sichtbar.

## Umsetzung in TaxTronik

Reine Statusfunktionen in `eintrag.ts` bilden jede Quelle auf offen oder
erledigt ab. `kontrollbuch.ts` verwendet dieselben Mengen bereits in den
Datenbankabfragen und filtert vertrauliche beziehungsweise im strikten Modus
nicht zugängliche Mandanten. Sortiert wird offen vor erledigt und innerhalb der
offenen Einträge nach ältester Fälligkeit.

## Bekannte Abweichungen und Grenzen

Innerhalb des beschriebenen Status-Scopes sind keine abweichenden
Implementierungen bekannt. Der Katalogeintrag ist jedoch fachlich noch nicht
freigegeben. Vollständige historische Erledigungsnachweise liegen nicht in der
begrenzten Bildschirmsicht, sondern in Export beziehungsweise Audit-Chain.

## Fachliche Prüffragen

- Soll `EINSPRUCH` bereits als Erledigung der Einspruchsfrist gelten, obwohl die
  weitere Bearbeitung noch offen ist?
- Welche Nachweise sind erforderlich, bevor `RECHTSKRAEFTIG` gesetzt werden
  darf?
- Sind Rückschaufenster und Verantwortlichkeitsfilter für das organisatorische
  Fristenkontrollverfahren ausreichend?
- Braucht die Kanzlei ein Vier-Augen-Prinzip für einzelne Abschlussstatus?

## Technische Nachweise

Die referenzierten Unit-Tests ziehen die Status-Wahrheitstabellen je Quelle.
Die Loader-Tests prüfen Zeitfenster, überfällige offene Einträge,
Zugriffsfilterung, Klagefristen und Sortierung.
