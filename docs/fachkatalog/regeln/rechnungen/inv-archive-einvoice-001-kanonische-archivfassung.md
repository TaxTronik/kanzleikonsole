---
id: INV-ARCHIVE-EINVOICE-001
title: E-Rechnungsformate aus einer kanonischen Archivfassung bereitstellen
domain: rechnungen
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Rechnungswesen
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: ZUGFeRD-PDF und separate XRechnung-XML werden gemeinsam archiviert und nach Ausstellung byte-stabil wiederverwendet.
sources:
  - kind: product_documentation
    citation: ADR 0008, XRechnung und ZUGFeRD
    path: docs/adr/0008-xrechnung-zugferd-en16931.md
    checked_at: '2026-08-23'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, GoBD-Archiv
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - apps/web/src/server/invoicing/archive.ts
  - apps/web/src/server/invoicing/archive-lock.ts
  - apps/web/src/server/invoicing/draft-archive.ts
  - apps/web/src/server/invoicing/xrechnung.ts
  - apps/web/src/server/invoicing/zugferd.ts
test_refs:
  - apps/web/src/server/invoicing/__tests__/archive.test.ts
  - apps/web/src/server/invoicing/__tests__/archive-lock.test.ts
  - apps/web/src/server/invoicing/__tests__/draft-archive.test.ts
  - apps/web/src/server/invoicing/__tests__/xrechnung.test.ts
  - apps/web/src/server/invoicing/__tests__/zugferd.test.ts
  - packages/db/src/__tests__/invoice-xrechnung-document-link.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/rechnungen.md
  - docs/adr/0008-xrechnung-zugferd-en16931.md
related_rules:
  - INV-LIFECYCLE-FREEZE-001
  - INV-PORTAL-SHARING-001
tags:
  - archiv
  - e-rechnung
  - xrechnung
  - zugferd
---

# INV-ARCHIVE-EINVOICE-001 — E-Rechnungsformate aus einer kanonischen Archivfassung bereitstellen

## Kurzfassung

Bei der Ausstellung einer In-App-E-Rechnung erzeugt TaxTronik die
menschenlesbare ZUGFeRD-PDF und die separate XRechnung-XML aus demselben
fachlichen Snapshot und archiviert beide eindeutig verknüpft. Spätere
Downloads liefern die gespeicherten Bytes und rendern den ausgestellten Beleg
nicht mit heutigen Stammdaten oder Branding-Einstellungen neu.

## Wann gilt die Regel?

Die Regel gilt für in TaxTronik erzeugte XRechnung-/ZUGFeRD-Rechnungen. Sie
beschreibt Konsistenz, Archivierung und Wiederverwendung der Artefakte, nicht
die vollständige Konformität mit jeder externen Format- oder Steuerrechtsnorm.
Extern hochgeladene PDFs werden unverändert als fremdes Original behandelt.

## Benötigte Angaben

- vollständiger fachlicher Rechnungs-Snapshot
- vollständige Verkäufer- und Käuferdaten für die Erzeugung
- gewähltes E-Rechnungsformat
- Brandingdaten für die erstmalige PDF-Erzeugung
- unveränderliche Dokument- und Versionsverknüpfungen

## Entscheidungslogik

| Ausgangslage                                       | Ergebnis                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Entwurf wird nur zur Kontrolle heruntergeladen     | aktuelle Vorschau erzeugen, aber nicht als maßgebliche Archivfassung teilen |
| Rechnung wird ausgestellt                          | PDF und XML aus einem Snapshot erzeugen, speichern und eindeutig verknüpfen |
| Archivfassung ist vorhanden                        | exakt gespeicherte Bytes ausliefern, nicht neu rendern                      |
| ältere Hybrid-PDF hat noch keine separate XML      | eingebettete `factur-x.xml` extrahieren und kanonisch verknüpfen            |
| Erzeugung oder unveränderliche Ablage schlägt fehl | Ausstellung abbrechen; Rechnung bleibt Entwurf                              |
| Branding oder Stammdaten ändern sich später        | bestehende Archivfassung unverändert lassen                                 |

## Ausnahmen und Grenzfälle

Altbestände ohne Archiv können beim ersten zulässigen Abruf nachträglich
materialisiert werden. Existiert bereits eine Hybrid-PDF, ist deren eingebettete
XML maßgeblich; ein nur gleichnamiges Dokument reicht nicht als Verknüpfung.
Parallele Archivierungsversuche werden pro Rechnung serialisiert und verwaiste
Speicherobjekte nach Fehlern bestmöglich bereinigt.

## Beispiele

### Normalfall

Eine vollständige ZUGFeRD-Rechnung wird versendet. TaxTronik speichert PDF und
XML, verknüpft beide mit der Rechnung und gibt sie frei. Ein Download Monate
später liefert dieselben Bytes, auch wenn sich der Kanzleibriefkopf geändert
hat.

### Grenzfall

Bei einem Altbeleg existiert nur die archivierte Hybrid-PDF. TaxTronik liest
die darin eingebettete XML und legt sie als gesondert verknüpften
XRechnungsbeleg ab; heutige Verkäuferdaten werden dafür nicht erneut verwendet.

## Umsetzung in TaxTronik

`archive.ts` hält den gemeinsamen Archivierungsablauf und die expliziten
Dokumentzeiger. Ein transaktionaler Advisory Lock verhindert konkurrierende
Gewinner. Entwurfsarchive können gelöst und soft-gelöscht werden; nach
Ausstellung sind die geteilten Object-Lock-Versionen die maßgebliche Quelle.

## Bekannte Abweichungen und Grenzen

Innerhalb des beschriebenen Konsistenz- und Byte-Stabilitäts-Scopes sind keine
technischen Abweichungen bekannt. Die ADR sagt ausdrücklich **keine strikt
validierte PDF/A-3-Eigenschaft** der ZUGFeRD-PDF zu. Dieser Eintrag behauptet
daher weder allgemeine EN-16931-Konformität noch die rechtliche Zulässigkeit
jeder erzeugbaren Rechnungskonstellation.

## Fachliche Prüffragen

- Welche externen Validatoren und Normstände müssen vor fachlicher Freigabe je
  Format verbindlich nachgewiesen werden?
- Genügt die dokumentierte Altbestands-Materialisierung für die
  Nachvollziehbarkeit?
- Welche Pflichtangaben oder Steuerfälle benötigen eigene Fachregeln?
- Ist die fehlende strikte PDF/A-3-Validierung für den vorgesehenen Einsatz
  akzeptabel oder ein Freigabehindernis?

## Technische Nachweise

Archiv-, Lock- und Dokumentlink-Tests prüfen Idempotenz, konkurrierende
Erzeugung, Vorschau-Isolation, explizite XML-Verknüpfung, Altbestands-Extraktion
und identische gespeicherte Bytes. Format-Tests prüfen die derzeit erzeugten
XML- und PDF-Strukturen.
