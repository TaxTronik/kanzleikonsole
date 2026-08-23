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
  status: deviates
  summary: Dokumente nie versendeter Storni bleiben intern, die Portal-Liste zeigt solche CANCELLED-Datensätze derzeit jedoch ohne Versandnachweis an.
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
  - apps/web/src/server/invoicing/archive.ts
  - apps/web/src/server/invoicing/draft-archive.ts
test_refs:
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

Die Portalliste schließt derzeit nur `DRAFT` aus. Der Archivdienst entscheidet
zusätzlich anhand von `sentAt`, ob ein stornierter Beleg zuvor geteilt wurde.
PDF und XML werden über explizite Dokument-IDs gefunden;
Entwurfsbereinigung entfernt beide Verknüpfungen atomar.

## Bekannte Abweichungen und Grenzen

Die Portal-Abfrage filtert lediglich `status != DRAFT`. Deshalb erscheint ein
nie versendeter, aber auf `CANCELLED` gesetzter Entwurf entgegen der Regel als
Listenzeile ohne Dokument im Portal. Nur die Archivfreigabe berücksichtigt
`sentAt` bereits korrekt. Auch die bestehende Anwenderdokumentation sagt
pauschal „alle Rechnungen außer Entwürfen“ und muss bei einer Produktkorrektur
mit geändert werden. Unabhängig davon brauchen außerhalb des Systems
versendete Altbelege ohne gepflegtes `sentAt` eine kontrollierte
Datenbereinigung.

## Fachliche Prüffragen

- Muss ein bereits versendeter Stornobeleg zeitlich unbegrenzt in der
  Portalsicht bleiben oder gelten zusätzliche Aufbewahrungs-/Zugriffsregeln?
- Wie werden außerhalb des Systems versendete Altbelege beweissicher markiert?
- Soll das Portal Original und Korrekturbeleg sichtbar miteinander verknüpfen?
- Welche Information zum Stornogrund darf beziehungsweise muss der Mandant
  sehen?

## Technische Nachweise

Archivtests prüfen die Freigabe bereits versendeter Storni und die Ablehnung
nie versendeter Storni. Entwurfsarchiv-Tests prüfen das Lösen und Soft-Delete
explizit verknüpfter PDF-/XML-Artefakte; die Portalabfrage schließt Entwürfe
serverseitig aus.
