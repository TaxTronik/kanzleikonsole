---
id: MAIL-OUTBOX-001
title: Mandanten-E-Mails als Versandauftrag zustellen und vor jedem Versand auf Aktualität prüfen
domain: mandat-und-zugriff
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
    Vorgangsmails an Mandanten entstehen als Versandauftrag im fachlichen
    Commit; ein Worker stellt sie mit Aktualitätsprüfung, begrenzter
    Wiederholung und Eskalation zu, der Status steht am Vorgang, und
    fehlgeschlagene oder unklare Aufträge lassen sich berechtigt erneut senden.
    Auftragsmetadaten im Endstatus löscht ein täglicher Worker ein Jahr nach
    dem letzten Statuswechsel. Terminänderung und -absage im Kanzleikalender
    lösen auf ausdrücklichen Wunsch eine Mail aus. Mitteilungen des Tax-CMS
    (Freigabe angefordert, Bestätigungscode, Neuadressierung) stellt ein
    Worker mit einem Systemakteur je Tenant über die Outbox zu, nur an
    bestätigte Kontakte genau dieses Mandanten, ohne Doppelzustellung und mit
    Code nur verschlüsselt bis zum Endstatus; gemeldete Ereignisse gehen als
    Hinweis an Kanzleipersonen mit Zugriff. Die technische Annahme ist kein
    Zugangsnachweis; die fachliche Freigabe der Fristen fehlt.
sources:
  - kind: product_documentation
    citation: Anwenderdokumentation Administration, Abschnitt 7 „Zustellstatus von Mandanten-E-Mails“
    path: docs/anwenderdoku/administration.md
    checked_at: '2026-10-12'
    primary: true
  - kind: product_documentation
    citation: Anwenderdokumentation Kalender, Entschiedene Terminanfragen und Zustellstatus
    path: docs/anwenderdoku/kalender-fristen-bescheide.md
    checked_at: '2026-10-12'
    primary: false
  - kind: product_documentation
    citation: Anwenderdokumentation Tax-CMS, Abschnitt 9 „Mitteilungen per E-Mail und Hinweis“
    path: docs/anwenderdoku/tax-cms.md
    checked_at: '2026-10-19'
    primary: false
code_refs:
  - packages/mail/src/outbox.ts
  - packages/mail/src/outbox-purposes.ts
  - packages/mail/src/outbox-relevance.ts
  - apps/worker/src/jobs/mail-outbox.ts
  - apps/worker/src/jobs/mail-outbox-deliver.ts
  - apps/web/src/server/mail/outbox.ts
  - apps/web/src/server/mail/delivery-status.ts
  - apps/web/src/server/mail/resend.ts
  - apps/web/src/server/mail/resend-actions.ts
  - apps/web/src/server/mail/resend-guards.ts
  - apps/web/src/lib/mail-delivery-status.ts
  - packages/db/prisma/migrations/20261006120000_mail_outbox/migration.sql
  - packages/db/prisma/migrations/20261007120000_mail_outbox_skipped/migration.sql
  - packages/db/prisma/migrations/20261007120100_mail_outbox_resend/migration.sql
  - apps/worker/src/jobs/mail-outbox-retention.ts
  - packages/db/prisma/migrations/20261012110000_mail_outbox_retention/migration.sql
  - apps/web/src/server/appointments/client-mail.ts
  - apps/web/src/app/staff/(protected)/calendar/actions.ts
  - apps/web/src/app/staff/(protected)/calendar/edit-appointment-dialog.tsx
  - apps/web/src/app/staff/(protected)/calendar/appointment-mails.tsx
  - packages/db/prisma/migrations/20261012110100_appointment_change_mail_templates/migration.sql
  - packages/mail/src/tcms-vorlagen.ts
  - apps/worker/src/jobs/tcms-nachrichten.ts
  - apps/worker/src/jobs/tcms-nachrichten-zustellen.ts
  - apps/worker/src/tcms/systemakteur.ts
  - apps/worker/src/tcms/dienst.ts
  - packages/tcms-client/src/nachrichten.ts
  - packages/config/src/job-queues.ts
  - apps/web/src/app/staff/(protected)/admin/email-templates/page.tsx
  - apps/web/src/app/staff/(protected)/admin/email-templates/editor.tsx
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20261019150000_notification_kind_tcms/migration.sql
  - packages/db/prisma/migrations/20261019150100_tcms_nachrichten_zustellung/migration.sql
  - packages/db/prisma/migrations/20261019150200_tcms_mail_templates/migration.sql
