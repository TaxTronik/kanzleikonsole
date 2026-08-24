---
id: DOC-OBJECT-LOCK-001
title: Geschützte Dokumentbytes mit passendem Object Lock speichern
domain: dokumente-und-aufbewahrung
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Dokumentation und Archiv
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    GOBD-Uploads erhalten COMPLIANCE-, GwG-Uploads GOVERNANCE-Lock; Bucket,
    Tenant-Präfix, Hash, Größe, Retention und Objektversion werden gegen die
    vorbereitete Absicht geprüft. Die Funktion ist ein technischer Schutz und
    keine GoBD-Konformitäts- oder Löschbescheinigung.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Dokumentenarchiv
    path: docs/development/module/dokumentenarchiv.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 146 Abs. 4 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__146.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_guidance
    citation: GoBD in amtlicher AO-Handbuchfassung 2025, insbesondere Rn. 58 bis 60 und 107 bis 113
    url: https://stberh.bundesfinanzministerium.de/ao/2025/Anhaenge/BMF-Schreiben-und-gleichlautende-Laendererlasse/Anhang-33/inhalt.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/storage/src/service.ts
  - packages/storage/src/object-lock-policy.ts
  - apps/web/src/server/documents/upload-helpers.ts
test_refs:
  - packages/storage/src/__tests__/object-lock-policy.test.ts
  - packages/storage/src/__tests__/object-version.test.ts
  - apps/web/src/server/documents/__tests__/upload-helpers.test.ts
feature_refs:
  - docs/development/module/dokumentenarchiv.md
  - docs/compliance/gobd.md
related_rules:
  - DOC-RETENTION-CLASS-001
  - DOC-UPLOAD-JOURNAL-001
  - DOC-VERSION-IMMUTABILITY-001
tags:
  - object-lock
  - speicher
  - unveraenderlichkeit
---

# DOC-OBJECT-LOCK-001 — Geschützte Dokumentbytes mit passendem Object Lock speichern

## Kurzfassung

TaxTronik schreibt GOBD-geschützte Bytes im S3-Object-Lock-Modus
`COMPLIANCE` und GwG-Bytes im Modus `GOVERNANCE`. Vorbereitete Uploads binden
Tenant, Bucket, Schlüssel, Hash, Größe und Retention; ein geschützter Commit
gilt nur mit nachweisbarer Objektversions-ID als erfolgreich. Das belegt einen
technischen Lösch-/Überschreibschutz, nicht die Ordnungsmäßigkeit des gesamten
Verfahrens.

## Wann gilt die Regel?

Die Regel gilt für Uploads mit Schutzstufe `GOBD` oder `GWG` in den dafür
konfigurierten versionierten Buckets. `NONE` erhält keinen Object Lock. Der
tatsächliche Schutz setzt voraus, dass der eingesetzte Object Store die
konfigurierte Versionierung und Lock-Semantik korrekt durchsetzt.

## Benötigte Angaben

- Tenant und Schutzstufe
- Ziel-Bucket und tenantgebundener Objektschlüssel
- SHA-256 und Bytegröße der geprüften Datei
- Retain-Until-Stichtag
- erwarteter Lock-Modus
- nach dem Commit nachweisbare Objektversions-ID
- betriebsseitig verifizierte Bucket-Konfiguration

## Entscheidungslogik

| Wenn                                                     | Dann                                                                          | Begründung                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Schutzstufe ist `GOBD`                                   | `COMPLIANCE` bis Retain-Until setzen                                          | Produktpolicy für nicht aufhebbaren technischen Schutz        |
| Schutzstufe ist `GWG`                                    | `GOVERNANCE` bis Retain-Until setzen                                          | kontrollierte spätere Pflichtvernichtung soll möglich bleiben |
| Schutzstufe ist `NONE`                                   | ohne Object Lock speichern                                                    | ungeschützte Produktklasse                                    |
| Bucket oder Tenant-Präfix weicht von der Vorbereitung ab | Commit fail-closed ablehnen                                                   | keine umgebogene Speicherabsicht                              |
| Bytes oder Größe weichen ab                              | vor dem Write ablehnen                                                        | Hashbindung der geprüften Absicht                             |
| geschützter Commit liefert keine ermittelbare Version-ID | Commit als Fehler behandeln                                                   | konkrete Objektversion muss nachweisbar sein                  |
| verlorene PUT-Antwort ist möglich                        | festen Schlüssel inventarisieren und exakt eine identische Version übernehmen | kein blindes zweites Schreiben                                |

## Ausnahmen und Grenzfälle

Ein korrekt gesetzter Lock schützt falsche Klassifikation oder falschen
Fristanker ebenfalls und kann dadurch eine unzulässige Überaufbewahrung
festschreiben. `GOVERNANCE` hängt für eine vorzeitige kontrollierte Löschung an
besonderen Berechtigungen. Emulatoren und S3-kompatible Produkte können von
der erwarteten Semantik abweichen; die Deployment-Prüfung muss den konkreten
Speicher testen. Backups und Replikate besitzen eigene Schutzanforderungen.

## Beispiele

### Normalfall

Ein GoBD-Rechnungsupload wird mit festem Tenant-Key, SHA-256 und
Achtjahresstichtag vorbereitet. Der Store bestätigt eine konkrete Version im
COMPLIANCE-Modus; genau diese Identität wird in der Dokumentversion gespeichert.

### Grenzfall

Die PUT-Antwort geht verloren. TaxTronik listet den festen Intent-Key. Nur wenn
genau eine Version mit identischen Bytes existiert, wird sie übernommen;
mehrere Versionen oder ein Delete Marker führen zum harten Fehler.

## Umsetzung in TaxTronik

`service.ts` bereitet den Commit vor, prüft Bytes und Speicherziel erneut,
setzt den stufenabhängigen Lock und löst die konkrete Version-ID auf.
`object-lock-policy.ts` bewertet die tatsächlich gemeldete Bucket-
Grundkonfiguration gegen Modus und Laufzeit. `upload-helpers.ts` persistiert
Retention und Objektidentität ohne abweichende Neuberechnung.

## Bekannte Abweichungen und Grenzen

Keine bekannte technische Abweichung innerhalb der beschriebenen
Commit-Invarianten. Die Aussage gilt nur, wenn der konkrete Object Store die
S3-Semantik tatsächlich durchsetzt und dies im Betrieb verifiziert wurde.
Nicht belegt sind fachlich richtige Klassifikation, richtiger Fristbeginn,
vollständige GoBD-Konformität, Schutz von Offsite-Kopien und eine erfolgreiche
GwG-Frühvernichtung mit Governance-Bypass.

## Fachliche Prüffragen

- Welche reale Storage-Konfiguration und welche Drill-Nachweise sind Freigabevoraussetzung?
- Ist die Trennung COMPLIANCE/GOVERNANCE für alle Dokumentarten geeignet?
- Wie werden Fehlklassifikation und zu lange irreversible Locks behandelt?
- Welche Schutz- und Löschregeln gelten für Replikate und Backups?

## Technische Nachweise

Object-Lock-Policy-Tests prüfen Modus und Defaultlaufzeit. Storage-Tests
belegen vorbereitete Hash-/Bucket-/Tenant-Invarianten, Version-ID-Auflösung,
Recovery nach verlorener Antwort und fail-closed Mehrfachversionen. Die Tests
laufen gegen Mocks und ersetzen keinen Abnahmetest des produktiven Speichers.
