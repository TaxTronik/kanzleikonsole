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
    lösen auf ausdrücklichen Wunsch eine Mail aus. Die technische Annahme ist
    kein Zugangsnachweis; die fachliche Freigabe der Fristen fehlt.
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
feature_refs:
  - docs/anwenderdoku/administration.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - ACCESS-TENANT-RLS-001
  - ACCESS-STAFF-PERMISSION-001
  - DSGVO-OPERATIONAL-RETENTION-001
  - AUDIT-HASH-CHAIN-001
tags:
  - e-mail
  - outbox
  - zustellstatus
  - mandantenkommunikation
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
Kalender ausdrücklich auswählt. Sie gilt nicht für Anmelde- und Sicherheitsmails (Magic Link,
Einladung zum Portal), die automatische Steuertermin-Anforderung mit eigener
Versandhistorie, interne Mitarbeiterbenachrichtigungen, n8n-Ereignisse ohne
Mail und den Posteingang.

## Benötigte Angaben

- Kanzlei, Mandant und Vorgang (Typ und ID), an dem der Status angezeigt wird
- Versandanlass und Vorlagenkennung samt Variablen; geheime Variablen getrennt
- Empfängerart: genau eine Adresse oder alle bestätigten Kontakte
- bei Terminänderung und -absage: Auswahl „Mandant per E-Mail informieren“,
  Herkunft des Termins (Terminanfrage oder Kalender) und Kontakte des Mandanten
- angekündigter Vorgangsstand, wo die Aktualitätsprüfung ihn vergleicht
- aktueller Zustand des Vorgangs zum Versandzeitpunkt
- Versuchszähler, Zeitpunkte und Antwort des Versanddienstes

## Entscheidungslogik

| Wenn                                                                                  | Dann                                                                                               | Begründung                                         |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| der Vorgang wird gespeichert                                                          | Versandauftrag im selben Commit; ein Rollback verwirft auch den Auftrag                            | keine Mail ohne gespeicherten Vorgang              |
| vor einem Versuch ist der Mandant anonymisiert oder der Anlass entfallen              | `SKIPPED` mit Begründung, Inhalt entfernt, kein SMTP-Kontakt, keine Kanzlei-Benachrichtigung       | keine überholte Mail                               |
| der Versanddienst nimmt alle Empfänger an                                             | `PROVIDER_ACCEPTED`, Inhalt entfernt                                                               | nur technische Annahme                             |
| eindeutig gescheitert (Ablehnung, Auftrag nicht vorbereitbar, SMTP-Konfiguration)     | erneuter Versuch mit wachsendem Abstand, nach sechs Versuchen `FAILED` und Kanzlei-Hinweis         | kein Doppelversand möglich                         |
| Ausgang unklar oder begonnener Versuch nach 30 Minuten nicht abgeschlossen            | `UNKNOWN` und Kanzlei-Hinweis, kein automatischer Neuversand                                       | Doppelversandrisiko                                |
| nur ein Teil der Kontakte angenommen                                                  | `PARTIAL_FAILURE` und Kanzlei-Hinweis, kein automatischer Neuversand                               | Doppelversandrisiko                                |
| Kontaktmail ohne aktiven, per Portal-Login bestätigten Kontakt mit Benachrichtigungen | `NO_RECIPIENT` ohne Kanzlei-Hinweis, am Vorgang sichtbar                                           | bisheriges Empfängerverhalten                      |
| Kanzlei wählt „Erneut senden“ bei `FAILED` oder `UNKNOWN`                             | gleiche Berechtigung wie der Auslöser, Aktualitätsprüfung, dann `QUEUED` oder `SKIPPED`, auditiert | bewusste Entscheidung; bei `UNKNOWN` mit Rückfrage |
| letzter Statuswechsel eines Auftrags im Endstatus liegt mehr als ein Jahr zurück      | Auftrag samt Metadaten löschen; der Vorgang zeigt für diese Mail keinen Status mehr                | Entscheidung A8, wie die Versandhistorie           |
| Auftrag wartet oder läuft (`QUEUED`, `RETRY_PENDING`, `SENDING`)                      | nie löschen                                                                                        | laufende Zustellung schützen                       |
| Kanzlei bearbeitet oder sagt einen Termin ab, ohne „Mandant per E-Mail informieren“   | keine Mail                                                                                         | ausdrückliche Entscheidung je Vorgang              |
| mit Auswahl, aber ohne Mandantenbezug, anonymisiert oder ohne erreichbaren Kontakt    | nichts speichern, Feld mit Grund markieren                                                         | keine stille Nichtzustellung                       |
| mit Auswahl: Termin aus Terminanfrage dieses Mandanten                                | ein Auftrag an den anfragenden Kontakt, wenn aktiv und mit Benachrichtigungen                      | Regel der Entscheidungsmail                        |
| mit Auswahl: sonstiger Termin                                                         | je aktivem Kontakt mit Benachrichtigungen ein Auftrag, alle mit gemeinsamem Erstellungszeitpunkt   | Regel der Entscheidungsmail je Kontakt             |
| Änderung ohne neuen Titel, neue Zeit oder neuen Ort oder als erledigt gespeichert     | keine Änderungsmail                                                                                | nichts mitzuteilen                                 |
| vor dem Versand weicht der Termin vom angekündigten Stand ab oder ist abgesagt        | Änderungsmail `SKIPPED` mit Grund                                                                  | nur der aktuelle Stand geht hinaus                 |
| Termin hat vor dem Versand begonnen                                                   | Änderungs- oder Absagemail `SKIPPED` mit Grund                                                     | Mitteilung überholt                                |

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
ist im Katalog nicht belegt.

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
„Erneut senden“ mit Gate, Rückfrage und Audit. Eine Zustellung beim Mandanten
belegen sie nicht.