test_refs:
  - packages/mail/src/__tests__/outbox.test.ts
  - packages/mail/src/__tests__/outbox-relevance.test.ts
  - apps/worker/src/jobs/__tests__/mail-outbox.test.ts
  - apps/worker/src/jobs/__tests__/mail-outbox-db.test.ts
  - apps/web/src/server/mail/__tests__/outbox.test.ts
  - apps/web/src/server/mail/__tests__/resend.test.ts
  - apps/web/src/server/mail/__tests__/resend-actions.test.ts
  - apps/web/src/lib/__tests__/mail-delivery-status.test.ts
  - apps/web/src/components/__tests__/mail-delivery-status.test.tsx
  - packages/db/src/__tests__/mail-outbox-rls.test.ts
  - apps/worker/src/jobs/__tests__/mail-outbox-retention.test.ts
  - apps/worker/src/jobs/__tests__/mail-outbox-retention-db.test.ts
  - apps/web/src/server/appointments/__tests__/client-mail.test.ts
  - apps/web/src/app/staff/(protected)/calendar/__tests__/appointment-actions.test.tsx
  - apps/web/src/app/staff/(protected)/calendar/__tests__/appointment-edit.test.tsx
  - apps/worker/src/jobs/__tests__/mail-outbox-appointment-db.test.ts
  - apps/web/src/app/staff/(protected)/calendar/__tests__/appointment-mails.test.tsx
  - apps/worker/src/jobs/__tests__/tcms-nachrichten-db.test.ts
  - apps/worker/src/jobs/__tests__/tcms-nachrichten-meldegrund.test.ts
  - apps/worker/src/__tests__/tcms-systemakteur-guard.test.ts
  - apps/web/src/__tests__/tcms-systemakteur-guard.test.ts
  - packages/tcms-client/src/__tests__/nachrichten.test.ts
  - apps/web/src/app/staff/(protected)/admin/email-templates/__tests__/editor.test.tsx
  - packages/db/src/__tests__/restore-security.test.ts
  - apps/web/src/server/backup/__tests__/restore-security.test.ts
feature_refs:
  - docs/anwenderdoku/administration.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
  - docs/anwenderdoku/tax-cms.md
related_rules:
  - ACCESS-TENANT-RLS-001
  - ACCESS-STAFF-PERMISSION-001
  - DSGVO-OPERATIONAL-RETENTION-001
  - AUDIT-HASH-CHAIN-001
  - ACCESS-CLIENT-MODE-001
  - TCMS-AKTEUR-001
  - TCMS-DIENST-001
tags:
  - e-mail
  - outbox
  - zustellstatus
  - mandantenkommunikation
  - tax-cms
---

# MAIL-OUTBOX-001 — Mandanten-E-Mails als Versandauftrag zustellen und vor jedem Versand auf Aktualität prüfen

## Kurzfassung

E-Mails, die ein Kanzleivorgang an Mandanten auslöst, speichert TaxTronik im
selben Commit wie den Vorgang als Versandauftrag. Ein Hintergrunddienst stellt
sie zu, prüft vor jedem Versuch, ob die Mail noch gewollt ist, wiederholt nur
eindeutig gescheiterte Versuche und meldet endgültige Fehlschläge der Kanzlei.
„Vom Versanddienst angenommen“ ist eine technische Aussage und kein Zugangs-
oder Kenntnisnahmenachweis. Diese Regel ist eine Produktregel; eine
Rechtsgrundlage für Inhalt, Zeitpunkt oder Pflicht dieser Mails ist offen.

## Wann gilt die Regel?

