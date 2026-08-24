---
id: POA-LIFECYCLE-001
title: Vollmachten kontrolliert durch DRAFT, SENT, SIGNED, REVOKED und EXPIRED führen
domain: vollmachten-und-signaturen
rule_type: product_rule
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Vollmachten und Kanzleiorganisation
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: implemented
  summary: >-
    Datenbanktrigger und Actions erzwingen die technische Statusmaschine von
    DRAFT über SENT zu SIGNED sowie REVOKED oder EXPIRED. Der Ablaufworker
    behandelt nur signierte Vollmachten und ändert ohne ermittelbaren
    Benachrichtigungsempfänger derzeit auch den Status nicht.
sources:
  - kind: product_documentation
    citation: Feature-Katalog, Vollmachten und Statusmaschine
    path: FEATURES.md
    checked_at: '2026-08-24'
    primary: true
  - kind: product_documentation
    citation: ADR 0009, elektronischer Vollmachtsnachweis via Token und E-Mail-Code
    path: docs/adr/0009-eidas-aes-via-token-und-otp.md
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 167 BGB, Erteilung der Vollmacht
    url: https://www.gesetze-im-internet.de/bgb/__167.html
    checked_at: '2026-08-24'
    primary: false
  - kind: official_law
    citation: § 168 BGB, Erlöschen der Vollmacht
    url: https://www.gesetze-im-internet.de/bgb/__168.html
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/web/src/app/staff/(protected)/poa/actions.ts
  - apps/web/src/app/staff/(protected)/poa/sign-actions.ts
  - apps/worker/src/jobs/poa-expiry-check.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260801003600_poa_signing_snapshot/migration.sql
test_refs:
  - apps/web/src/app/staff/(protected)/poa/__tests__/actions.test.ts
  - apps/worker/src/jobs/__tests__/poa-expiry-check.test.ts
  - packages/db/src/__tests__/poa-signing-integrity.test.ts
feature_refs:
  - FEATURES.md
  - docs/adr/0009-eidas-aes-via-token-und-otp.md
related_rules:
  - POA-SIGNING-SNAPSHOT-001
  - POA-SIGNING-CONFIRMATION-001
  - POA-SIGNER-RETENTION-001
tags:
  - vollmacht
  - statusmaschine
  - widerruf
  - ablauf
---

# POA-LIFECYCLE-001 — Vollmachten kontrolliert durch DRAFT, SENT, SIGNED, REVOKED und EXPIRED führen

## Kurzfassung

TaxTronik führt Vollmachten in einer technischen Statusmaschine. Ein Entwurf
wird versandt, eine versandte Vollmacht kann nach erfolgreichem
Bestätigungsprozess signiert werden, und DRAFT, SENT oder SIGNED können in den
vorgesehenen Grenzen widerrufen oder als abgelaufen markiert werden. REVOKED
und EXPIRED sind technische Endzustände.

Diese Zustände verwalten den Produktworkflow. Sie entscheiden nicht, wann eine
Vertretungsmacht materiell entsteht oder nach § 168 BGB beziehungsweise dem
zugrunde liegenden Rechtsverhältnis erlischt.

## Wann gilt die Regel?

Die Regel gilt für Vollmachtsdatensätze im TaxTronik-Modul vom Entwurf bis zum
technischen Endzustand. Der automatische Ablaufpfad gilt nur für `SIGNED`-
Vollmachten mit gesetztem `validUntil`. Eine außerhalb des Produkts erteilte,
widerrufene oder erloschene Vollmacht wird nicht automatisch erkannt.

## Benötigte Angaben

- Tenant, Mandant und Vollmachtsdatensatz
- aktueller Status
- Versand- und Bestätigungsdaten
- optionales `validFrom` und `validUntil`
- bei Widerruf Grund und serverseitiger Zeitpunkt
- aktive Hauptbearbeiter/Berufsträger oder ADMIN/PARTNER als Empfänger

## Entscheidungslogik

