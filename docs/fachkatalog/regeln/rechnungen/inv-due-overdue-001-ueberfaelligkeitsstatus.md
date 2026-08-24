---
id: INV-DUE-OVERDUE-001
title: Fällige offene Rechnungen als Produktstatus überfällig markieren
domain: rechnungen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Rechnungswesen und Forderungsmanagement
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: Der Tagesjob setzt versendete unbezahlte Rechnungen ab dem Tag nach dem gespeicherten Fälligkeitsdatum idempotent auf OVERDUE und erzeugt Audit sowie interne Meldung.
sources:
  - kind: official_law
    citation: § 271 BGB, Leistungszeit bei bestimmter Fälligkeit
    url: https://www.gesetze-im-internet.de/bgb/__271.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 286 BGB, Voraussetzungen und Ausnahmen des Schuldnerverzugs
    url: https://www.gesetze-im-internet.de/bgb/__286.html
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, Überfälligkeits-Worker
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-24'
    primary: true
code_refs:
  - apps/worker/src/jobs/invoice-overdue-check.ts
test_refs:
  - apps/worker/src/jobs/__tests__/invoice-overdue-check.test.ts
feature_refs:
  - docs/development/module/fakturierung.md
  - docs/anwenderdoku/rechnungen.md
related_rules:
  - INV-LIFECYCLE-FREEZE-001
  - INV-STORNO-REFERENCE-001
tags:
  - rechnung
  - faelligkeit
  - ueberfaellig
  - notification
---

# INV-DUE-OVERDUE-001 — Fällige offene Rechnungen als Produktstatus überfällig markieren

## Kurzfassung

Ein täglicher Worker markiert eine versendete, noch nicht bezahlte
Originalrechnung ab dem Kalendertag nach ihrem gespeicherten Fälligkeitsdatum
mit dem internen Status `OVERDUE`. Statuswechsel, Audit-Ereignis und interne
Benachrichtigung erfolgen in einer Tenant-Transaktion und werden bei
Wiederholung nicht dupliziert. Der Produktstatus ist keine abschließende
rechtliche Feststellung des Schuldnerverzugs.

## Wann gilt die Regel?

Die Regel gilt für Rechnungen mit Status `SENT`, deren `dueDate` vor dem
aktuellen Berliner Kalendertag liegt und die kein Korrekturbeleg sind. Bereits
bezahlte, stornierte, überfällige oder als Korrekturbeleg verknüpfte Rechnungen
werden von diesem Übergang nicht erfasst.

## Benötigte Angaben

- Mandanten-ID und Rechnungs-ID
- aktueller Rechnungsstatus
- gespeichertes Fälligkeitsdatum
- aktueller Kalendertag in der betrieblichen Zeitzone Europe/Berlin
- Kennzeichnung als Original oder Korrekturbeleg
- Ersteller der Rechnung als interner Notification-Empfänger
- Rechnungsnummer, Mandantenname und Bruttobetrag für die Meldung

## Entscheidungslogik

| Zustand                                                        | Ergebnis                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| Fälligkeit ist heute oder liegt in der Zukunft                 | Status nicht ändern                                           |
| Status `SENT`, Fälligkeit liegt vor heute, kein Korrekturbeleg | atomar `OVERDUE` setzen                                       |
| Status änderte sich zwischen Suche und Transaktion             | bedingtes Update trifft nicht; Audit und Meldung überspringen |
| Übergang wurde angewendet                                      | `invoice.overdue` mit Anzahl Kalendertage schreiben           |
| offene gleichartige Meldung existiert                          | Meldung aktualisieren statt duplizieren                       |
| keine offene Meldung existiert                                 | neue interne Meldung an den Ersteller anlegen                 |
| paralleler Notification-Insert kollidiert                      | Unique-Kollision idempotent behandeln                         |

## Ausnahmen und Grenzfälle

Die Anzahl überfälliger Tage wird aus Tagesgrenzen, nicht aus angefangenen
24-Stunden-Intervallen seit einem Zeitpunkt, berechnet. Eine Zahlung am
gespeicherten Fälligkeitstag löst noch keinen `OVERDUE`-Status aus.
Korrekturbelege mit negativem Forderungsbetrag werden ausgeschlossen.

## Beispiele

### Normalfall

Eine Rechnung ist am 8. Juni fällig und am 9. Juni weiterhin `SENT`. Der Worker
setzt sie auf `OVERDUE`, protokolliert einen Tag und erstellt eine interne
Meldung.

### Grenzfall

Die Rechnung wird nach der Suchabfrage, aber vor dem Transaktionsupdate als
bezahlt markiert. Das bedingte `status: SENT`-Update ändert keine Zeile; der
Worker schreibt weder ein falsches Audit-Ereignis noch eine neue Meldung.

## Umsetzung in TaxTronik

`invoice-overdue-check.ts` sucht Kandidaten mandantenweise, berechnet den
Berliner Tagesbeginn und führt ein bedingtes `SENT`-Update aus. Der
Evidence-Service und die Notification teilen denselben Tenant-Transaktionsclient.
Eine bereits offene Ressourcenmeldung wird aktualisiert.

## Bekannte Abweichungen und Grenzen

Der Produktstatus ist im beschriebenen Scope umgesetzt. Er beweist weder
Zugang der Rechnung, Nichtzahlung, Mahnung, Vertretenmüssen noch das Vorliegen
oder den Zeitpunkt des Verzugs nach § 286 BGB. Zahlungseingänge werden nicht
automatisch aus Bankdaten abgeglichen; Mahnwesen, Verzugszinsen und
Einzelfallausnahmen bleiben außerhalb dieser Regel. Scheduler- oder Queue-Ausfall
kann die Markierung verzögern.

## Fachliche Prüffragen

- Welche Zeitzone und Tagesgrenze soll für alle Kanzleistandorte gelten?
- Wie wird ein Zahlungseingang vor dem Worker-Lauf zuverlässig erfasst?
- Welche Fälle dürfen trotz überschrittenem `dueDate` nicht intern als
  überfällig geführt werden?
- Wie müssen `OVERDUE`, rechtlicher Verzug und Mahnstufe in Oberfläche und
  Verfahrensdokumentation unterschieden werden?
- Wer bearbeitet und schließt die interne Meldung?

## Technische Nachweise

Die Worker-Tests prüfen Kandidatenfilter, Tagesgrenze, Tagzählung,
Status-Recheck, gemeinsamen Transaktionsclient für Update, Audit und Meldung,
idempotente Aktualisierung, Parallelkollision und Fehlerweitergabe. Sie
beurteilen keine zivilrechtlichen Verzugsvoraussetzungen.