Die Regel gilt für die Versandanlässe der Mail-Outbox: Rechnungsmail (mit und
ohne PDF), Abholbenachrichtigung, Mail zur neuen Anforderung, Mail zur
Kanzlei-Antwort, Begrüßungsmail nach GwG-Freigabe, GwG-Einladung,
Terminbestätigung, Terminabsage einer Terminanfrage, Mail zum neuen Formular
sowie Terminänderung und Absage eines Kanzleitermins, wenn die Kanzlei sie im
Kalender ausdrücklich auswählt. Sie gilt außerdem für die Mitteilungen des Tax-CMS: Mails an
Mandantenkontakte (Freigabe angefordert, Bestätigungscode, Freigabe neu
adressiert) und den Hinweis an Kanzleipersonen zu einem im Portal gemeldeten
Ereignis. Sie gilt nicht für Anmelde- und Sicherheitsmails (Magic Link,
Einladung zum Portal), die automatische Steuertermin-Anforderung mit eigener
Versandhistorie, sonstige interne Mitarbeiterbenachrichtigungen,
n8n-Ereignisse ohne Mail und den Posteingang.

## Benötigte Angaben

- Kanzlei, Mandant und Vorgang (Typ und ID), an dem der Status angezeigt wird
- Versandanlass und Vorlagenkennung samt Variablen; geheime Variablen getrennt
- Empfängerart: genau eine Adresse oder alle bestätigten Kontakte
- bei Terminänderung und -absage: Auswahl „Mandant per E-Mail informieren“,
  Herkunft des Termins (Terminanfrage oder Kalender) und Kontakte des Mandanten
- angekündigter Vorgangsstand, wo die Aktualitätsprüfung ihn vergleicht
- aktueller Zustand des Vorgangs zum Versandzeitpunkt
- Versuchszähler, Zeitpunkte und Antwort des Versanddienstes
- bei Mitteilungen des Tax-CMS: Nachrichten-ID, Zweck, Mandanten- und
  Empfänger-ID, Gültigkeitsende (Code bzw. Anlage), Vorlagendaten; Stand von
  Mandant, Kontakt (Mandant, aktiv, Adresse, Portal-Anmeldung) bzw.
  Kanzleiperson (aktiv, Zugriff) in TaxTronik

## Entscheidungslogik

