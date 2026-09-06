---
id: MAIL-INBOX-001
title: Unbestätigte Posteingänge prüfen und bewusst einem Mandat zuordnen
domain: dokumente-und-aufbewahrung
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Kanzleiorganisation und Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Opt-in-IMAP-Eingang mit dauerhafter Deduplizierung, Microsoft OAuth/PKCE,
    gesperrten ungeprüften Anhängen und ausdrücklich bestätigter Archivablage.
    Reale Microsoft-365-Abnahme und die organisatorische
    Aufbewahrungsentscheidung für den Eingangskorb stehen aus.
sources:
  - kind: product_documentation
    citation: Smart-Mailbox, Technik und Pilotgrenzen
    path: docs/development/module/smart-mailbox.md
    checked_at: '2026-08-31'
    primary: true
  - kind: technical_standard
    citation: Microsoft, Authenticate an IMAP application using OAuth
    url: https://learn.microsoft.com/en-us/exchange/client-developer/legacy-protocols/how-to-authenticate-an-imap-pop-smtp-application-by-using-oauth
    checked_at: '2026-08-31'
    primary: false
code_refs:
  - packages/mail/src/imap.ts
  - packages/mail/src/attachments.ts
  - apps/web/next.config.mjs
  - apps/web/scripts/verify-standalone-trace.mjs
  - apps/web/src/app/staff/(protected)/mailbox/actions.ts
  - apps/web/src/app/api/staff/mailbox/oauth/route.ts
  - apps/web/src/server/mailbox/oauth-cache.ts
  - packages/db/prisma/migrations/20260831150000_smart_mailbox/migration.sql
  - packages/db/prisma/migrations/20260831290000_mailbox_receipt_delete_guard/migration.sql
test_refs:
  - packages/mail/src/__tests__/imap.test.ts
  - packages/mail/src/__tests__/microsoft-cache.test.ts
  - packages/mail/src/__tests__/attachments.test.ts
  - packages/mail/src/__tests__/attachment-resource-limits.test.ts
  - apps/web/src/server/mailbox/__tests__/oauth-cache.test.ts
  - packages/db/src/__tests__/mailbox-oauth-cache.test.ts
  - packages/db/src/__tests__/mailbox-rls.test.ts
feature_refs:
  - docs/development/module/smart-mailbox.md
related_rules:
  - ACCESS-TENANT-RLS-001
  - ACCESS-STAFF-PERMISSION-001
tags:
  - imap
  - oauth
  - virenpruefung
  - originaldatei
---

# MAIL-INBOX-001 — Unbestätigte Posteingänge prüfen und bewusst einem Mandat zuordnen

## Kurzfassung

E-Mail-Absender und Aliase sind unbestätigte Hinweise. Sie erteilen keinen Portalzugriff und bestätigen keine Mandantenantwort. Eingänge bleiben zunächst im internen Postfachbestand. Ein Archivdokument entsteht ausschließlich durch eine berechtigte, ausdrückliche Zuordnung.

## Wann gilt die Regel?

Für das ausdrücklich aktivierte Modul smartMailbox, konfigurierte IMAP-/Microsoft-365-Postfächer und deren internen Eingangskorb. Die bestehende n8n-Anbindung wird dadurch nicht ersetzt oder automatisch umgestellt.

## Benötigte Angaben

Kanzlei, berechtigter Mitarbeiter, bestätigte Postfachkonfiguration, Ordnerkennung und UID, Originalbytes mit Größe und Hash, Scannerergebnis sowie ausdrücklich gewählter Mandant und Dokumenttyp. Microsoft 365 benötigt Kanzlei-App, Client-Secret und die Einwilligung einer berechtigten Person.

## Entscheidungslogik

Ohne Modulfreigabe oder bei pausiertem Postfach findet kein weiterer Abruf statt. TLS wird geprüft, Microsoft-Anmeldung verlangt die konfigurierte Kanzlei-App und PKCE. Die Transportidentität wird dauerhaft gespeichert. Wiederholungen verwenden vorhandene Empfangsnachweise; geänderte Ordnerkennungen halten den Abruf an.

Verschlüsselte, infizierte oder nicht prüfbare Dateien bleiben gesperrt. Scannerfehler erlauben keine Freigabe. Größe und Typ werden anhand der Bytes geprüft; automatische Archiventpackung findet nicht statt. Vor Ablage bestätigt ein Mitarbeiter mit INBOUND_MAIL_MANAGE einen zugänglichen aktiven Mandanten und einen zulässigen Dokumenttyp. Die Ablage erhält die Originalbytes, deren Prüfsumme und eine wiederaufnehmbare Dokumentversion; Portalsichtbarkeit bleibt aus.

## Ausnahmen und Grenzfälle

