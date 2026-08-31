---
id: AUDIT-HASH-CHAIN-001
title: Audit-Ereignisse je Kanzlei-Tenant kanonisch verketten
domain: audit-und-assurance
rule_type: product_rule
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
  status: implemented
  summary: Der Evidence-Service bildet pro Kanzlei-Tenant eine serialisierte SHA-256-Kette über kanonische Audit-Ereignisse und prüft sie mit derselben Abbildung nach.
sources:
  - kind: product_documentation
    citation: Technische Modulbeschreibung Audit-Protokollierung, Mechanik der Hash-Kette
    path: docs/development/module/audit-protokollierung.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: ADR 0004, Manipulationsevidenz durch Hash-Kette und RFC 3161
    path: docs/adr/0004-evidence-chain-mit-rfc3161.md
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/admin/audit/page.tsx
  - packages/evidence/src/service.ts
  - packages/evidence/src/chain.ts
  - packages/evidence/src/canonical-json.ts
  - apps/web/src/server/audit/query.ts
  - apps/web/src/app/api/staff/admin/audit/export/route.ts
test_refs:
  - packages/evidence/src/__tests__/service-record.test.ts
  - packages/evidence/src/__tests__/hash-chain.test.ts
  - packages/evidence/src/__tests__/canonical-json.property.test.ts
  - apps/web/src/server/audit/__tests__/query.test.ts
  - apps/web/src/app/api/staff/admin/audit/export/__tests__/route.test.ts
feature_refs:
  - docs/development/module/audit-protokollierung.md
  - docs/adr/0004-evidence-chain-mit-rfc3161.md
related_rules:
  - AUDIT-RFC3161-ANCHOR-001
  - AUDIT-VERIFY-ALERT-001
  - AUDIT-ARCHIVE-001
tags:
  - audit
  - hashkette
  - manipulationsevidenz
---

# AUDIT-HASH-CHAIN-001 — Audit-Ereignisse je Kanzlei-Tenant kanonisch verketten

## Kurzfassung

TaxTronik schreibt über den Evidence-Service Audit-Ereignisse in eine eigene
Kette je Kanzlei-Tenant. Jeder Kettenwert bindet den Vorgänger und eine
deterministisch kanonisierte Darstellung von Zeitpunkt, Tenant, Akteur, Aktion,
Ressource sowie Vorher- und Nachherzustand. Schreiben und spätere Prüfung
verwenden dieselbe Hash-Abbildung.

## Wann gilt die Regel?

Die Regel gilt, wenn ein fachlicher oder administrativer Schreibpfad den
`EvidenceService.record()` innerhalb seiner Datenbanktransaktion aufruft. Sie
beschreibt die Integrität der so aufgezeichneten Ereignisse. Sie beweist nicht,
dass jeder denkbare Schreibpfad bereits ein Audit-Ereignis erzeugt.

## Benötigte Angaben

- ID des Kanzlei-Tenants (`tenantId`), nicht die ID eines Mandanten/Clients
- Akteurtyp und, soweit vorhanden, Akteur-ID
- Aktionskennung
- Ressourcentyp und Ressourcen-ID
- optionaler Vorher- und Nachherzustand
- Ereigniszeitpunkt oder der vom Service gesetzte aktuelle Zeitpunkt
- letzter Kettenwert desselben Kanzlei-Tenants

## Entscheidungslogik

| Ausgangslage                                       | Ergebnis                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Erstes Ereignis eines Kanzlei-Tenants              | tenantspezifischen Genesis-Wert als Vorgänger verwenden          |
| Vorgänger existiert                                | dessen `thisHash` als `prevHash` des neuen Ereignisses binden    |
| Zwei Schreiber desselben Kanzlei-Tenants           | per transaktionsgebundenem Advisory Lock serialisieren           |
| Objekt enthält unterschiedlich sortierte Schlüssel | Schlüssel kanonisch sortieren und identisch serialisieren        |
| Nicht endliche Zahl oder nicht unterstützter Wert  | Kanonisierung ablehnen statt einen mehrdeutigen Hash zu erzeugen |
| Nachrechnung weicht ab                             | Kettenprüfung als fehlerhaft melden                              |