| Wenn                                                                                                                                                         | Dann                                                                                                                               | Begründung                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| der Vorgang wird gespeichert                                                                                                                                 | Versandauftrag im selben Commit; ein Rollback verwirft auch den Auftrag                                                            | keine Mail ohne gespeicherten Vorgang                                                          |
| vor einem Versuch ist der Mandant anonymisiert oder der Anlass entfallen                                                                                     | `SKIPPED` mit Begründung, Inhalt entfernt, kein SMTP-Kontakt, keine Kanzlei-Benachrichtigung                                       | keine überholte Mail                                                                           |
| der Versanddienst nimmt alle Empfänger an                                                                                                                    | `PROVIDER_ACCEPTED`, Inhalt entfernt                                                                                               | nur technische Annahme                                                                         |
| eindeutig gescheitert (Ablehnung, Auftrag nicht vorbereitbar, SMTP-Konfiguration)                                                                            | erneuter Versuch mit wachsendem Abstand, nach sechs Versuchen `FAILED` und Kanzlei-Hinweis                                         | kein Doppelversand möglich                                                                     |
| Ausgang unklar oder begonnener Versuch nach 30 Minuten nicht abgeschlossen                                                                                   | `UNKNOWN` und Kanzlei-Hinweis, kein automatischer Neuversand                                                                       | Doppelversandrisiko                                                                            |
| nur ein Teil der Kontakte angenommen                                                                                                                         | `PARTIAL_FAILURE` und Kanzlei-Hinweis, kein automatischer Neuversand                                                               | Doppelversandrisiko                                                                            |
| Kontaktmail ohne aktiven, per Portal-Login bestätigten Kontakt mit Benachrichtigungen                                                                        | `NO_RECIPIENT` ohne Kanzlei-Hinweis, am Vorgang sichtbar                                                                           | bisheriges Empfängerverhalten                                                                  |
| Kanzlei wählt „Erneut senden“ bei `FAILED` oder `UNKNOWN`                                                                                                    | gleiche Berechtigung wie der Auslöser, Aktualitätsprüfung, dann `QUEUED` oder `SKIPPED`, auditiert                                 | bewusste Entscheidung; bei `UNKNOWN` mit Rückfrage                                             |
| letzter Statuswechsel eines Auftrags im Endstatus liegt mehr als ein Jahr zurück                                                                             | Auftrag samt Metadaten löschen; der Vorgang zeigt für diese Mail keinen Status mehr                                                | Entscheidung A8, wie die Versandhistorie                                                       |
| Auftrag wartet oder läuft (`QUEUED`, `RETRY_PENDING`, `SENDING`)                                                                                             | nie löschen                                                                                                                        | laufende Zustellung schützen                                                                   |
| Kanzlei bearbeitet oder sagt einen Termin ab, ohne „Mandant per E-Mail informieren“                                                                          | keine Mail                                                                                                                         | ausdrückliche Entscheidung je Vorgang                                                          |
| mit Auswahl, aber ohne Mandantenbezug, anonymisiert oder ohne erreichbaren Kontakt                                                                           | nichts speichern, Feld mit Grund markieren                                                                                         | keine stille Nichtzustellung                                                                   |
| mit Auswahl: Termin aus Terminanfrage dieses Mandanten                                                                                                       | ein Auftrag an den anfragenden Kontakt, wenn aktiv und mit Benachrichtigungen                                                      | Regel der Entscheidungsmail                                                                    |
| mit Auswahl: sonstiger Termin                                                                                                                                | je aktivem Kontakt mit Benachrichtigungen ein Auftrag, alle mit gemeinsamem Erstellungszeitpunkt                                   | Regel der Entscheidungsmail je Kontakt                                                         |
| Änderung ohne neuen Titel, neue Zeit oder neuen Ort oder als erledigt gespeichert                                                                            | keine Änderungsmail                                                                                                                | nichts mitzuteilen                                                                             |
| vor dem Versand weicht der Termin vom angekündigten Stand ab oder ist abgesagt                                                                               | Änderungsmail `SKIPPED` mit Grund                                                                                                  | nur der aktuelle Stand geht hinaus                                                             |
| Termin hat vor dem Versand begonnen                                                                                                                          | Änderungs- oder Absagemail `SKIPPED` mit Grund                                                                                     | Mitteilung überholt                                                                            |
| Tax-CMS-Mitteilung an einen Kontakt: Kontakt dieses Tenants und genau dieses Mandanten, aktiv, gültige Adresse, per Portal-Anmeldung bestätigt; Mandat aktiv | ein Auftrag an die in TaxTronik hinterlegte Adresse, unabhängig von „Benachrichtigungen per E-Mail“; Code nur als geheime Variable | Transaktionsmail zum eigenen Vorgang; nur an nachweislich kontrollierte Adressen               |
| Tax-CMS-Ereignis an eine Kanzleiperson: aktiv, im Tenant, mit Zugriff auf den Mandanten                                                                      | In-App-Hinweis mit Nummer und Titel                                                                                                | kein Inhalt über die Rechte im Tax-CMS hinaus                                                  |
| Empfängerprüfung einer Tax-CMS-Mitteilung scheitert                                                                                                          | nicht zustellen, nicht als zugestellt melden, einmal je Mitteilung Hinweis an ADMIN/PARTNER ohne Inhalt; jeder Lauf prüft erneut   | keine stille Nichtzustellung, kein Versand an Unbestätigte                                     |
| Tax-CMS-Mitteilung 7 Tage nach der ersten gescheiterten Prüfung weiter nicht zustellbar oder Gültigkeitsende erreicht                                        | als unzustellbar abschließen und dem Tax-CMS als unzustellbar mit festem Grund melden (Grund aus der Zustellzeile), kein Versand   | Code bzw. Anforderung überholt; Postausgang nicht blockieren; Kanzlei sieht es an der Freigabe |
| dieselbe Tax-CMS-Mitteilung erneut oder gleichzeitig abgerufen                                                                                               | höchstens ein Auftrag bzw. Hinweis (eindeutige Zustellzeile, eindeutiger Auftrag je Mitteilung)                                    | keine Doppelzustellung                                                                         |
| Meldung an das Tax-CMS scheitert vorübergehend bzw. das Tax-CMS antwortet 404 oder 409                                                                       | nächster Lauf meldet dasselbe (gleicher Grund, keine neue Prüfung) bzw. gilt als erledigt                                          | Meldung idempotent; Mitteilung im Tax-CMS bereits abgeschlossen                                |
| Auftrag einer Tax-CMS-Mitteilung erreicht einen Endstatus (auch `FAILED`/`UNKNOWN`)                                                                          | Inhalt und Code entfernen, kein „Erneut senden“                                                                                    | Code nicht dauerhaft speichern; Neuversand im Tax-CMS                                          |
| vor dem Versand einer Tax-CMS-Mitteilung: Gültigkeitsende erreicht, Empfänger nicht mehr bestätigt, anderer Mandant, neue Adresse oder Mandat beendet        | `SKIPPED` mit Grund                                                                                                                | fail-closed                                                                                    |