Das Postfach wird weder bereinigt noch als gelesen markiert. Es gibt keine automatische Fristerkennung, rechtliche Einordnung, Antwortauthentifizierung oder Postfachvollständigkeitsbescheinigung. Größenlimits und gesperrte Dateitypen verlangen einen anderen sicheren Anlieferungsweg. Aufbewahrung des Eingangskorbs und tatsächliche Microsoft-Anmeldung sind vor Produktivfreigabe abzunehmen.

## Beispiele

Eine Rechnung kommt zweimal im gleichen Abrufbereich vor. Die dauerhafte UID-Identität verhindert zwei Empfangsnachweise; eine erneut bestätigte Archivierungsaktion nimmt den ersten Ablagevorgang wieder auf.

Ein manipulierter Absender behauptet, ein bestehender Mandant zu sein. Der Eingang bleibt unbestätigt. Erst die personelle Auswahl legt den tatsächlichen Mandanten fest. Bei Scannerausfall ist auch eine korrekt zugeordnete Datei nicht verfügbar.

## Umsetzung in TaxTronik

Nachrichten mit mehr als 50 Anhängen werden wie übergroße Nachrichten als
BLOCKED protokolliert. Der UID-Cursor wird danach fortgeschrieben, damit
spätere zulässige Nachrichten weiter eingelesen werden. Der technische
Grenzwert ist keine fachliche Aufbewahrungsentscheidung. Scanner- und
Transportausfälle bleiben wiederholbare Fehler. Der Transporttest belegt
einen gesperrten Eingang mit 51 Anhängen, den erfolgreichen Folgeeingang
und die Deduplizierung beim nächsten Poll.

Der BullMQ-Worker speichert Empfangsidentitäten und vorgemerkte Ablagepfade dauerhaft. Die App-Rolle benötigt zusätzliche Posteingangsrechte; Portalakteure erhalten keinen Zugriff. Änderungen an Prüfwerten bleiben dem System-Scanner vorbehalten. Die Archivierung nutzt persistResumableDocumentUpload einschließlich erneuter Rechte- und Modulprüfung in den Schreibtransaktionen.

Nach dem externen Microsoft-Tokenaustausch werden Modul, aktive Identität und
Admin-/Partnerrolle erneut unter Datenbanksperren geprüft. Der OAuth-Callback
speichert den verschlüsselten Cache im initiierenden Mitarbeiterkontext;
widerrufene Rechte fallen nicht auf eine SYSTEM-Persistierung zurück.
Die automatische Token-Erneuerung des Workers behält ihren Systemkontext.

PDF-Vorprüfungen laufen in einem getrennten Worker-Thread mit fünf Sekunden
Zeitlimit, V8-Speichergrenzen und zusätzlicher RSS-Zuwachsüberwachung.
Kapazitätsüberschreitungen oder Parserfehler bedeuten gesperrt/nicht prüfbar;
Originalbytes und Verschlüsselungsprüfung bleiben unverändert. Die RSS-Prüfung
ist eine konservative Überwachung und keine harte Betriebssystem-Speicherquote.
Der PDF-Parser bleibt ein externes Node-Modul im Standalone-Paket; der
Build-Nachweis verwirft einen versehentlichen Rückgriff auf Host-Abhängigkeiten.

Ein zusätzlicher Entzug der aus Bootstrap-Standardrechten geerbten DELETE-Rechte
schützt Postfachprofile und Empfangs-/Anhangsnachweise vor Entfernung durch die
App-Rolle. Eine bekannte UID kann dadurch nicht nach Löschung ihres Nachweises
als neuer Eingang importiert werden. Diese technische Sperre ist keine neue
fachliche Aufbewahrungsfrist.

## Bekannte Abweichungen und Grenzen

Die Liveabnahme mit Microsoft 365 ist noch offen. Adressvorschläge beruhen auf vorhandenen Kontaktadressen, nicht auf einer frei konfigurierbaren Aliasregel-Engine. Archiv-/Office-Container und nicht prüfbare Dateien bleiben gesperrt. Die bestehende Datenklassen-Retention wird nicht pauschal auf den neuen Eingangskorb übertragen.

## Fachliche Prüffragen

Wer erhält das zusätzliche Posteingangsrecht? Welche Aufbewahrung ist für nicht übernommene Nachrichten angemessen? Wie werden gesperrte Dateien sicher erneut angefordert? Ist der M365-Test einschließlich Widerruf, freigegebenem Postfach und Token-Erneuerung dokumentiert?

## Technische Nachweise

Transporttests belegen Read-only-/TLS-Parameter, Deduplizierung und Cursor-Recovery, Wiederaufnahme nach Scannerfehlern, Malware-/Verschlüsselungssperren, Modul-Aus und UIDVALIDITY-Pause. Echte Datenbanktests prüfen zusätzliche Mitarbeiterrechte, fremde Tenants, Portalidentitäten und unveränderliche Anhanghashes. Diese Nachweise ersetzen weder eine Live-Exchange-Abnahme noch eine fachliche Freigabe.
