---
id: CLIENT-MANDATE-LIFECYCLE-001
title: Mandatsende auditieren und als nachgelagerten Workflow-Anker verwenden
domain: mandat-und-zugriff
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Mandats- und Aufbewahrungsorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    ADMIN/PARTNER können das aktuelle Mandatsende setzen oder zurücknehmen;
    beide Änderungen werden auditiert und steuern GwG-/DSGVO-Queues sowie
    einzelne Neuanlage-Gates. Ein einheitlicher Schreib-, Portal- und
    Wiederaufnahme-Backstop für alle Module fehlt.
sources:
  - kind: product_documentation
    citation: DSGVO-Konzept, Mandatsende und nachgelagerte Anonymisierung
    path: docs/compliance/dsgvo-konzept.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 66 Abs. 1 bis 4 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__66.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. e sowie Art. 17 Abs. 1 und 3 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/clients/[id]/edit/actions.ts
  - apps/web/src/server/dsgvo/client-retention.ts
  - apps/web/src/app/staff/(protected)/poa/actions.ts
  - packages/db/prisma/migrations/20260723000000_iter73_client_mandate_ended_at/migration.sql
test_refs:
  - apps/web/src/server/dsgvo/__tests__/client-retention.test.ts
  - apps/web/src/app/staff/(protected)/poa/__tests__/actions.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/dsgvo-konzept.md
related_rules:
  - DSGVO-MANDATE-ANONYMIZATION-001
  - GWG-RETENTION-DESTRUCTION-001
  - POA-SIGNER-RETENTION-001
tags:
  - mandatsende
  - wiederaufnahme
  - retention
---

# CLIENT-MANDATE-LIFECYCLE-001 — Mandatsende auditieren und als nachgelagerten Workflow-Anker verwenden

## Kurzfassung

TaxTronik speichert ein Mandatsende am Mandanten, protokolliert Setzen und
Zurücknehmen und nutzt den Zeitpunkt als Anker für Aufbewahrungs- und
Anonymisierungsvorschläge. Eine Wiederaufnahme setzt den Wert auf null. Das
Feld ist derzeit kein einheitlicher terminaler Status für alle Fachmodule.

## Wann gilt die Regel?

Die Regel gilt für die manuelle ADMIN/PARTNER-Aktion am Mandanten und für
Funktionen, die `mandateEndedAt` ausdrücklich auswerten. Ob ein Auftrag
tatsächlich beendet oder wiederaufgenommen wurde, entscheidet die Kanzlei;
TaxTronik leitet dies nicht aus Kommunikation oder Aktenaktivität ab.

## Benötigte Angaben

- Mandant und Tenant
- berechtigte ADMIN/PARTNER-Person
- tatsächliches Auftrags- beziehungsweise Mandatsende
- Entscheidung über Wiederaufnahme
- offene Akten, Verfahren, Beweise und Spezialfristen
- bereits gestartete Retention- oder Redaktionsprozesse

## Entscheidungslogik

| Wenn                                                 | Dann                                                   | Begründung                             |
| ---------------------------------------------------- | ------------------------------------------------------ | -------------------------------------- |
| Mandat wird erstmals beendet                         | aktuellen Serverzeitpunkt speichern und auditieren     | Produktanker für Folgeprozesse         |
| Mandatsende ist bereits gesetzt und erneut bestätigt | ursprünglichen gespeicherten Zeitpunkt behalten        | Fristanker nicht unbemerkt verschieben |
| Mandat wird wieder aufgenommen                       | `mandateEndedAt` auf null setzen und Reopen auditieren | Folgequeues stoppen                    |
| Mandatsende fehlt                                    | keine mandatsende-basierte Anonymisierung anbieten     | notwendiger Fristanker fehlt           |
| neues PoA-Objekt an beendetem Mandat                 | Neuanlage verweigern                                   | konkret implementiertes Folge-Gate     |
| anderer Fachpfad prüft das Feld nicht                | keine Sperrwirkung behaupten                           | derzeit uneinheitlicher Scope          |

## Ausnahmen und Grenzfälle

Die Oberfläche setzt immer den Zeitpunkt der Bedienhandlung; ein abweichendes
historisches Enddatum kann dort nicht erfasst werden. Das Mandatsende
deaktiviert den Mandanten nicht automatisch, beendet keine Portal-Sessions und
schließt nicht pauschal offene Anforderungen. Eine Wiederaufnahme nach bereits
erfolgter Vernichtung oder Anonymisierung stellt Daten nicht wieder her.

## Beispiele

### Normalfall

Ein ADMIN beendet das Mandat am tatsächlichen Endtag. Das Audit erhält
`client.mandate.end`; spätere GwG- und DSGVO-Queues berechnen ihre
Produktstichtage aus dem gespeicherten Jahr.

### Grenzfall

Das Mandat endete vor Monaten, wird aber erst heute im System markiert. Die
Software speichert heute und verschiebt damit den Produktstichtag. Das muss
vor einer Retention-Entscheidung fachlich korrigiert oder anderweitig
dokumentiert werden; die Action bietet keine Rückdatierung.

## Umsetzung in TaxTronik

`setMandateEndAction` ist ADMIN/PARTNER-beschränkt, prüft Mandantenzugriff und
schreibt Änderung plus Audit in einer Tenant-Transaktion. Die Retention-Helfer
berechnen aus dem Jahresende Stichtage. Der PoA-Anlagepfad sperrt beendet oder
anonymisiert markierte Mandate vor und während der unveränderbaren Ablage.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Es fehlen ein editierbares fachliches Enddatum,
ein einheitlicher Mandatsstatus, ein zentraler Backstop für alle nachgelagerten
Schreibpfade und eine definierte Wiederaufnahme nach bereits begonnenen
Retentionmaßnahmen. `ADMIN/PARTNER` beweist keine Berufsträgerqualifikation.

## Fachliche Prüffragen

- Muss das tatsächliche, gegebenenfalls historische Enddatum erfassbar sein?
- Welche Portal-, Lese- und Schreibpfade müssen bei Mandatsende gesperrt bleiben?
- Welche offenen Vorgänge werden geschlossen, übertragen oder nur schreibgeschützt?
- Wann ist eine Wiederaufnahme trotz Retention- oder Redaktionsschritten zulässig?

## Technische Nachweise

Die Retention-Tests belegen die Stichtagsberechnung mit und ohne Mandatsende.
PoA-Actiontests belegen ein konkretes Neuanlage-Gate und dessen
Parallelitätsschutz. Ein durchgängiger Test sämtlicher Module existiert nicht;
deshalb bleibt der Status teilweise.