## Ausnahmen und Grenzfälle

Die Aktualitätsprüfung ist bewusst konservativ: Ein unbekannter Anlass oder ein
abweichender Vorgangstyp bleibt gewollt. Sie prüft den Zustand unmittelbar vor
dem Versuch; eine Änderung danach erfasst sie nicht. Eine Terminbestätigung
gilt als überholt, wenn die Anfrage nicht mehr angenommen, der Termin
abgesagt, erledigt, bereits begonnen oder seit der Bestätigung verschoben ist.
Rechnungsmails bleiben gewollt, solange die Rechnung im Mandantenportal
sichtbar ist, eine Kanzlei-Antwort, solange die Anforderung nicht storniert
ist.

Für „Erneut senden“ bleibt der Inhalt eines `FAILED`- oder `UNKNOWN`-Auftrags
30 Tage nach der Eskalation erhalten, bei anonymisiertem Mandanten nicht.
Danach ist kein Neuversand mehr möglich. Die 30 Tage sind eine offene
Betriebsentscheidung, keine Rechtsfrist.

Bei Terminen ohne Terminanfrage gehen Änderungs- und Absagemails an jeden
aktiven Kontakt mit Benachrichtigungen; anders als bei Kontaktmails wird kein
bestätigter Portal-Login verlangt, weil die Entscheidungsmail diese Bedingung
ebenfalls nicht kennt. Der Dialog nennt die Empfänger vor dem Speichern. Wird
ein Termin aus einer Terminanfrage einem anderen Mandanten zugeordnet, gelten
dessen Kontakte. Wechselt die Kanzlei im Dialog den Mandanten, ermittelt die
Action die Empfänger für den neuen Mandanten; die Empfängeranzeige im Dialog
bezieht sich auf den gespeicherten Stand. Für den Zustellstatus zählt je Termin und Anlass nur die
jüngste Auslösung.

Mitteilungen des Tax-CMS: Die Benachrichtigungs-Einstellung des Kontakts gilt
nicht, weil es sich um Transaktionsmails zu einer Freigabe handelt, die der
Kontakt selbst angefordert hat (Code) oder die ihn als Empfänger nennt
(Anforderung, Neuadressierung). Ein bestätigter Portal-Login wird dagegen
immer verlangt: Ein Bestätigungscode bestätigt eine Freigabe und darf nur an
eine Adresse gehen, deren Inhaber sich nachweislich angemeldet hat; die
Mitteilungen des Tax-CMS tragen ohnehin keine Adressen. Gültigkeitsfenster:
der Code bis zu seinem Ablauf, Anforderung und Neuadressierung 7 Tage ab
Anlage (wie die Code-Lebensdauer), Ereignisse ohne Frist. Die 7 Tage bis zum
Abschluss als unzustellbar sind eine Betriebsentscheidung (Code-Lebensdauer,
Zeit für Korrekturen, kein dauerhaft belegter Postausgang), keine Rechtsfrist.
Eine als unzustellbar abgeschlossene Mitteilung meldet der Worker dem Tax-CMS
als unzustellbar (TCMS s6, `POST …/unzustellbar`). Der gemeldete Grund folgt
fest aus dem Grund der Zustellzeile (`TCMS_MELDEGRUND`): Empfänger unbekannt,
bei einem anderen Mandanten, als Kanzleiperson deaktiviert oder ohne Zugriff →
`EMPFAENGER_UNGUELTIG`; Kontakt nicht angemeldet, deaktiviert oder ohne gültige
Adresse → `KEIN_PORTALZUGANG`; Gültigkeitsfenster abgelaufen → `ABGELAUFEN`;
Mandant fehlt oder ist nicht aktiv → `SONSTIGES`. Nach Ablauf der 7 Tage bleibt
der Grund der letzten Prüfung maßgeblich. Weil der Grund mit dem Abschluss in
der Zeile steht, sendet eine Wiederholung denselben Grund (das Tax-CMS nimmt
„unzustellbar“ nur mit demselben Grund idempotent an). Ein 409 (dort bereits
zugestellt oder mit anderem Grund gemeldet) gilt wie ein 404 als erledigt; das
Log nennt dann nur Art der Meldung, Status und Request-ID. Das Tax-CMS zeigt
der Kanzlei den Zustellstatus an Freigabe, Beschreibung und Risikoakzeptanz
und bietet die Neuadressierung an. „Zugestellt“ heißt weiterhin: in TaxTronik
als Auftrag bzw. Hinweis eingeplant; ein späteres `SKIPPED` oder `FAILED` der
Mail-Outbox meldet der Worker nicht zurück.

