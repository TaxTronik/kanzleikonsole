---
id: DOC-VERSION-IMMUTABILITY-001
title: Geschützte Dokumentversionen nur anfügen und Schutz nicht herabsetzen
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
    Neue Inhalte werden als neue Version gespeichert; bei einer Höherstufung
    bleibt eine bereits geschützte Version bestehen und erhält eine neue
    geschützte Nachfolgeversion. Herabstufung, GwG-Tierwechsel und Verkürzung
    einer gesetzten GoBD-Frist werden blockiert.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Dokumente, Versionen und Schutzstufen
    path: docs/anwenderdoku/dokumente.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: § 146 Abs. 4 AO
    url: https://www.gesetze-im-internet.de/ao_1977/__146.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_guidance
    citation: GoBD in amtlicher AO-Handbuchfassung 2025, Unveränderbarkeit und Protokollierung
    url: https://stberh.bundesfinanzministerium.de/ao/2025/Anhaenge/BMF-Schreiben-und-gleichlautende-Laendererlasse/Anhang-33/inhalt.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/route.ts
  - apps/web/src/server/storage/retag-policy.ts
  - apps/web/src/app/staff/(protected)/documents/actions.ts
test_refs:
  - apps/web/src/app/staff/(protected)/documents/__tests__/retag-race.test.ts
  - apps/web/src/server/storage/__tests__/retag-policy.test.ts
  - apps/web/src/app/api/staff/documents/[id]/new-version/commit/__tests__/route-poa-lock.test.ts
feature_refs:
  - docs/anwenderdoku/dokumente.md
  - docs/development/module/dokumentenarchiv.md
related_rules:
  - DOC-OBJECT-LOCK-001
  - DOC-RETENTION-CLASS-001
tags:
  - versionierung
  - unveraenderlichkeit
  - retagging
---

# DOC-VERSION-IMMUTABILITY-001 — Geschützte Dokumentversionen nur anfügen und Schutz nicht herabsetzen

## Kurzfassung

TaxTronik überschreibt bei einem normalen Versionsupload keine bestehenden
Bytes, sondern legt eine weitere nummerierte Dokumentversion an. Eine bereits
geschützte Version wird auch beim Retagging nicht auf eine neue Speicheridentität
umgebogen; die höher geschützte Kopie wird angefügt. Schutzstufen und gesetzte
Retention dürfen nicht nachträglich abgesenkt werden.

## Wann gilt die Regel?

Die Regel gilt für neue Versionen und für die Umklassifizierung bestehender
Dokumente. Der besondere Append-Schutz beim Retagging gilt, wenn die bisherige
Version bereits `immutable` ist. Eine ungeschützte Ausgangsversion kann bei
der Höherstufung auf die geschützte Kopie umgebogen und ihr altes Objekt danach
bestmöglich entfernt werden.

## Benötigte Angaben

- aktuelle Dokument- und neueste Versionsidentität
- alte und neue Schutzstufe
- alte und neue Aufbewahrungsdauer
- Byteinhalt, Hash und konkrete Storage-Version der neuen Fassung
- unveränderter Mandanten-, Typ- und Zugriffsstand beim Commit
- Bindung an Vollmacht oder GwG-Prüfsnapshot

## Entscheidungslogik

| Wenn                                                                 | Dann                                        | Begründung                                         |
| -------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| neue Fassung wird hochgeladen                                        | nächste Versionsnummer anfügen              | alte Fassung bleibt nachvollziehbar                |
| Zielstufe ist niedriger                                              | Umklassifizierung blockieren                | gesetzter Schutz darf nicht entfernt werden        |
| bestehender GwG-Nachweis soll Tier wechseln                          | blockieren und separates Dokument verlangen | eigener Vernichtungsworkflow muss erhalten bleiben |
| GoBD-Frist soll verkürzt werden                                      | blockieren                                  | bestehender COMPLIANCE-Lock ist nicht rücknehmbar  |
| GoBD-Frist wird verlängert oder Stufe erhöht                         | Bytes neu mit höherem Lock speichern        | neue Schutzentscheidung benötigt neues Objekt      |
| Ausgangsversion ist bereits geschützt                                | neue Dokumentversion anfügen                | geschützte Historie nicht umbiegen                 |
| Paralleländerung an Dokument, Typ oder neuester Version wird erkannt | Commit mit Konflikt abbrechen               | kein stale write                                   |
| Dokument ist an versendete Vollmacht oder GwG-Nachweis gebunden      | neue Version blockieren                     | gebundener Snapshot bleibt stabil                  |

## Ausnahmen und Grenzfälle

Metadatenänderungen innerhalb derselben Schutzstufe können ohne neue Bytes
erfolgen, soweit Frist und Tier gleich bleiben. Bei einer ungeschützten
Ausgangsversion bewahrt der Retag-Pfad die alte mutable Storage-Kopie nicht als
eigene historische Version. Ein fehlgeschlagener DB-Commit nach neuem
Store-Objekt führt zur Orphan-Kompensation, nicht zum stillen Erfolg.

## Beispiele

### Normalfall

Zu einem GoBD-Dokument wird eine korrigierte Datei hochgeladen. Version 1
bleibt unverändert; Version 2 erhält eigene Bytes, Hash, Storage-Version und
Audit-Eintrag.

### Grenzfall

Ein bereits geschützter GwG-Beleg soll in GoBD umklassifiziert werden. Das
Produkt blockiert den Tierwechsel. Benötigt die Kanzlei dieselben Bytes auch
für einen anderen Aufbewahrungszweck, muss sie ein separates Dokument mit
eigener Klassifikation anlegen.

## Umsetzung in TaxTronik

Die New-Version-Route sperrt Referenzen erneut, bestimmt die nächste Nummer in
der Commit-Transaktion und fügt die Version an. `retag-policy.ts` entscheidet
über Metadatenänderung, Re-Store oder Blockade. Die Retag-Action stabilisiert
Dokument und Zieltyp per Lock; bei einem bereits unveränderlichen Ausgang
erzeugt sie eine neue Version statt eines Updates.

## Bekannte Abweichungen und Grenzen

Keine bekannte technische Abweichung innerhalb des Scopes geschützter
Versionen und Schutz-Herabstufungen. Die Historie eines ungeschützten
Dokuments wird beim ersten Retagging nicht zwingend als eigene alte
Dokumentversion konserviert. Außerdem belegt Versionierung weder die richtige
fachliche Klassifikation noch die Ordnungsmäßigkeit sämtlicher vor- und
nachgelagerter Prozesse.

## Fachliche Prüffragen

- Muss auch die ungeschützte Ausgangskopie bei jeder Höherstufung historisch erhalten bleiben?
- Welche Metadatenänderungen sind ohne neue Version fachlich zulässig?
- Sind alle fachlichen Snapshot-Bindungen vollständig als Versionssperre erfasst?
- Wie werden Korrekturen nach Fehlklassifikation dokumentiert?

## Technische Nachweise

Retag-Race-Tests belegen den Abbruch bei Versionsdrift und das Anfügen statt
Update einer geschützten Version. Policy-Tests prüfen Höherstufung,
Herabstufung, GwG-Tierwechsel und Fristverkürzung. Der PoA-/GwG-Routentest
belegt ausgewählte Snapshot-Sperren; er ist kein Vollständigkeitsnachweis aller
fachlichen Bindungen.