| Wenn                                                                           | Dann                                                                                         | Begründung                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Vollmacht wird angelegt                                                        | Status DRAFT setzen                                                                          | bearbeitbarer Ausgangszustand              |
| gültiger DRAFT wird erstmals versandt                                          | Snapshot erzeugen, Versanddaten setzen und nach SENT wechseln                                | Inhalt vor externer Bestätigung einfrieren |
| SENT wird erneut versandt                                                      | Zustand SENT beibehalten und begrenzten neuen Token ausgeben                                 | kontrollierter Ersatz eines Zugangslinks   |
| SENT wird mit gültigem Link, Code und Snapshot bestätigt                       | atomar nach SIGNED wechseln                                                                  | abgeschlossener technischer Nachweis       |
| DRAFT, SENT oder SIGNED wird berechtigt widerrufen                             | Grund und DB-Zeit speichern, Token entkräften und nach REVOKED wechseln                      | expliziter technischer Endzustand          |
| SIGNED hat ein `validUntil` in den nächsten 30 Tagen                           | zuständige Mitarbeiter benachrichtigen                                                       | Ablaufkontrolle                            |
| SIGNED liegt nach dem inklusiven `validUntil`-Tag und Empfänger sind vorhanden | Status nach EXPIRED wechseln, alte Hinweise auflösen und Evidence/Benachrichtigung schreiben | automatisierter Ablauf ab dem Folgetag     |
| Status ist REVOKED oder EXPIRED                                                | weiteren fachlichen Statuswechsel verweigern                                                 | terminaler technischer Zustand             |

## Ausnahmen und Grenzfälle

`validUntil` gilt im Worker einschließlich des angegebenen Tages; EXPIRED ist
erst am Folgetag fällig. Der Worker betrachtet nur SIGNED. Ein abgelaufener
DRAFT oder SENT kann nicht mehr regulär versandt beziehungsweise bestätigt
werden, erhält durch den Worker aber nicht automatisch den Status EXPIRED. Sind
weder verantwortliche Mitarbeiter noch aktive ADMIN/PARTNER vorhanden,
überspringt der Worker den Datensatz einschließlich des Statuswechsels.

## Beispiele

### Normalfall

Eine bis zum 30. September gültige SIGNED-Vollmacht bleibt am 30. September
gültig. Beim Lauf am 1. Oktober wechselt sie nach EXPIRED; der Statuswechsel
wird protokolliert und die zuständigen Mitarbeiter erhalten einen Hinweis.

### Grenzfall

Für eine abgelaufene SIGNED-Vollmacht gibt es weder Verantwortungseinträge
noch aktive ADMIN/PARTNER. Der Worker überspringt sie und lässt den Status
SIGNED bestehen. Die Kanzlei muss Zuständigkeit und Ablauf organisatorisch
nachhalten; der Katalog behauptet hier keinen automatischen Vollzug.

## Umsetzung in TaxTronik

Staff-Actions legen Entwürfe an, versenden und widerrufen; die öffentliche
Sign-Action beansprucht ausschließlich einen noch signierbaren SENT-Datensatz.
Der Datenbanktrigger erlaubt nur die definierte Vorwärtsmatrix, friert
statusabhängige Felder ein und verlangt serverseitige Zeit- und
Nachweiskonsistenz. Ein täglicher Worker prüft SIGNED-Vollmachten im
30-Tage-Fenster, warnt und setzt nach dem inklusiven Gültigkeitstag EXPIRED.

## Bekannte Abweichungen und Grenzen

Die technische Statusmaschine selbst ist für den beschriebenen Produktworkflow
implementiert. Die Ablaufautomatik bleibt an die Ermittlung mindestens eines
Empfängers gekoppelt; ohne Empfänger findet auch kein Statuswechsel statt.
Außerhalb von TaxTronik erklärte Widerrufe, der Fortbestand des
Grundverhältnisses und gesetzliche Erlöschensgründe werden nicht ermittelt.

`POA-LEGAL-VALIDITY-001` bleibt deshalb ein ausdrücklicher Scope-Ausschluss:
Die Software gibt keine Rechtsmeinung zu Erteilung, Vertretungsmacht,
Wirksamkeit, Fortbestand oder Form einer konkreten Vollmacht ab.

## Fachliche Prüffragen

- Welche Vollmachtstypen und externen Widerrufswege müssen organisatorisch abgeglichen werden?
- Soll EXPIRED auch ohne Benachrichtigungsempfänger zwingend gesetzt werden?
- Müssen DRAFT oder SENT nach Ablauf des Gültigkeitsdatums formal auf EXPIRED wechseln?
- Wer kontrolliert, ob das zugrunde liegende Rechtsverhältnis fortbesteht?

## Technische Nachweise

Action- und Datenbanktests belegen zulässige sowie verbotene Übergänge,
Widerrufszeit, Grund, Tokenentkräftung und atomaren Abschluss. Worker-Tests
belegen das inklusive Gültigkeitsdatum, Warnfenster, Evidence,
Benachrichtigungen und den Empfänger-leer-Grenzfall. Sie belegen keine
materiell-rechtliche Wirkung.