Für die einjährige Löschfrist gilt bei `FAILED` und `UNKNOWN` die Eskalation
als letzter Statuswechsel; das spätere Entfernen des Neuversandinhalts
verlängert die Frist nicht. Ein Auftrag, den die Kanzlei gerade erneut sendet,
wird im laufenden Löschlauf übersprungen und danach nach seinem neuen Status
beurteilt. Die Frist ist ein Kanzlei-Default, keine Rechtsfrist; einen
Legal Hold kennt der Löschlauf nicht.

## Beispiele

### Normalfall

Die Kanzlei lehnt eine Terminanfrage ab. Im selben Commit entsteht ein
Auftrag „Terminabsage“ an den anfragenden Kontakt. Der Worker prüft, dass die
Anfrage weiterhin abgelehnt ist, sendet, und der Kalender zeigt
„vom Versanddienst angenommen“.

### Grenzfall

Eine GwG-Einladung scheitert sechsmal am Versanddienst und endet als
`FAILED`. Die Kanzlei zieht die Einladung danach zurück und klickt
„Erneut senden“. Die Aktualitätsprüfung erkennt den Rückzug; der Auftrag endet
als `SKIPPED` mit Begründung, ohne Mail, und die Entscheidung steht im
Prüfprotokoll. Ob der Mandant auf anderem Weg informiert werden muss,
entscheidet die Kanzlei.

## Umsetzung in TaxTronik

Die Web-App legt Aufträge über `enqueueDirectMailTx` (eine Adresse) oder
`enqueueClientContactsMailTx` (alle Kontakte, Auflösung beim Versand) in der
Tenant-Transaktion des Vorgangs an und stößt den Worker nach dem Commit an; ein
Minutentakt holt verlorene Anstöße nach. Geheime Variablen wie ein
Einladungslink liegen nur Secret-Box-verschlüsselt und an Kanzlei und Auftrag
gebunden vor. Die App-Rolle darf Aufträge nur anlegen und lesen; den einzigen
Statuswechsel aus der Web-App, „Erneut senden“, kapselt die Funktion
`app.mail_outbox_resend` im Kanzleikontext.

Der Worker beansprucht einen Auftrag per Compare-and-Swap, bevor er den
Versanddienst kontaktiert, und prüft in derselben Tenant-Transaktion die
Aktualität. Ein n8n-Ereignis der Mail trägt den Dedupe-Schlüssel des Auftrags,
sodass Wiederholungen kein zweites Ereignis erzeugen. Mit dem Endstatus
werden Empfänger, Variablen, Anhangsverweise und geheime Variablen entfernt,
außer bei `FAILED` und `UNKNOWN` innerhalb des Neuversandfensters. Status,
Zähler, Zeitpunkte und Vorgangsverweis bleiben als Metadaten erhalten.

Der tägliche Worker `mail-outbox-retention` löscht diese Metadaten ein
Kalenderjahr nach dem letzten Statuswechsel, gleich berechnet wie die
pseudonyme Steuertermin-Versandhistorie (strikt älter als der Stichtag). Er
arbeitet je Kanzlei über die App-Rolle im SYSTEM-Kontext; die Funktion
`app.mail_outbox_purge_terminal` erzwingt Kontext, Endstatus, ein Mindestalter
des Stichtags von einem Jahr und die Stapelgröße. Die App-Rolle erhält dafür
kein allgemeines Löschrecht. Lauf, Stichtag, Löschzähler je Kanzlei und der
verbleibende Rückstand stehen im Log und im Job-Ergebnis
(DSGVO-OPERATIONAL-RETENTION-001).

