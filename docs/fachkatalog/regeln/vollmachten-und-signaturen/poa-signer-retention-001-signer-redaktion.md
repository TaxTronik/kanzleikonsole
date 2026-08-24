---
id: POA-SIGNER-RETENTION-001
title: Personen- und Nachweisdaten elektronischer Vollmachten kontrolliert redigieren
domain: vollmachten-und-signaturen
rule_type: professional_interpretation
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Vollmachten und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    TaxTronik nutzt derzeit kanzleiweit einen Zehnjahresstichtag nach dem Ende
    des Mandatsjahres und redigiert danach getrennt Vollmachts-Personendaten.
    Ob diese Frist und die verbleibenden Rumpfdaten für jede Vollmacht und jeden
    Zweck rechtlich passen, ist nicht fachlich validiert.
sources:
  - kind: official_law
    citation: § 66 StBerG, Handakten und Aufbewahrung
    url: https://www.gesetze-im-internet.de/stberg/__66.html
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. e und Art. 17 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: VVT-Arbeitsvorlage, V6 elektronische Vollmachten-Bestätigung
    path: docs/compliance/vvt-template.md
    checked_at: '2026-08-24'
    primary: false
  - kind: product_documentation
    citation: Datenschutzkonzept, Aufbewahrung und Anonymisierung
    path: docs/compliance/dsgvo-konzept.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/dsgvo/client-retention.ts
  - apps/web/src/server/dsgvo/anonymize-client-data.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/actions.ts
  - packages/db/prisma/migrations/20260801003600_poa_signing_snapshot/migration.sql
test_refs:
  - apps/web/src/server/dsgvo/__tests__/client-retention.test.ts
  - apps/web/src/app/staff/(protected)/admin/dsgvo-retention/__tests__/poa-signer-actions.test.ts
  - packages/db/src/__tests__/poa-signing-integrity.test.ts
feature_refs:
  - docs/compliance/vvt-template.md
  - docs/compliance/dsgvo-konzept.md
  - FEATURES.md
related_rules:
  - CLIENT-MANDATE-LIFECYCLE-001
  - DSGVO-MANDATE-ANONYMIZATION-001
  - POA-SIGNING-SNAPSHOT-001
tags:
  - vollmacht
  - aufbewahrung
  - redaktion
  - datenschutz
---

# POA-SIGNER-RETENTION-001 — Personen- und Nachweisdaten elektronischer Vollmachten kontrolliert redigieren

## Kurzfassung

TaxTronik behandelt Vollmachtsinhalt, Unterzeichner-Kontaktdaten und technische
Bestätigungsdaten als personenbezogene Aufbewahrungsbestände. Nach dem
derzeitigen Produktmodell werden sie frühestens nach zehn vollen Kalenderjahren
ab dem Ende des Mandatsjahres manuell und protokolliert redigiert.

Diese Frist ist eine noch ungeprüfte fachliche Produktannahme. Weder § 66
StBerG noch die DSGVO rechtfertigen ohne Einzelfall- und Zweckprüfung pauschal
eine identische Speicherdauer für jede Vollmacht und jedes Signaturmetadatum.

## Wann gilt die Regel?

Die Regel gilt für im Vollmachtsmodell gespeicherte Personen-, Inhalts-, Token-,
Snapshot- und Bestätigungsdaten eines Mandanten mit gepflegtem Mandatsende. Bei
natürlichen Personen erfolgt die Redigierung im vollständigen Mandanten-
Anonymisierungspfad; für juristische Personen und Personengesellschaften gibt
es einen getrennten Vollmachts-Signer-Pfad.

Nicht entschieden wird, welche einzelne Vollmacht Bestandteil einer Handakte
ist, ob eine andere gesetzliche Frist oder ein Rechtsstreit die Speicherung
verlangt und wann das jeweilige Beweisinteresse entfällt.

## Benötigte Angaben

- Mandantentyp NATPERS, JURPERS oder PERSGES
- verifiziertes `mandateEndedAt`
- daraus berechneter Zehnjahresstichtag
- vorhandene personenbezogene Vollmachts- und Bestätigungsdaten
- offene Aufbewahrungsgründe, Rechtsstreite oder Sperrvermerke außerhalb des Produkts
- berechtigter ADMIN oder PARTNER für die ausdrückliche Bestätigung

## Entscheidungslogik

| Wenn                                                 | Dann                                                                                                  | Begründung                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Mandatsende fehlt                                    | keine Fälligkeit berechnen und keine Redigierung anbieten                                             | Fristanker fehlt                                |
| zehn volle Kalenderjahre sind noch nicht abgelaufen  | Redigierung in Anwendung und Datenbank blockieren                                                     | derzeitiger Produkt-Mindeststichtag             |
| NATPERS ist fällig                                   | Vollmachtsdaten im umfassenden Mandanten-Anonymisierungspfad redigieren                               | Personenbezug des Mandanten und der Nachweise   |
| JURPERS oder PERSGES ist fällig                      | nur noch vorhandene personenbezogene Vollmachtsdaten separat zur Bestätigung anbieten                 | Stammdatensatz der Organisation bleibt bestehen |
| ADMIN oder PARTNER bestätigt fälligen Fall           | Redaktionsmarker setzen, exakt alle noch personentragenden Vollmachten redigieren und Audit schreiben | expliziter, transaktionaler Vorgang             |
| Datenbankupdate versucht geschützte Felder zu leeren | nur mit gesetztem Marker und erreichtem DB-Stichtag zulassen                                          | Umgehung des Reviewpfads erschweren             |