## Ausnahmen und Grenzfälle

`BigInt` wird als Dezimaltext, binäre Daten werden hexadezimal und Datumswerte
werden als ISO-Zeitpunkt kanonisiert. IP-Adresse und User-Agent können am
Audit-Datensatz stehen, gehören aber bewusst nicht zum gehashten Ereignis.
Ereignisse verschiedener Kanzlei-Tenants bilden getrennte Ketten.

## Beispiele

### Normalfall

Eine Rechnung wird in einer Tenant-Transaktion versendet. Derselbe
Transaktionsclient schreibt `invoice.send`; der neue Audit-Wert bindet die
vorherige Spitze dieses Kanzlei-Tenants und den Statuswechsel.

### Grenzfall

Zwei Transaktionen wollen gleichzeitig Audit-Ereignisse für denselben
Kanzlei-Tenant schreiben. Der Advisory Lock ordnet beide Inserts, sodass genau
eine lineare Vorgängerfolge entsteht.

## Umsetzung in TaxTronik

`service.ts` setzt Zeitpunkt und Vorgänger unter dem Tenant-Lock und schreibt
den Audit-Datensatz. `canonical-json.ts` normalisiert den Ereignisinhalt;
`chain.ts` berechnet Genesis- und Folgewerte. Die Verifikation rekonstruiert
dieselbe Ereignisform aus den gespeicherten Spalten.

Die zentrale ADMIN/PARTNER-Ansicht und ihr CSV-Export können die unveränderten
Ereignisse nach fachlichen Bereichen filtern und in auf- oder absteigender
Audit-ID-Folge anzeigen. Die Bereiche sind eine Leseprojektion der bekannten
Aktionskennungen; unbekannte historische Kennungen bleiben unter „Sonstige“
sichtbar. Ein GwG-Filter ist keine Behauptung, alle rechtlich relevanten Vorgänge
zu erfassen, insbesondere nicht generische Dokumentzugriffe. Anzeige und Export
verwenden denselben Filter und Berliner Tagesgrenzen, mit exklusiver oberer
Mitternachtsgrenze. Der Prüfstatus betrifft weiterhin die vollständige
Kanzleikette; ein gefilterter CSV-Auszug ist kein lückenloses Kettenarchiv.

## Bekannte Abweichungen und Grenzen

Die Hash-Kette macht nachträgliche Änderungen oder Lücken innerhalb der
aufgezeichneten Folge erkennbar, verhindert aber nicht, dass ein nicht
instrumentierter Fachpfad ohne Audit-Ereignis schreibt. Vollständigkeit braucht
daher zusätzliche Call-Site- und Prozesskontrollen. Ohne einen späteren externen
Anker ist eine vollständig neu erzeugte lokale Historie nicht allein durch
diese Regel von einer ursprünglichen Historie unterscheidbar.

## Fachliche Prüffragen

- Welche Aktionen müssen zwingend in der Audit-Kette erscheinen?
- Ist der bewusste Ausschluss von IP-Adresse und User-Agent aus dem Hashinhalt
  für den vorgesehenen Nachweisumfang richtig?
- Welche Kontrollen belegen die Vollständigkeit aller relevanten Schreibpfade?
- Reicht die Trennung nach Kanzlei-Tenant für den vorgesehenen Prüfungsumfang
  aus?

## Technische Nachweise

Die Service- und Hash-Ketten-Tests prüfen Vorgängerbindung, Tenant-Serialisierung
und Brucherkennung. Property-Tests variieren Schlüsselreihenfolgen und
unterstützte Werttypen, damit Aufzeichnung und Nachrechnung dieselbe kanonische
Darstellung verwenden.