Beim Bearbeiten und Absagen im Kanzleikalender bietet der Dialog „Mandant per
E-Mail informieren“ an, vorausgewählt mit den Empfängern oder deaktiviert mit
Grund. Die Server-Actions prüfen die Empfänger erneut, bevor sie etwas
schreiben, legen die Aufträge `appointment-changed` bzw.
`appointment-cancelled` im Commit der Änderung an und vermerken ihre Zahl im
Audit-Eintrag `appointment.update` bzw. `appointment.cancel`. Die Mails nennen
Titel, Zeit und Ort bzw. die Absage, nie die internen Notizen; die
Änderungsmail speichert zusätzlich den angekündigten Stand (nicht gerendert),
den die Aktualitätsprüfung vor jedem Versand mit dem Termin vergleicht. Die
Texte kommen aus den System-Vorlagen „Termin geändert (Kanzlei)“ und „Termin
abgesagt (Kanzlei)“ (für bestehende Kanzleien geseedet, anpassbar) oder dem
gleichlautenden Ersatztext. Der Kalender zeigt Zustellstatus und „Erneut
senden“ unter „Mandanten-Mails zu Terminänderungen“.

Mitteilungen des Tax-CMS holt der Worker `tcms-nachrichten-zustellen`
minütlich mit einem Systemakteur je Tenant ab (feste, zufällige ID, nur im
Worker gebildet, nur die drei Nachrichten-Endpunkte; ein Lauf je Tenant). Je
Mitteilung prüft er in einer Tenant-Transaktion die Empfänger allein gegen
TaxTronik, legt eine eindeutige Zustellzeile an und plant den Auftrag
(`tcms-freigabe-angefordert`, `tcms-freigabe-code`,
`tcms-freigabe-neu-adressiert`; Vorgang `tcms_nachricht`) bzw. den Hinweis
ein; erst nach dem Commit meldet er die Zustellung bzw. die Unzustellbarkeit
(404 und 409 gelten als erledigt). Der
Code liegt nur Secret-Box-verschlüsselt im Auftrag; jeder Endstatus entfernt
ihn (Datenbank-CHECK). Texte und Betreff des Tax-CMS werden nicht übernommen;
es gelten die System-Vorlagen „Tax-CMS: …“ (für bestehende Kanzleien
geseedet, Platzhalter in der Vorlagenverwaltung erklärt) oder der
gleichlautende Ersatztext. Logs nennen nur Tenant, Nachrichten-ID, Zweck und
Grundcode.

Am Vorgang zeigt eine Statuszeile je Anlass den zusammengefassten Stand; bei
`FAILED` und `UNKNOWN` mit erhaltenem Inhalt bietet sie „Erneut senden“ an.
Das Gate entspricht der auslösenden Aktion (Einzelrecht, Modul,
Mandantenzugriff; bei der GwG-Begrüßung der zugeordnete Berufsträger).

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise. Die technische Annahme durch den Versanddienst beweist weder Zugang noch
Kenntnisnahme. Terminänderungen und -absagen lösen nur mit ausdrücklicher
Auswahl eine Mail aus; ein n8n-Ereignis entsteht dafür nicht. Neue Kanzleien
erhalten die System-Vorlagen der Terminmitteilungen nicht automatisch und
versenden den Ersatztext. Die 30-Tage-Frist für den Neuversand,
die einjährige Löschfrist der Metadaten und die Zahl von sechs Versuchen sind
nicht fachlich freigegeben. Der Löschlauf schreibt keinen Auditnachweis; Zähler
und Stichtag stehen nur im Worker-Log und Job-Ergebnis. Eine
Rechtsgrundlage, die eine dieser Mails vorschreibt oder ihren Inhalt bestimmt,
ist im Katalog nicht belegt. Mitteilungen des Tax-CMS haben keine
Statuszeile an einem Vorgang; ihr Stand steht in der Zustellzeile (nur
Betrieb) und im Hinweis an die Admins. Zustellzeilen werden 30 Tage nach der
Meldung gelöscht; liefert das Tax-CMS danach (etwa nach einer
Wiederherstellung) eine gemeldete Mitteilung erneut, würde sie erneut
zugestellt. Zurückgestellte Mitteilungen belegen den ältesten-zuerst-Abruf
(50 je Lauf) bis zur Korrektur oder zum Abschluss.

