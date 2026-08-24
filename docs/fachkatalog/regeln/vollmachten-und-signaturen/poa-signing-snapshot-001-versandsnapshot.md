---
id: POA-SIGNING-SNAPSHOT-001
title: Die versandte Vollmachtsfassung unveränderlich an den Bestätigungsnachweis binden
domain: vollmachten-und-signaturen
rule_type: product_rule
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
  status: implemented
  summary: >-
    Beim Versand wird die konkrete Text- oder PDF-Fassung als unveränderlicher
    JSON-Snapshot mit SHA-256-Bindung gespeichert. Ansicht, Download und
    Abschluss verwenden ausschließlich diesen Snapshot; daraus folgt weder
    eine Identitätsprüfung noch eine AES/QES- oder Wirksamkeitsaussage.
sources:
  - kind: product_documentation
    citation: ADR 0009, elektronischer Vollmachtsnachweis via Token und E-Mail-Code
    path: docs/adr/0009-eidas-aes-via-token-und-otp.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: Feature-Katalog, Vollmachten
    path: FEATURES.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: Art. 25 und 26 eIDAS-Verordnung, konsolidierte Fassung
    url: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX%3A02014R0910-20241018
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 126a BGB, elektronische Form
    url: https://www.gesetze-im-internet.de/bgb/__126a.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 127 BGB, vereinbarte Form
    url: https://www.gesetze-im-internet.de/bgb/__127.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/server/poa/signing-snapshot.ts
  - apps/web/src/app/staff/(protected)/poa/actions.ts
  - apps/web/src/app/staff/(protected)/poa/sign-actions.ts
  - apps/web/src/app/poa/sign/document/route.ts
  - packages/db/prisma/migrations/20260801003600_poa_signing_snapshot/migration.sql
test_refs:
  - apps/web/src/server/poa/__tests__/signing-snapshot.test.ts
  - apps/web/src/app/poa/sign/document/__tests__/route-snapshot.test.ts
  - packages/db/src/__tests__/poa-signing-integrity.test.ts
feature_refs:
  - FEATURES.md
  - docs/adr/0009-eidas-aes-via-token-und-otp.md
  - docs/architecture.md
related_rules:
  - POA-SIGNING-CONFIRMATION-001
  - POA-LIFECYCLE-001
  - POA-SIGNER-RETENTION-001
tags:
  - vollmacht
  - snapshot
  - inhaltsbindung
  - sha256
---

# POA-SIGNING-SNAPSHOT-001 — Die versandte Vollmachtsfassung unveränderlich an den Bestätigungsnachweis binden

## Kurzfassung

Vor dem Versand friert TaxTronik die konkret angezeigte Vollmachtsfassung ein.
Bei einer Textvollmacht enthält der Snapshot den vollständigen Text, bei einer
PDF-Vollmacht die konkrete Dokumentversions-ID und deren SHA-256. Der
öffentliche Bestätigungsprozess zeigt und verarbeitet danach nur noch diese
Fassung.

Die Inhaltsbindung ist ein technischer Nachweis. Sie beweist für sich allein
weder die Identität oder Vertretungsmacht der handelnden Person noch die
rechtliche Wirksamkeit, eine gesetzliche Form oder eine AES/QES-Einstufung.

## Wann gilt die Regel?

Die Regel gilt, sobald eine im Produkt angelegte Vollmacht über den
Token-/E-Mail-Code-Prozess versandt und bestätigt werden soll. Sie gilt für die
Modi mit Text- beziehungsweise PDF-Inhalt, nicht für extern geführte
Vollmachtsdatenbanken oder Signaturdienste.

## Benötigte Angaben

- Tenant, Mandant und Vollmacht
- Betreff, Name und E-Mail-Adresse des vorgesehenen Unterzeichners
- Gültigkeitsangaben und Vollmachtsumfang
- entweder der vollständige Vollmachtstext
- oder Dokument-ID, konkrete Dokumentversions-ID und erwarteter SHA-256
- Zeitpunkt des Versands

## Entscheidungslogik

