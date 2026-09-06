---
id: INV-TIME-ENTRY-CLAIM-001
title: Zeiteinträge atomar genau einem Rechnungsentwurf zuordnen
domain: rechnungen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Honorar und Rechnungswesen
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: Abrechenbare freie Zeiteinträge werden in derselben Transaktion vollständig geclaimt; verliert der Lauf auch nur einen Claim, rollen Rechnung und Nummernvergabe zurück. Der Leistungszeitraum verwendet die Berlin-Kalendertage der frühesten Start- und spätesten Endzeit.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, Stundenabrechnung und Parallel-Claim
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Anwenderdokumentation Rechnungen, Zeiteinträge übernehmen
    path: docs/anwenderdoku/rechnungen.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/invoicing/time-billing.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/billing/actions.ts
test_refs:
  - apps/web/src/server/invoicing/__tests__/time-billing.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/billing/__tests__/actions.test.ts
  - packages/db/src/__tests__/invoice-festschreibung.test.ts
feature_refs:
  - docs/development/module/fakturierung.md
  - docs/anwenderdoku/rechnungen.md
related_rules:
  - INV-NUMBER-ALLOCATION-001
  - INV-VAT-TOTALS-001
  - INV-LIFECYCLE-FREEZE-001
tags:
  - rechnung
  - zeiterfassung
  - concurrency
  - claim
---

# INV-TIME-ENTRY-CLAIM-001 — Zeiteinträge atomar genau einem Rechnungsentwurf zuordnen

## Kurzfassung

Beim Erstellen einer Rechnung aus Zeiten berücksichtigt TaxTronik nur
abgeschlossene, abrechenbare und noch keiner Rechnung zugeordnete Einträge des
gewählten Mandanten. Nach Anlage des Entwurfs beansprucht ein bedingtes
Sammelupdate alle ausgewählten IDs. Werden nicht alle Einträge gewonnen, bricht
die Transaktion ab und rollt Rechnung sowie Nummernvergabe vollständig zurück.

## Wann gilt die Regel?

Die Regel gilt für die Action „Rechnung aus Zeiteinträgen“ im aktivierten
In-App-Rechnungs- und Zeiterfassungsmodus. Sie schützt die technische
Einmalzuordnung bei parallelen Abrechnungsläufen. Sie entscheidet nicht, ob
eine Zeit tatsächlich mandatsbezogen, erforderlich oder nach Honorarrecht
abrechenbar ist.

## Benötigte Angaben

- Mandanten-ID und autorisierter Mitarbeiter
- abgeschlossene, als abrechenbar markierte Zeiteinträge mit `invoiceId = null`
- optional ausgewählte Eintrags-IDs
- Beginn, Ende, Beschreibung und individueller oder vorgegebener Stundensatz
- Positionsstrategie Einzelzeilen oder Sammelposition
- Rechnungs-, Fälligkeits- und Steuerangaben
- neu angelegte Rechnungs-ID innerhalb derselben Transaktion

## Entscheidungslogik

| Ausgangslage                                        | Ergebnis                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| kein passender freier Eintrag                       | Rechnungsanlage ablehnen                                                                                                          |
| passende Einträge vorhanden                         | Dauer und Betrag berechnen und Entwurf in derselben Transaktion anlegen                                                           |
| Leistungszeitraum wird aus Zeitpunkten gebildet     | frühesten Start und spätestes Ende nach Europe/Berlin auf Kalendertage abbilden; UTC-Mitternacht als Datenbankkodierung speichern |
| Detailstrategie                                     | je Eintrag Pauschalmenge 1 mit Dauer und Satz im Text bilden                                                                      |
| Sammelstrategie                                     | eine Pauschalposition mit Summenbetrag bilden                                                                                     |
| alle ausgewählten IDs haben noch `invoiceId = null` | alle auf die neue Rechnungs-ID setzen und Transaktion fortsetzen                                                                  |
| mindestens eine ID wurde parallel gewonnen          | Fehler auslösen und gesamte Transaktion zurückrollen                                                                              |
| wirksam korrigiertes unbezahltes Original           | verknüpfte Zeiten erst nach erfolgreichem Korrekturbeleg wieder freigeben                                                         |

## Ausnahmen und Grenzfälle

