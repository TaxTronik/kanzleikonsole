---
id: AUDIT-RFC3161-ANCHOR-001
title: Audit-Spitzen mit geprüften RFC-3161-Zeitankern koppeln
domain: audit-und-assurance
rule_type: technical_standard
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Compliance und Verfahrensdokumentation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: Externe RFC-3161-Antworten werden kryptografisch und gegen konfigurierte Vertrauensanker geprüft; lokale Stempel bleiben als nicht externe Evidenz erkennbar.
sources:
  - kind: technical_standard
    citation: IETF RFC 3161, Internet X.509 Public Key Infrastructure Time-Stamp Protocol
    url: https://www.rfc-editor.org/rfc/rfc3161.html
    checked_at: '2026-08-24'
    primary: true
  - kind: technical_standard
    citation: IETF RFC 5816, ESSCertIDv2 Update for RFC 3161
    url: https://www.rfc-editor.org/rfc/rfc5816.html
    checked_at: '2026-08-24'
    primary: false
  - kind: product_documentation
    citation: Technische Modulbeschreibung Audit-Protokollierung, externe Anchor-Kette und Tagesversiegelung
    path: docs/development/module/audit-protokollierung.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/evidence/src/service.ts
  - packages/evidence/src/ports/rfc3161-verify.ts
  - apps/worker/src/jobs/audit-anchor.ts
  - apps/worker/src/jobs/evidence-seal.ts
test_refs:
  - packages/evidence/src/__tests__/rfc3161-verify.test.ts
  - packages/evidence/src/__tests__/service-verifychain.test.ts
  - packages/evidence/src/__tests__/service-seal-trust.test.ts
  - apps/worker/src/jobs/__tests__/evidence-seal.test.ts
feature_refs:
  - docs/development/module/audit-protokollierung.md
  - docs/adr/0004-evidence-chain-mit-rfc3161.md
related_rules:
  - AUDIT-HASH-CHAIN-001
  - AUDIT-VERIFY-ALERT-001
  - AUDIT-ARCHIVE-001
tags:
  - audit
  - rfc3161
  - tsa
  - zeitanker
---

# AUDIT-RFC3161-ANCHOR-001 — Audit-Spitzen mit geprüften RFC-3161-Zeitankern koppeln

## Kurzfassung

TaxTronik kann Spitzen der lokalen Audit-Kette und Tagesabschlüsse mit
RFC-3161-Antworten verankern. Eine Antwort gilt erst nach Prüfung von
Message-Imprint, CMS-Signatur, Zertifikatskette, Timestamping-EKU,
Zertifikatsbindung und Erzeugungszeit als vertrauenswürdiger externer Anker.
Lokale Entwicklungsstempel werden nicht als externe Evidenz ausgegeben.

## Wann gilt die Regel?

Die Regel gilt für Rolling Anchors und Tagesversiegelungen, wenn eine TSA oder
der transparente lokale Entwicklungsadapter konfiguriert ist. Im
Produktionsmodus kann die Policy externe TSA-Evidenz verlangen. Das lokale
Audit-Schreiben bleibt bei TSA-Ausfall verfügbar; der ausstehende externe
Nachweis wird getrennt sichtbar.

## Benötigte Angaben

- zu verankernder SHA-256-Message-Imprint
- DER-kodierte RFC-3161-Antwort
- erwarteter Hashalgorithmus und erwarteter Imprint
- konfigurierte TSA-Vertrauensanker
- Kennzeichnung, ob der Adapter externe oder lokale Evidenz liefert
- bei Rolling Anchors der gebundene Audit-ID-Bereich und vorherige Ankerhash

## Entscheidungslogik

| Prüfung                                                                    | Ergebnis                                                                  |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| TSA-Status ist nicht erfolgreich                                           | Antwort ablehnen                                                          |
| Message-Imprint oder Algorithmus weicht ab                                 | Antwort ablehnen                                                          |
| CMS-Signatur oder Signer-Zertifikatsbindung scheitert                      | Antwort ablehnen                                                          |
| Vertrauenskette, Gültigkeitszeit oder exklusive Timestamping-EKU scheitert | nicht als vertrauenswürdigen externen Anker werten                        |
| lokaler Adapter bei verlangter externer TSA                                | lokalen Nachweis erhalten, Policy-Verstoß melden                          |
| TSA vorübergehend nicht erreichbar                                         | Fachschreiben nicht blockieren; Rückstand bzw. Fehlerzustand persistieren |
| parallele Rolling-Anchor-Versuche                                          | nur einen Nachfolger der gespeicherten Ankerspitze zulassen               |

## Ausnahmen und Grenzfälle

Die Vertrauenskette wird für die im Token enthaltene `genTime` geprüft. Eine
gültige TSA-Zeit bescheinigt die Existenz des abgedeckten Imprints spätestens
zu diesem Zeitpunkt, nicht den exakten Zeitpunkt jedes gebundenen
Fachereignisses. Ein kryptografisch lesbarer Token ohne vertrauenswürdige Kette
ist kein erfolgreicher externer Vertrauensnachweis.

## Beispiele

### Normalfall

Der Worker sendet den Payload der aktuellen Audit-Spitze an eine externe TSA.
Die Antwort bindet den erwarteten SHA-256-Imprint, besitzt eine gültige
Timestamping-Zertifikatskette und wird als nächster gekoppelter Anker
gespeichert.

### Grenzfall

Die TSA ist nicht erreichbar. Neue Fachereignisse werden weiter in die lokale
Hash-Kette geschrieben; der Worker hält den ausstehenden Präfix fest und
versucht die externe Verankerung später erneut.

## Umsetzung in TaxTronik

`rfc3161-verify.ts` zerlegt und prüft die Antwort. `service.ts` bindet lokale
Spitze, ID-Bereich und vorherigen Token in Rolling Anchors beziehungsweise den
Tagesspitzen-Hash in Tagesversiegelungen. Die Worker führen Netzwerkaufrufe
außerhalb der Fachtransaktion aus und persistieren Erfolg oder Rückstand
explizit.

## Bekannte Abweichungen und Grenzen

Die Implementierung ist nur teilweise als externer Nachweis wirksam: Ohne
erreichbare TSA und korrekt gepflegte Trust Roots bleibt lediglich lokale
Evidenz. Der Produktionsmodus meldet diesen Zustand als Policy-Verstoß, ersetzt
ihn aber nicht durch einen behaupteten externen Nachweis. Eine laufende
OCSP-/CRL-Abfrage und eine umfassende Langzeitvalidierung nach Ende der
Zertifikatsgültigkeit sind in diesem Prüfpfad nicht implementiert.

## Fachliche Prüffragen

- Welche TSA und welche Trust Roots sind für die konkrete Installation
  freigegeben?
- Welche maximale Zeitspanne ohne externen Anker ist organisatorisch zulässig?
- Welche Sperr- und Langzeitvalidierungsnachweise müssen zusätzlich archiviert
  werden?
- Ist die Bedeutung der TSA-Zeit gegenüber dem lokalen Ereigniszeitpunkt in
  Verfahrens- und Anwenderdokumentation ausreichend abgegrenzt?

## Technische Nachweise

Die RFC-Fixture- und Negativtests prüfen Imprint, Signatur, Zertifikatskette,
EKU und Trust-Policy. Service- und Worker-Tests prüfen die Bindung an die
rekonstruierte Kettenspitze, lokales gegenüber externem Vertrauen, Backfill und
Fehlerbehandlung.
