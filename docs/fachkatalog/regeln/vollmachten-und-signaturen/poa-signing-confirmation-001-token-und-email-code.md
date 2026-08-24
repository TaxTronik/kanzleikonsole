---
id: POA-SIGNING-CONFIRMATION-001
title: Vollmachtsinhalt mit Magic-Link, E-Mail-Code und ausdrücklicher Zustimmung bestätigen
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
    TaxTronik verlangt einen gehashten 32-Byte-Linktoken, eine ausdrückliche
    Inhaltsbestätigung und einen kurzlebigen sechsstelligen E-Mail-Code. Der
    Abschluss schreibt Status und Evidence atomar, ist aber weder eine
    belastbare Identitätsfeststellung noch eine zugesagte AES oder QES.
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
  - apps/web/src/app/staff/(protected)/poa/actions.ts
  - apps/web/src/app/staff/(protected)/poa/sign-actions.ts
  - apps/web/src/app/poa/sign/sign-flow.tsx
  - packages/db/prisma/migrations/20260801002800_iter103_poa_signed_content_binding/migration.sql
  - packages/db/prisma/migrations/20260801003600_poa_signing_snapshot/migration.sql
test_refs:
  - apps/web/src/app/staff/(protected)/poa/__tests__/actions.test.ts
  - apps/web/src/server/poa/__tests__/signing-snapshot.test.ts
  - packages/db/src/__tests__/poa-signing-integrity.test.ts
feature_refs:
  - FEATURES.md
  - docs/adr/0009-eidas-aes-via-token-und-otp.md
related_rules:
  - POA-SIGNING-SNAPSHOT-001
  - POA-LIFECYCLE-001
  - POA-SIGNER-RETENTION-001
tags:
  - vollmacht
  - magic-link
  - email-code
  - bestaetigung
---

# POA-SIGNING-CONFIRMATION-001 — Vollmachtsinhalt mit Magic-Link, E-Mail-Code und ausdrücklicher Zustimmung bestätigen

## Kurzfassung

TaxTronik stellt einen technischen elektronischen Bestätigungsprozess bereit:
Ein zufälliger Magic-Link öffnet die unveränderliche Vollmachtsfassung. Erst
nach ausdrücklicher Zustimmung wird ein kurzlebiger sechsstelliger Code an
dasselbe E-Mail-Postfach versandt; ein gültiger Code schließt den Vorgang
atomar ab.

Link und Code an dasselbe Postfach sind keine unabhängigen Faktoren. Der
Prozess wird deshalb nicht als belastbare Identitätsprüfung, fortgeschrittene
elektronische Signatur oder qualifizierte elektronische Signatur zugesagt.

## Wann gilt die Regel?

Die Regel gilt für den öffentlichen Bestätigungsweg einer zuvor versandten,
nicht widerrufenen und noch gültigen Vollmacht mit vollständigem Snapshot. Sie
gilt nicht für externe Signaturdienste, papiergebundene Vorgänge oder eine
rechtliche Prüfung von Identität, Vollmachtstyp und Form.

## Benötigte Angaben

- versandte Vollmacht und unveränderlicher Snapshot
- zufälliger Linktoken und dessen gespeicherter Hash
- hinterlegte Unterzeichner-E-Mail-Adresse
- ausdrückliche Zustimmung zum angezeigten Inhalt
- sechsstelliger E-Mail-Code und dessen Hash
- Ablaufzeiten und bisherige Fehlversuche
- serverseitig erfasster Zeitpunkt, IP-Adresse und User-Agent

## Entscheidungslogik

