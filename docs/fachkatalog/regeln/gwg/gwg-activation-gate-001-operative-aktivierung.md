---
id: GWG-ACTIVATION-GATE-001
title: Operative Aktivierung nur nach gültiger GwG-Freigabe
domain: gwg
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Geldwäscheprävention
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    TaxTronik schaltet den Mandanten erst nach einem gültigen, verifizierten und
    nicht vernichteten GwG-Prüfsnapshot operativ frei. Datenbank-Trigger
    schützen Aktivierung sowie die Neuanlage von Anforderungen, Rechnungen und
    Dokumenten; eng begrenzte GwG-Onboarding-Belege sind vorab zulässig.
sources:
  - kind: product_documentation
    citation: GwG-Pflichten und technische Umsetzung in TaxTronik
    path: docs/compliance/gwg.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: ADR 0007 — GwG-Schranke via DB-Trigger
    path: docs/adr/0007-gwg-schranke-via-db-trigger.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 10 Abs. 9 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__10.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 11 Abs. 1 GwG
    url: https://www.gesetze-im-internet.de/gwg_2017/__11.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - packages/db/prisma/migrations/20260511000000_iter2_portal_requests_notes/migration.sql
  - packages/db/prisma/migrations/20260514000000_iter5_invoices/migration.sql
  - packages/db/prisma/migrations/20260801003400_gwg_fail_closed_and_destruction/migration.sql
  - packages/db/prisma/migrations/20260801004300_gwg_identity_subjects_and_document_sets/migration.sql
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/actions.ts
test_refs:
  - packages/db/src/__tests__/gwg-allow-active.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/gwg/__tests__/actions.test.ts
feature_refs:
  - FEATURES.md
  - docs/compliance/gwg.md
  - docs/anwenderdoku/erste-schritte.md
related_rules:
  - GWG-IDENTIFICATION-EVIDENCE-001
  - GWG-REPRESENTATIVE-AUTHORITY-001
  - GWG-BENEFICIAL-OWNERS-001
  - GWG-RISK-REVIEW-001
  - GWG-SELF-ONBOARDING-001
  - GWG-REVERIFICATION-VALIDITY-001
tags:
  - aktivierung
  - fail-closed
  - sorgfaltspflichten
---

# GWG-ACTIVATION-GATE-001 — Operative Aktivierung nur nach gültiger GwG-Freigabe

## Kurzfassung

TaxTronik behandelt `client.allowActive` als produktseitige GwG-Schranke. Die
Freischaltung ist nur möglich, wenn ein noch gültiger, nicht vernichteter
`VERIFIED`-Prüfsnapshot mit der für den Mandantentyp erforderlichen
Identitätszuordnung existiert. Ohne Freischaltung blockiert die Datenbank neue
Anforderungen, Rechnungen und reguläre Dokumente.

Das ist eine bewusst strenge Produktregel. Sie bildet weder sämtliche
Tatbestands- und Ausnahmeregeln des § 10 GwG noch die Entscheidung über Beginn,
Fortführung oder Beendigung einer Geschäftsbeziehung vollständig ab.

## Wann gilt die Regel?

Die Regel gilt für Mandanten in TaxTronik und die dortige Neuanlage von
Anforderungen, Rechnungen und mandantenbezogenen Dokumenten. Sie gilt auch für
direkte Datenbankzugriffe, weil Trigger die Kerninvarianten unabhängig von der
Oberfläche prüfen.

Vor der Aktivierung dürfen ausschließlich `GWG_EVIDENCE`-Dokumente im Rahmen
einer exakt gebundenen, noch offenen Einladung oder einer offenen
Mitarbeiterprüfung angelegt werden. Bereits bestehende Daten, reine
Lesefunktionen und alle außerhalb des Produkts ausgeführten Tätigkeiten sind
nicht Gegenstand dieser Regel.

## Benötigte Angaben

- Tenant und Mandant
- Mandantentyp natürliche Person, juristische Person oder Personengesellschaft
- aktueller Status und Gültigkeitsende des GwG-Prüfsnapshots
- Vernichtungsstatus des Prüfsnapshots
- erforderliche bestätigte Identitätszuordnung
- bei Rechtsträgern Rechtsform, Registerangaben oder dokumentierte
  Registerlosigkeit, Vertretung und Eigentums-/Kontrollstruktur
- bei vorgezogenen GwG-Uploads eine aktive, mandantengebundene Einladung oder
  offene Prüfung

## Entscheidungslogik