| Wenn                                                  | Dann                                                                         | Begründung                                                        |
| ----------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Textvollmacht wird versandt                           | vollständigen Text und Metadaten in den Snapshot aufnehmen                   | spätere Anzeige darf nicht aus veränderlichem Live-Inhalt stammen |
| PDF-Vollmacht wird versandt                           | konkrete Version und deren gespeicherten SHA-256 aufnehmen                   | exakte Byte-Fassung binden                                        |
| PDF-Version oder erwarteter Hash stimmt nicht         | Versand verweigern                                                           | keine unklare Dokumentfassung versenden                           |
| Snapshot ist vollständig                              | kanonisches JSON hashen und zusammen mit dem Snapshot speichern              | Integritätsanker für den Abschluss                                |
| Vollmacht ist versandt                                | inhaltsbezogene Felder, Snapshot und Hash nicht mehr ändern                  | nachträgliche Austauschbarkeit verhindern                         |
| öffentliche Ansicht oder PDF-Download wird aufgerufen | ausschließlich Snapshot beziehungsweise gebundene Version ausliefern         | Anzeige und Nachweis müssen dieselbe Fassung betreffen            |
| Bestätigung wird abgeschlossen                        | gespeicherten Snapshot-Hash erneut prüfen und als signierten Hash festhalten | atomare Bindung von Erklärung und Inhalt                          |

## Ausnahmen und Grenzfälle

Ein SHA-256 belegt die technische Gleichheit der verarbeiteten Daten, ordnet
diese aber keiner natürlichen Person zu. Auch ein unveränderter Snapshot sagt
nichts darüber aus, ob der Text inhaltlich hinreichend bestimmt, die Person
vertretungsberechtigt oder eine besondere Form eingehalten ist. Für eine
fortgeschrittene oder qualifizierte elektronische Signatur wäre ein gesondert
bewerteter Signaturprozess erforderlich.

## Beispiele

### Normalfall

Eine PDF-Vollmacht wird mit Version 4 und deren Datenbank-SHA-256 versandt. Die
Datei erhält später Version 5. Der öffentliche Link liefert weiterhin exakt
Version 4; die Bestätigung wird gegen den beim Versand erzeugten Snapshot-Hash
geprüft.

### Grenzfall

Die ausgewählte PDF-Version ist nicht mehr scan-freigegeben oder ihr
gespeicherter Hash stimmt nicht mit dem erwarteten Hash überein. TaxTronik darf
keinen Snapshot erzeugen und den Versand nicht fortsetzen. Ob eine andere
Fassung rechtlich geeignet wäre, muss außerhalb dieser Funktion entschieden
werden.

## Umsetzung in TaxTronik

`signing-snapshot.ts` validiert und kanonisiert den Snapshot. Die Versandaction
speichert Snapshot und Hash zusammen mit dem Versandzustand. Datenbank-Checks
und ein Integritätstrigger verhindern unvollständige Kombinationen und sperren
die gebundenen Daten nach Versand. Die öffentliche Seite sowie die Download-
Route lesen nicht den später veränderbaren Live-Text oder die neueste
Dokumentversion, sondern ausschließlich den gespeicherten Snapshot.

## Bekannte Abweichungen und Grenzen

Keine bekannte technische Abweichung innerhalb der beschriebenen
Snapshot-Bindung. Der Nachweis ist jedoch bewusst auf Integrität und
Prozessprotokollierung begrenzt. `POA-LEGAL-VALIDITY-001` bleibt als fachliche
Beurteilung von Wirksamkeit, Vertretungsmacht und Form je Vollmachtstyp
ausdrücklich außerhalb des Produktumfangs; TaxTronik behauptet insbesondere
keine AES oder QES.

## Fachliche Prüffragen

- Welche Text- und PDF-Vorlagen dürfen für welchen Vollmachtstyp verwendet werden?
- Welche Form- oder Nachweisanforderungen gelten im konkreten Rechtsverhältnis?
- Wer prüft Identität, Vertretungsmacht und inhaltliche Reichweite?
- Genügt der technische Snapshot dem kanzleiintern gewünschten Beweisniveau?

## Technische Nachweise

Unit-Tests belegen Kanonisierung, Text- und PDF-Snapshots sowie die Ablehnung
abweichender Dokumentdaten. Route-Tests belegen die Auslieferung der gebundenen
Version. Datenbanktests belegen Hash-Paare, Statusabhängigkeit und
Unveränderlichkeit; sie treffen keine Aussage zur rechtlichen Wirksamkeit.
