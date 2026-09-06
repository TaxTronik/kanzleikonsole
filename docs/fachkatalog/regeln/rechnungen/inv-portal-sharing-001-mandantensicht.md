---
id: INV-PORTAL-SHARING-001
title: Rechnungen erst nach Ausstellung im Mandantenportal zeigen
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
  summary: Portal-Liste und Dokumentpfad verwenden dieselbe Positivregel; ein stornierter Beleg bleibt nur mit tatsächlichem Versandnachweis sichtbar, nie versendete Storni bleiben vollständig intern.
sources:
  - kind: product_documentation
    citation: Benutzerhandbuch Rechnungen, Mandantenportal
    path: docs/anwenderdoku/rechnungen.md
    checked_at: '2026-08-23'
    primary: true
  - kind: product_documentation
    citation: Technische Modulbeschreibung Fakturierung, Zugriff
    path: docs/development/module/fakturierung.md
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - apps/web/src/app/portal/(protected)/invoices/page.tsx
  - apps/web/src/server/invoicing/portal-visibility.ts
  - apps/web/src/server/invoicing/archive.ts
  - apps/web/src/server/invoicing/draft-archive.ts
test_refs:
  - apps/web/src/server/invoicing/__tests__/portal-visibility.test.ts
  - apps/web/src/server/invoicing/__tests__/archive.test.ts
  - apps/web/src/server/invoicing/__tests__/draft-archive.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/rechnungen.md
  - docs/development/module/fakturierung.md
related_rules:
  - INV-LIFECYCLE-FREEZE-001
  - INV-ARCHIVE-EINVOICE-001
tags:
  - mandantenportal
  - rechnung
  - sichtbarkeit
---

# INV-PORTAL-SHARING-001 — Rechnungen erst nach Ausstellung im Mandantenportal zeigen

## Kurzfassung

Ein Rechnungsentwurf ist ausschließlich kanzleiintern und darf dem Mandanten
nicht als Rechnung angezeigt oder als Archivbeleg geteilt werden. Wurde eine
Rechnung bereits versendet, bleibt sie auch nach einem späteren Storno als
historischer Beleg im Portal sichtbar. Ein nie versendeter stornierter Entwurf
bleibt dagegen intern.

## Wann gilt die Regel?

Die Regel gilt für die Rechnungsübersicht und die zugehörigen Dokumentdownloads
im Portal des betroffenen Mandanten. Sie setzt eine wirksame Portal-Sitzung und
die Mandanten-/Tenant-Isolation der Dokumentroute voraus.

## Benötigte Angaben

- Rechnungsstatus
- tatsächlicher Versandzeitpunkt `sentAt`
- explizit verknüpfte Archivdokumente
- Portal-Mandant aus der Sitzung

## Entscheidungslogik

| Status und Versandnachweis                         | Portal-Sichtbarkeit und Dokumentfreigabe                      |
| -------------------------------------------------- | ------------------------------------------------------------- |
| `DRAFT`, nicht versendet                           | nicht sichtbar, Entwurfsartefakte nicht mit Mandant teilen    |
| `SENT`, `PAID` oder `OVERDUE`                      | sichtbar; verknüpfte Archivfassung bereitstellen              |
| `CANCELLED` mit vorhandenem `sentAt`               | als stornierter historischer Beleg sichtbar lassen            |
| `CANCELLED` ohne `sentAt`                          | nicht sichtbar; Entwurfsarchive lösen und intern soft-löschen |
| nur gleichnamiges, aber nicht verknüpftes Dokument | nicht als Rechnungsbeleg verwenden                            |

## Ausnahmen und Grenzfälle

Ein Statuswert allein genügt bei `CANCELLED` nicht: Entscheidend ist, ob der
Beleg zuvor tatsächlich als versendet dokumentiert wurde. Altbestände können
eine bestehende Archivfassung nachträglich explizit verknüpfen; Titelheuristiken
dürfen eine sichere Verknüpfung nicht ersetzen.

## Beispiele

### Normalfall

Eine Rechnung wechselt nach erfolgreicher Archivierung von `DRAFT` zu `SENT`.
Der Mandant sieht sie im Portal und lädt dieselbe archivierte Fassung herunter,
die auch die Kanzlei verwendet.

### Grenzfall

Ein Entwurf wird vor Versand storniert. Obwohl der Status nicht mehr `DRAFT`
lautet, fehlt `sentAt`. TaxTronik darf ihn nicht in die Mandantenakte teilen und
löst versehentlich vorhandene Entwurfsartefakte.

## Umsetzung in TaxTronik

Die Portalliste verwendet die zentrale Positivregel
`portalInvoiceVisibilityWhere`: `SENT`, `PAID` und `OVERDUE` sind sichtbar;
`CANCELLED` nur zusammen mit `sentAt`. Der Archivdienst entscheidet ebenfalls
anhand von `sentAt`, ob ein stornierter Beleg zuvor geteilt wurde. PDF und XML
werden über explizite Dokument-IDs gefunden;
Entwurfsbereinigung entfernt beide Verknüpfungen atomar.

## Bekannte Abweichungen und Grenzen

Portalabfrage und Archivfreigabe berücksichtigen `sentAt` jetzt konsistent.
Außerhalb des Systems versendete Altbelege ohne gepflegten Versandzeitpunkt
bleiben fail-closed unsichtbar und brauchen eine kontrollierte, nachweisbare
Datenbereinigung; die Anwendung erfindet keinen Versandnachweis.

## Fachliche Prüffragen

- Muss ein bereits versendeter Stornobeleg zeitlich unbegrenzt in der
  Portalsicht bleiben oder gelten zusätzliche Aufbewahrungs-/Zugriffsregeln?
- Wie werden außerhalb des Systems versendete Altbelege beweissicher markiert?
- Soll das Portal Original und Korrekturbeleg sichtbar miteinander verknüpfen?
- Welche Information zum Stornogrund darf beziehungsweise muss der Mandant
  sehen?

## Technische Nachweise

Archivtests prüfen die Freigabe bereits versendeter Storni und die Ablehnung
nie versendeter Storni. Der Portal-Sichtbarkeitstest belegt dieselbe Regel für
Listenabfrage und Dokumentlookup. Entwurfsarchiv-Tests prüfen das Lösen und
Soft-Delete explizit verknüpfter PDF-/XML-Artefakte.