| Wenn                                                             | Dann                                                                                              | Begründung                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Vollmacht wird versandt                                          | 32 Byte Zufall erzeugen, nur Hash speichern und Link auf 72 Stunden begrenzen                     | Roh-Token nicht in der Datenbank ablegen              |
| Link ist ungültig, abgelaufen oder Vorgang nicht mehr signierbar | Inhalt und Codeanforderung verweigern                                                             | keine Wiederverwendung außerhalb des Zustandsfensters |
| ausdrückliche Zustimmung fehlt                                   | keinen E-Mail-Code erzeugen                                                                       | bewusste Erklärung vor Codeversand verlangen          |
| Zustimmung liegt vor und Limits sind frei                        | sechsstelligen Code gehasht speichern, zehn Minuten gültig machen und an dasselbe Postfach senden | kurzlebige zweite Bestätigungsstufe                   |
| Code ist falsch                                                  | Fehlversuch atomar erhöhen und nach den Grenzen sperren                                           | Online-Ratenbegrenzung und Race-Schutz                |
| Code, Link, Snapshot und Zustand sind gültig                     | Signaturclaim atomar setzen, Status auf SIGNED wechseln und Evidence schreiben                    | kein Status ohne zugehörigen Nachweis                 |
| Vorgang wurde bereits abgeschlossen                              | erneuten Abschluss verweigern                                                                     | Einmaligkeit                                          |

## Ausnahmen und Grenzfälle

Für einen Code sind höchstens fünf Fehlversuche vorgesehen; über den
gesamten Vorgang sind höchstens 15 OTP-Fehlversuche und höchstens zehn
Tokenausgaben innerhalb von 72 Stunden zugelassen. Allgemeine Rate-Limits
ergänzen diese Zustandsgrenzen. Ein kompromittiertes E-Mail-Postfach kann
jedoch sowohl Link als auch Code offenlegen. IP und User-Agent sind
Protokolldaten, keine sichere Personenidentifizierung.

## Beispiele

### Normalfall

Die Empfängerin öffnet den noch gültigen Link, sieht den Snapshot, bestätigt
ausdrücklich den Inhalt und gibt innerhalb von zehn Minuten den per E-Mail
erhaltenen Code ein. TaxTronik setzt Status und Evidence in einer Transaktion.

### Grenzfall

Eine andere Person hat Zugriff auf dasselbe Postfach und kann Link und Code
lesen. Der technische Ablauf kann dadurch erfolgreich sein, obwohl TaxTronik
die natürliche Person nicht belastbar identifiziert hat. Ob der Nachweis für
den konkreten Zweck genügt, muss ein Berufsträger außerhalb des Prozesses
beurteilen.

## Umsetzung in TaxTronik

Die Staff-Actions erzeugen den gehashten Linktoken und versenden den Link. Die
öffentlichen Sign-Actions prüfen Zustand, Ablauf, Zustimmung, Rate-Limits und
den gehashten OTP. Der finale Datenbankclaim sperrt die Vollmacht, prüft den
Snapshot-Hash erneut und schreibt Signaturdaten sowie Evidence gemeinsam. Die
Oberfläche stellt die Zustimmung als zwingende Eingabe dar.

## Bekannte Abweichungen und Grenzen

Keine bekannte technische Abweichung innerhalb des beschriebenen Token-/Code-
Scopes. Die technische Bestätigung ist ausdrücklich keine zugesagte AES oder
QES. `POA-LEGAL-VALIDITY-001` bleibt als Prüfung von Rechtswirksamkeit,
Vertretungsmacht und anwendbarer Form außerhalb des Produktumfangs. Auch die
tatsächliche Kontrolle des E-Mail-Kontos und die Person hinter dem Konto
werden nicht festgestellt.

## Fachliche Prüffragen

- Für welche Vollmachtstypen reicht dieser technische Nachweis aus?
- Welche zusätzliche Identitäts- oder Vertretungsprüfung ist erforderlich?
- Ist ein externer Signaturdienst oder eine QES für einzelne Vorgänge notwendig?
- Sind Aufbewahrung, Zugriff und Zweck der IP-/User-Agent-Daten angemessen dokumentiert?

## Technische Nachweise

Action-Tests belegen Zustimmungspflicht, Token-/OTP-Abläufe, Ablaufzeiten,
Fehlversuche, Limits und atomare Claims. Snapshot- und Datenbanktests belegen
die Inhaltsbindung und unveränderliche Evidence. Diese Tests können weder eine
Person identifizieren noch eine rechtliche Signaturklasse bestätigen.