## Fachliche Prüffragen

- Welche Vorgänge verlangen fachlich eine Mail an den Mandanten, und ist dafür
  eine Rechtsgrundlage zu dokumentieren?
- Genügt die technische Annahme als Kanzleinachweis, oder ist für einzelne
  Anlässe ein Zugangsnachweis auf anderem Weg nötig?
- Sind 30 Tage für den Neuversand und ein Jahr für die Auftragsmetadaten
  angemessen, und braucht die Löschung einen Auditnachweis?
- Wer prüft „unklar“ und „nur teilweise angenommen“ und informiert den
  Mandanten gegebenenfalls direkt?
- Genügt für Terminmitteilungen an Kontakte ohne bestätigten Portal-Login die
  Regel der Entscheidungsmail, oder ist ein bestätigter Login zu verlangen?
- Ist es vertretbar, Mitteilungen des Tax-CMS (insbesondere Bestätigungscodes)
  ohne Rücksicht auf die Benachrichtigungs-Einstellung, aber nur an per
  Portal-Anmeldung bestätigte Adressen zu senden?
- Sind 7 Tage bis zum Abschluss als unzustellbar angemessen, und genügt der
  einmalige Hinweis an Admins und Partner?

## Technische Nachweise

Die Vertragstests belegen, dass ein Auftrag exakt die bisherigen
Versandoptionen ergibt und geheime Variablen nur verschlüsselt speichert. Die
Relevanztests belegen je Anlass gewollt und überholt. Die Worker-Tests belegen
Claim, Backoff, `FAILED`, `UNKNOWN`, `PARTIAL_FAILURE`, `NO_RECIPIENT`,
`SKIPPED`, Kanzlei-Hinweise und das Entfernen des Inhalts; die
Datenbanktests belegen Compare-and-Swap, CHECKs, Tenant-Isolation und die
Rechte der App-Rolle. Die Löschtests belegen gegen PostgreSQL die Grenze von
genau einem Jahr, den Schutz wartender und laufender Aufträge, die Eskalation
als Bezugszeitpunkt bei `FAILED`/`UNKNOWN`, mehrere Stapel, Idempotenz und die
Tenant-Grenze. Die Terminmitteilungstests belegen Empfängerregeln und Gründe,
die Actions mit und ohne Auswahl sowie ohne erreichbaren Kontakt, die
Checkbox im Dialog und gegen PostgreSQL das Verwerfen überholter Änderungs-
mails, den Versand der Absage und die idempotenten System-Vorlagen. Die
Web-Tests belegen Anstoß, Statusanzeige und
„Erneut senden“ mit Gate, Rückfrage und Audit. Für die Mitteilungen des
Tax-CMS belegen die Datenbanktests des Workers Empfängerprüfung je Grund,
Einplanung mit verschlüsseltem Code und Entfernen nach dem Versand, Meldung
erst nach dem Commit, 404 als erledigt, keine Doppelzustellung (zweiter Lauf,
gleichzeitige Einplanungen und Läufe, eindeutiger Auftrag), einmaligen Hinweis,
Abschluss nach 7 Tagen und nach Gültigkeitsende mit Meldung „unzustellbar“
und festem Grund (nie „zugestellt“), die Wiederholung mit demselben Grund nach
gescheiterter Meldung trotz geänderter Kontaktdaten, 409 als erledigt mit
inhaltsfreiem Log, den festen, unveränderlichen und für die App-Rolle
unsichtbaren Systemakteur und mit dem echten Client nur die drei
Nachrichten-Endpunkte (Body der Meldung nur `{ grund }`); ein Unit-Test belegt
die vollständige, feste Abbildung der Gründe; Guards in Web und Worker belegen, dass nur der
Worker den Systemakteur bildet. Die Restore-Abnahme (`restore-security.ts`,
CI-Selbsttest) weist einen wiederhergestellten Stand ab, in dem die App-Rolle
ein Recht auf `tcms_systemakteur` oder `tcms_nachricht_zustellung` hat. Eine
Zustellung beim Mandanten
belegen sie nicht.