Die Positionsmenge ist bewusst 1, weil eine auf zwei Stellen gespeicherte
Stundenmenge beispielsweise zehn Minuten nicht exakt als ein Sechstel abbilden
kann. Dauer und Stundensatz bleiben deshalb im Beschreibungstext sichtbar,
während der berechnete Betrag als Pauschalpreis übernommen wird. Bezahlte und
später korrigierte Rechnungen geben Zeiteinträge nicht automatisch frei.

Die Abrechnungsdauer bleibt die tatsächlich verstrichene Zeit zwischen den
UTC-Zeitpunkten. Nur die Leistungsdatumsfelder werden nach Europe/Berlin auf
Kalendertage umgerechnet. Eine Beratung am 06.09.2026 von 00:30 bis 01:30 Uhr
lokaler Zeit hat deshalb den Leistungszeitraum 06.09.–06.09., obwohl beide
Zeitpunkte in UTC noch auf den 05.09. fallen. Sommerzeitwechsel verändern
nicht die gemessene Dauer und werden bei der Datumsumrechnung berücksichtigt.

## Beispiele

### Normalfall

Zwei freie Zeiteinträge werden gelesen, zu Positionen verdichtet und nach
Entwurfsanlage gemeinsam auf dessen ID gesetzt. Das Sammelupdate trifft beide
IDs; Audit-Ereignis und Commit schließen den Vorgang ab.

### Grenzfall

Zwei Bearbeiter rechnen dieselben Zeiten parallel ab. Einer gewinnt die
bedingte Zuordnung. Beim anderen trifft das Sammelupdate weniger Zeilen als
gelesen; seine Transaktion verwirft Entwurf, Positionen und Zählererhöhung.

## Umsetzung in TaxTronik

`time-billing.ts` erzeugt rechenfeste Positionen und führt den bedingten
`invoiceId: null`-Claim aus. Die Billing-Action filtert Mandant,
Abrechenbarkeit, Abschluss und freie Zuordnung, berechnet Leistungszeitraum und
Beträge, legt den Entwurf an und behandelt einen unvollständigen Claim als
transaktionsabbrechenden Fachfehler.
Vor Speicherung des Leistungszeitraums bildet `berlinCalendarDate` die
Zeitpunkte auf die UTC-Mitternachtskodierung des tatsächlichen Berlin-Tags ab.

## Bekannte Abweichungen und Grenzen

Die atomare Einmalzuordnung ist umgesetzt. Die Anwendung prüft jedoch nicht
materiell, ob Beschreibung, Zeitaufwand, Stundensatz oder gewählte
Positionsstrategie nach Mandatsvereinbarung, StBVV oder sonstigem Gebührenrecht
richtig und durchsetzbar sind. Eine verlorene Parallelzuordnung wird vollständig
abgebrochen, aber nicht automatisch fachlich zusammengeführt.

## Fachliche Prüffragen

- Welche Zeitarten und Tätigkeiten dürfen nach Mandat und Gebührenrecht
  abgerechnet werden?
- Wer prüft Beschreibung, Dauer, Stundensatz und Leistungszeitraum vor Versand?
- Ist die Pauschalmenge 1 mit Transparenz im Positionstext für alle
  Rechnungsarten geeignet?
- Unter welchen Bedingungen dürfen Zeiten nach Korrektur erneut freigegeben
  werden?
- Welche Änderungen an bereits geclaimten Zeiten sind vor Festschreibung
  zulässig und zu protokollieren?

## Technische Nachweise

Die Unit-Tests prüfen Positionsarithmetik, Sammel- und Detailstrategie, den
bedingten Claim und den Verlust einer Teilmenge. Der DB-Integrationstest lässt
zwei Rechnungen denselben freien Eintrag parallel beanspruchen und erwartet
genau einen Gewinner. Die Billing-Action behandelt einen unvollständigen Claim
als Rollback-Auslöser.
Der direkte Billing-Action-Test prüft den gespeicherten Leistungszeitraum bis
zur CII-Ausgabe anhand unabhängiger Erwartungstage für Sommer-/Winternacht,
beide Sommerzeitwechsel und den Jahreswechsel. Zugleich bleibt die
Abrechnung der tatsächlichen Dauer unverändert. Die Datenbank ist hierbei
ein Testdouble; eine reale Datenbank-/Versandabnahme ist ein eigener Nachweis.
