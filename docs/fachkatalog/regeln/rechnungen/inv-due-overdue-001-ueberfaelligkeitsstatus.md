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
  summary: Der Tagesjob setzt versendete unbezahlte Rechnungen ab dem Tag nach dem gespeicherten Fälligkeitsdatum idempotent auf OVERDUE und erzeugt Audit sowie eine interne Meldung an den aktiven, berechtigten Ersteller, ersatzweise an die aktiven, berechtigten ADMIN/PARTNER.
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
  - apps/web/src/app/staff/(protected)/invoices/page.tsx
  - apps/worker/src/notification-recipients.ts
test_refs:
  - apps/worker/src/jobs/__tests__/invoice-overdue-check.test.ts
  - apps/worker/src/__tests__/notification-recipients.test.ts
  - apps/web/src/app/staff/(protected)/invoices/__tests__/page.test.tsx
  - apps/e2e/tests/12-accessibility.spec.ts
feature_refs:
  - docs/development/module/fakturierung.md
  - docs/anwenderdoku/rechnungen.md
related_rules:
  - INV-LIFECYCLE-FREEZE-001
  - INV-STORNO-REFERENCE-001
  - ACCESS-NOTIFICATION-RECIPIENT-001
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
Wiederholung nicht dupliziert. Die Meldung erhält der Ersteller der Rechnung,
solange er aktiv und für den Mandanten berechtigt ist; andernfalls erhalten sie
die aktiven, für den Mandanten berechtigten ADMIN/PARTNER der Kanzlei. Der
Produktstatus ist keine abschließende rechtliche Feststellung des
Schuldnerverzugs.

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
- Ersteller der Rechnung, sein Aktivstatus und sein aktueller Mandantenzugriff
  (OPEN/RESTRICTED, Vertraulichkeit)
- ersatzweise die aktiven ADMIN/PARTNER des Tenants mit aktuellem
  Mandantenzugriff
- Rechnungsnummer, Mandantenname und Bruttobetrag für die Meldung

## Entscheidungslogik

| Zustand                                                        | Ergebnis                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| Fälligkeit ist heute oder liegt in der Zukunft                 | Status nicht ändern                                           |
| Status `SENT`, Fälligkeit liegt vor heute, kein Korrekturbeleg | atomar `OVERDUE` setzen                                       |
| Status änderte sich zwischen Suche und Transaktion             | bedingtes Update trifft nicht; Audit und Meldung überspringen |
| Übergang wurde angewendet                                      | `invoice.overdue` mit Anzahl Kalendertage schreiben           |
| Ersteller aktiv und für den Mandanten berechtigt               | Meldung an den Ersteller                                      |
| Ersteller inaktiv, nicht vorhanden oder ohne Mandantenzugriff  | Meldung an alle aktiven, berechtigten ADMIN/PARTNER           |
| kein berechtigter Empfänger                                    | Status und Audit wie oben; keine Meldung, Warnung im Log      |
| offene gleichartige Meldung des Empfängers existiert           | Meldung aktualisieren statt duplizieren                       |
| keine offene Meldung des Empfängers existiert                  | neue interne Meldung für diesen Empfänger anlegen             |
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
Eine bereits offene Ressourcenmeldung desselben Empfängers wird aktualisiert.

Die Empfänger löst seit der Produktentscheidung vom 2026-10-07 derselbe
Empfängerfilter wie bei GwG- und Vollmachtswarnungen in derselben Transaktion
auf (`resolveClientWarningRecipientsTx`, ACCESS-NOTIFICATION-RECIPIENT-001): Der
Ersteller zählt nur, solange er aktiv ist und nach der aktuellen
OPEN-/RESTRICTED-/Vertraulichkeitsregel auf den Mandanten zugreifen darf.
Andernfalls erhalten alle aktiven ADMIN/PARTNER mit diesem Zugriff je eine
Meldung. Zuvor blieb die Meldung bei einem deaktivierten Ersteller unbeachtet.
Gibt es keinen berechtigten Empfänger, werden Status und Audit trotzdem gesetzt
und der Worker protokolliert eine Warnung ohne Personen- oder Mandantendaten.

Die Staff-Rechnungsübersicht verwendet für noch als `SENT` gespeicherte Rechnungen
dieselbe Berliner Kalendertagesgrenze wie Worker und Portalübersicht. Der gemeinsame
Helfer `berlinTodayUtcMidnight` aus `@taxtronik/tax` liefert den Berliner Tag als
UTC-Mitternacht passend zu `dueDate` als `@db.Date`. Dieser Tageswert wird einmal
je Seitenaufruf berechnet. Die Anzeige kann dadurch ab dem Folgetag bereits vor
dem nächsten Worker-Lauf „Überfällig“ zeigen; sie schreibt weder Rechnungsstatus
noch Audit oder Benachrichtigungen. Gespeicherte andere Status bleiben erhalten.

Die Rechnungsübersicht lässt auf schmalen Bildschirmen Kopfzeile und Statusfilter
umbrechen. Die Tabelle bleibt in einer eigenen benannten, per Tastatur
erreichbaren Region horizontal scrollbar; die Seitennavigation steht außerhalb
dieses Scrollbereichs. Der Accessibility-Test prüft bei 320 CSS-Pixeln auf
Seitenüberlauf einschließlich des Hauptinhalts. Die Layoutanpassung ändert weder
Statusberechnung noch Filter, Berechtigungen oder Rechnungsaktionen.

## Bekannte Abweichungen und Grenzen

Der am 14. September 2026 festgestellte Konflikt zwischen Regel und Staff-Anzeige
ist korrigiert: Die Übersicht verglich `dueDate` bisher mit dem aktuellen
Zeitpunkt statt dem Berliner Kalendertag. Dadurch erschien eine heute fällige
`SENT`-Rechnung bereits tagsüber als überfällig, obwohl die Regel dies erst ab
dem Folgetag vorsieht. Die Korrektur gleicht die Anzeige an die bestehende Regel
an und stellt keine fachliche Freigabe dar.

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
idempotente Aktualisierung, Parallelkollision und Fehlerweitergabe. Mit dem
echten Empfängerfilter prüfen sie außerdem den aktiven Ersteller, den Fallback
auf aktive ADMIN/PARTNER bei inaktivem, fehlendem oder nicht mehr berechtigtem
Ersteller, den Ausschluss nicht berechtigter ADMIN/PARTNER, die Aktualisierung
offener Meldungen je Empfänger und den Fall ohne Empfänger. Sie beurteilen keine
zivilrechtlichen Verzugsvoraussetzungen.

Die SSR-Tests der echten Staff-Rechnungsseite verwenden den unveränderten
gemeinsamen Datumshilfsdienst. Sie prüfen Fälligkeitstag und Folgetag an den
exakten CET-/CEST-Tagesgrenzen, die 23- und 25-Stunden-Tage der Zeitumstellung,
zukünftige Fälligkeit, abweichende Serverzeitzonen sowie die unveränderte Anzeige
von `DRAFT`, `PAID`, `CANCELLED` und `OVERDUE`.