## Ausnahmen und Grenzfälle

Die VVT-Arbeitsvorlage weist ausdrücklich darauf hin, dass für Vollmachten
keine pauschale Mindestaufbewahrung ohne fachliche Einordnung festgelegt ist.
Ein ADMIN-/PARTNER-Klick ist eine technische Berechtigung und keine
dokumentierte Berufsträgerfreigabe des Fristenmodells. Das Produkt enthält
keinen allgemeinen Legal-Hold-Mechanismus und keine Klassifikation je
Vollmachtstyp, Zweck oder Anspruch.

## Beispiele

### Normalfall

Das Mandat einer Personengesellschaft endet 2026. Nach dem derzeitigen Modell
erscheinen verbleibende Unterzeichnerdaten ab 1. Januar 2037 in der separaten
Reviewliste. Ein berechtigter Mitarbeiter bestätigt die Redigierung; die
Organisation bleibt als Mandant erhalten, die personenbezogenen
Vollmachtsnachweise werden entfernt.

### Grenzfall

Zu einer Vollmacht läuft am Produktstichtag noch ein Rechtsstreit oder eine
andere Pflicht verlangt den Nachweis. TaxTronik kennt diesen Umstand nicht und
bietet die Redigierung trotzdem an. Die Kanzlei muss die Aktion außerhalb des
Systems sperren und die einschlägige Frist fachlich bestimmen.

## Umsetzung in TaxTronik

`client-retention.ts` berechnet den Stichtag als 1. Januar nach zehn vollen
Kalenderjahren ab dem Jahr des Mandatsendes. Der NATPERS-Pfad anonymisiert den
Mandanten samt personentragender Nebentabellen. JURPERS und PERSGES erhalten
eine eigene Reviewliste; die Action prüft Rolle, Stichtag und aktuelle Anzahl,
setzt einen Redaktionsmarker und redigiert in derselben Transaktion die
Vollmachten. Ein Datenbanktrigger schützt die signaturbezogenen Felder vor
vorzeitiger Änderung.

Redigiert werden insbesondere Name und Kontakt des Unterzeichners, Betreff und
Umfang, Link-/OTP-Daten, Snapshot und Hashes, Signaturzeitpunkt, IP,
User-Agent, Dokumentreferenz und Widerrufsgrund. Status, Gültigkeitsdaten und
technische Erstellungsreferenzen bleiben als Rumpfdaten bestehen.

## Bekannte Abweichungen und Grenzen

Der Implementierungsstatus ist **teilweise**. Die einheitliche Zehnjahresfrist
ist nicht je Vollmachtstyp, Datenkategorie und Zweck fachlich validiert. Es
fehlen Legal Hold, konkurrierende Fristen und ein dokumentierter
Berufsträgerentscheid. Umgekehrt ist nicht geklärt, ob die verbleibenden
Rumpf- und Auditdaten nach Fristende weiter gespeichert werden dürfen.

Die Redigierung beseitigt bewusst auch den gebundenen Snapshot und technische
Signaturmetadaten und reduziert damit den späteren Nachweis. Backup- und
Replikatfristen sind nicht Teil der interaktiven Action. Die rechtliche
Wirksamkeit oder fortbestehende Bedeutung einer Vollmacht — der ausgeschlossene
Scope `POA-LEGAL-VALIDITY-001` — wird nicht automatisch geprüft.

## Fachliche Prüffragen

- Welche Vollmachts- und Nachweisdaten gehören im jeweiligen Fall zur Handakte?
- Welche Frist gilt je Vollmachtstyp, Zweck und Datenkategorie tatsächlich?
- Welche Legal-Hold- und Freigabemechanismen sind erforderlich?
- Welche minimalen Rumpf- und Auditdaten dürfen nach der Redigierung bestehen bleiben?
- Wie werden Backups, Replikate und exportierte Nachweise einbezogen?

## Technische Nachweise

Retention-Tests belegen Stichtagsberechnung, Mandantentypen und Auswahl der
noch personentragenden Vollmachten. Action-Tests belegen Rollen-, Fälligkeits-
und Zählprüfung sowie Marker, Redigierung und Audit in einer Transaktion.
Datenbanktests belegen den Trigger-Schutz und die exakten Redaktionsfelder.
Nicht technisch nachweisbar sind Rechtsgrundlage, fachlich richtige Dauer und
die Zulässigkeit der verbleibenden Daten.