| Wenn                                                                                                 | Dann                                                                                 | Begründung                                                          |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Kein geeigneter `VERIFIED`-Snapshot existiert                                                        | `allowActive = true` wird abgewiesen                                                 | Produktseitig fail-closed                                           |
| Snapshot ist abgelaufen oder vernichtet                                                              | Aktivierung wird abgewiesen beziehungsweise bestehende Aktivierung entzogen          | Ein überholter oder vernichteter Nachweis darf nicht tragen         |
| Erforderliche Identitäts- oder Rechtsträgerangaben fehlen                                            | Aktivierung wird abgewiesen                                                          | Unvollständige Prüfgrundlage                                        |
| Gültiger Snapshot und Pflichtangaben liegen vor                                                      | Der zugeordnete Berufsträger kann verifizieren; danach darf die Anwendung aktivieren | Dokumentierte Produktfreigabe                                       |
| Mandant ist nicht aktiv und ein reguläres Dokument, eine Anforderung oder Rechnung wird neu angelegt | Datenbank weist die Neuanlage zurück                                                 | Operative GwG-Schranke                                              |
| Mandant ist nicht aktiv, aber ein gebundener offener GwG-Vorgang lädt `GWG_EVIDENCE` hoch            | Upload darf innerhalb des engen Ausnahmewegs erfolgen                                | Identifizierungsnachweise müssen vor Freigabe erfasst werden können |
| Prüfung wird abgelehnt, läuft ab oder wird wegen relevanter Stammdatenänderung entwertet             | Mandant wird deaktiviert                                                             | Frühere Freigabe trägt nicht mehr                                   |

## Ausnahmen und Grenzfälle

- § 10 Abs. 9 GwG enthält für bestimmte Tätigkeiten der Rechtsberatung oder
  Prozessvertretung eine gesetzliche Ausnahme. TaxTronik bildet diese Ausnahme
  in der Aktivierungsschranke nicht als Fallentscheidung ab.
- Die gesetzliche Pflicht knüpft an Sorgfaltspflichten und die konkrete
  Geschäftsbeziehung oder Transaktion an. `allowActive` ist dagegen ein grobes,
  mandantenweites Produktsignal.
- Ein älterer abgelaufener Snapshot deaktiviert den Mandanten nicht, wenn ein
  neuerer gültiger `VERIFIED`-Snapshot existiert.
- Bestandsdaten aus historischen Migrationen können abweichende
  Nachweisqualitäten besitzen; neue Prüfzyklen verlangen die aktuelle
  Identitätszuordnung.
- Die Schranke verhindert nicht, dass Tätigkeiten außerhalb von TaxTronik
  begonnen werden.

## Beispiele

### Normalfall

Eine GmbH hat einen vollständig eingereichten Prüfsnapshot. Der zugeordnete
Berufsträger bestätigt den unveränderten Snapshot; der Status wechselt auf
`VERIFIED`, das Gültigkeitsende wird gespeichert und der Mandant wird aktiviert.
Danach können Anforderungen und Rechnungen angelegt werden.

### Grenzfall

Ein Mandant benötigt vor der Freigabe einen Ausweis-Upload. Ein allgemeiner
Dokumentupload bleibt gesperrt. Der Upload als `GWG_EVIDENCE` ist nur über die
noch gültige und exakt diesem Mandanten zugeordnete Einladung zulässig.

## Umsetzung in TaxTronik

Die Verifizierungs-Action prüft den vollständigen, zuvor eingereichten Snapshot,
die mandatsbezogene Berufsträgerzuordnung und einen Hash des angezeigten
Reviewstands. Erst danach setzt sie den Check auf `VERIFIED` und aktiviert den
Mandanten. Datenbankfunktionen prüfen zusätzlich Status, Gültigkeit,
Vernichtungsstatus, Rechtsträgerdaten und bestätigte Identitätszuordnung.

Weitere Trigger blockieren neue Anforderungen, Rechnungen und Dokumente bei
inaktiven Mandanten. Für `GWG_EVIDENCE` gibt es nur den beschriebenen
vorbereitenden Ausnahmeweg. Statusverlust und Ablauf deaktivieren fail-closed.

## Bekannte Abweichungen und Grenzen

Innerhalb des ausdrücklich beschriebenen Produkt-Gates sind keine bekannten
technischen Abweichungen festgestellt. Die Schranke ist aber keine vollständige
Umsetzung des § 10 Abs. 9 GwG:

- Die Ausnahme für bestimmte Rechtsberatungs- und Prozessvertretungstätigkeiten
  wird nicht fallbezogen modelliert.
- Die Software entscheidet nicht, ob eine konkrete Tätigkeit bereits eine
  Geschäftsbeziehung oder Transaktion begründet.
- Bestehende Inhalte und externe Kanzleitätigkeiten werden durch das Gate nicht
  vollständig unterbunden.
- Kanzleiweite Risikoanalyse, interne Sicherungsmaßnahmen und Verdachtsmeldungen
  liegen außerhalb dieses Gates.

## Fachliche Prüffragen

- Soll die Produktregel bewusst strenger als § 10 Abs. 9 GwG bleiben?
- Welche Tätigkeiten dürfen bei inaktivem Mandanten noch gelesen, vorbereitet
  oder rechtlich beraten werden?
- Müssen gesetzliche Ausnahmen als dokumentierte Einzelfallfreigabe abgebildet
  werden?
- Reicht die mandantenweite Freigabe oder braucht es eine vorgangsbezogene
  Schranke?

## Technische Nachweise

Die Migrations-Trigger belegen die Aktivierungsinvariante und die Sperren für
die drei Kernobjekte. Der Datenbanktest greift Aktivierung ohne Check,
unvollständige und abgelaufene Snapshots, Statusverlust, direkte Inserts und den
engen GwG-Uploadweg an. Die Action-Tests belegen den
Berufsträger-Entscheidungspfad. Diese Nachweise bestätigen nur das
Produktverhalten, nicht dessen fachliche Freigabe.
