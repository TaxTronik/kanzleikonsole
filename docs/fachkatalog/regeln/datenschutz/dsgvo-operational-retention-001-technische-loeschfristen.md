---
id: DSGVO-OPERATIONAL-RETENTION-001
title: Feste technische Löschfristen für definierte Betriebsdaten anwenden
domain: datenschutz
rule_type: office_policy
jurisdiction: EU/DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Berufsträger Datenschutz
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Tägliche Worker löschen oder neutralisieren ausgewählte Datenklassen nach
    festen Kanzlei-Defaults und protokollieren Treffer sowie Cutoffs. Einen
    anhaltenden Rückstand der Orphan-Bereinigung melden sie als Health-Kennzahl
    und ab einer festen Schwelle als Alarm. Eine allgemeine Rechtsgrundlagen-,
    Legal-Hold- oder Datenklassen-Engine fehlt.
sources:
  - kind: internal_policy
    citation: DSGVO-Lösch-, Aufbewahrungs- und Verarbeitungskonzept, feste Betriebsfristen
    path: docs/compliance/dsgvo-konzept.md
    checked_at: '2026-08-24'
    primary: true
  - kind: official_law
    citation: Art. 5 Abs. 1 Buchst. e, Art. 17 und Art. 18 DSGVO
    url: https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=de
    checked_at: '2026-08-24'
    primary: false
code_refs:
  - apps/worker/src/jobs/storage-orphan-cleanup.ts
  - apps/worker/src/run-budget.ts
  - apps/worker/src/maintenance-backlog.ts
  - apps/web/src/server/jobs/maintenance-backlog.ts
  - packages/db/prisma/migrations/20261007141000_notification_kind_maintenance_backlog/migration.sql
  - packages/db/prisma/migrations/20261007141100_notification_daily_dedupe_maintenance_backlog/migration.sql
  - packages/db/prisma/schema.prisma
  - apps/worker/src/jobs/dsgvo-retention.ts
  - apps/worker/src/jobs/n8n-retention.ts
  - apps/worker/src/jobs/magic-link-cleanup.ts
  - apps/worker/src/jobs/portal-inbox-cleanup.ts
  - apps/web/src/server/inbox/retention-settings.ts
test_refs:
  - apps/worker/src/jobs/__tests__/storage-orphan-cleanup.test.ts
  - apps/worker/src/jobs/__tests__/storage-orphan-cleanup-db.test.ts
  - apps/worker/src/__tests__/run-budget.test.ts
  - apps/worker/src/__tests__/maintenance-backlog.test.ts
  - apps/web/src/server/jobs/__tests__/maintenance-backlog.test.ts
  - apps/worker/src/jobs/__tests__/dsgvo-retention.test.ts
  - apps/worker/src/jobs/__tests__/n8n-retention.test.ts
  - apps/worker/src/jobs/__tests__/portal-inbox-cleanup.test.ts
feature_refs:
  - docs/compliance/dsgvo-konzept.md
related_rules:
  - DSGVO-MANDATE-ANONYMIZATION-001
  - DOC-RETENTION-CLASS-001
  - PORTAL-INBOX-SUBMISSION-001
tags:
  - loeschung
  - retention
  - kanzleipolicy
---

# DSGVO-OPERATIONAL-RETENTION-001 — Feste technische Löschfristen für definierte Betriebsdaten anwenden

## Kurzfassung

TaxTronik setzt für ausdrücklich benannte Betriebsdaten feste technische
Lösch- oder Neutralisierungsfristen durch. Diese Werte sind Kanzlei-/Produkt-
Defaults, keine aus Art. 5 oder Art. 17 DSGVO unmittelbar ableitbaren
Einzelfristen. Die Kanzlei muss Zweck, Rechtsgrundlage, Aufbewahrungspflicht und
Sperrbedarf je Datenklasse prüfen.

## Wann gilt die Regel?

Die Regel gilt für Notifications, pseudonyme Steuertermin-Versandhistorie,
Telefonnotizen, alte Login-Zeitpunkte, terminale Anforderungen samt Antworten,
n8n-Outbox-/Ausnahmehistorie, Callback-Idempotenzbelege und bereinigungsfähige
Magic Links. Sie gilt nicht als allgemeine Löschlogik für sämtliche Tabellen,
Dokumente, Auditdaten oder externe Systeme.

## Benötigte Angaben

- Tenant und Datenklasse
- maßgeblicher Erstellungs-, Änderungs-, Abschluss- oder Archivierungszeitpunkt
- terminaler Status und Fehlen aktiver Zustellungen
- bei Anforderungen: jüngste Antwort und verknüpfte GoBD-Dokumentklasse
- kanzleiseitig freigegebene Frist und bekannte Sperrgründe

## Entscheidungslogik

| Datenklasse                                       | Produktfrist und Aktion                                  | Einordnung                            |
| ------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- |
| Notifications und Steuertermin-Versandhistorie    | nach einem Jahr löschen                                  | fester Kanzlei-Default                |
| Telefonnotizen                                    | nach drei Jahren löschen                                 | fester Kanzlei-Default                |
| `client_contact.lastLoginAt`                      | nach zwei Jahren nullen                                  | Datenminimierung ohne Kontaktlöschung |
| terminale Anforderung ohne längeren Dokumentbezug | jahresende-basiert nach sechs Jahren löschen             | Produktklasse                         |
| terminale Anforderung mit GoBD-Bezug              | je Dokumenttyp nach sechs, acht oder zehn Jahren löschen | längste erkannte Produktklasse        |
| n8n-Routinehistorie                               | nach 90 Tagen löschen                                    | Betriebs-Default                      |
| n8n-Ausnahmehistorie und Callback-Belege          | nach 180 Tagen löschen                                   | Betriebs-/Diagnose-Default            |
| aktive n8n-Zustellung                             | nicht löschen                                            | laufende Verarbeitung schützen        |
| offener Inbox-Uploadentwurf                       | nach 24 Stunden als abgelaufen behandeln                 | Produktdefault, keine Rechtsfrist     |
| abgelehnte oder blockierte Inbox-Bytes            | nach sieben Tagen über das Orphan-Journal löschen        | Quarantäne-Default, keine Rechtsfrist |

## Ausnahmen und Grenzfälle

Bei Anforderungen werden nur terminale Vorgänge erfasst; neuere Antworten
blockieren den Treffer. Lose Verweise werden vor dem Löschen neutralisiert und
unter Row-Lock erneut geprüft. Die Worker kennen aber keinen allgemeinen
Legal Hold, keine fallbezogene Interessenabwägung und keine dynamische
Rechtsgrundlagenakte. In Freitexten können andere Aufbewahrungspflichten oder
Beweisinteressen verborgen sein.

## Beispiele

### Normalfall

Eine drei Jahre alte Telefonnotiz trifft den tenantgebundenen Cutoff. Der
Worker löscht sie und nimmt den Zähler in den zusammenfassenden Auditnachweis
des Laufs auf.

### Grenzfall

Eine acht Jahre alte geschlossene Anforderung besitzt eine neuere Antwort oder
ein verknüpftes Dokument mit zehnjähriger Klasse. Sie darf nicht nach dem
allgemeinen Sechsjahresfenster gelöscht werden. Ein außerhalb des Systems
bekannter Rechtsstreit wird dagegen nicht automatisch erkannt.

## Umsetzung in TaxTronik

Der gemeinsame Orphan-Worker zieht je Lauf Batch um Batch zu je 100
Kandidaten, bis kein fälliger Kandidat mehr übrig ist oder das Zeitbudget von
zehn Minuten verbraucht ist; fährt der Worker herunter, endet der Lauf vor dem
nächsten Schritt. Die Auswahl priorisiert die geringste Zahl bisheriger
Bereinigungsversuche, danach Alter und ID. Ein in diesem Lauf gescheiterter
Kandidat kommt erst im nächsten Lauf erneut an die Reihe. So blockiert ein
voller Batch dauerhaft fehlender oder mehrdeutiger Speicheridentitäten keine
späteren bereinigungsfähigen Objekte. Die Schutz-, Referenz- und
Versionsprüfungen bleiben Voraussetzung jeder physischen Löschung. Ab dem
fünften gescheiterten Versuch erscheint zusätzlich ein Betriebswarnhinweis zur
manuellen Klärung. Den danach weiterhin fälligen, unaufgelösten Rückstand
meldet der Lauf im Job-Ergebnis; die Jobübersicht der Administration zeigt ihn
als „Rückstand“. Der Regressionstest belegt in einem Lauf mit 100 dauerhaft
fehlerhaften Objekten und einem jüngeren löschbaren Objekt, dass das löschbare
Objekt im zweiten Batch gelöscht wird und jeder gescheiterte Kandidat höchstens
einen Versuch je Lauf erhält. Weitere Tests belegen den Nachlauf über mehrere
Batches und das Ende am Zeitbudget mit gemeldetem Rückstand.

Der Lauf misst den Rückstand je Tenant mit derselben Fälligkeitsbedingung wie
Auswahl und Claim, samt Fälligkeit des ältesten Kandidaten (Journaleintrag
plus Sicherheitsfrist, bei Object Lock frühestens das Retention-Ende), und
meldet daraus eine Health-Kennzahl: Anzahl, ältester offener Kandidat und Läufe
in Folge mit Rückstand, sichtbar in der Jobübersicht und für ADMIN/PARTNER in
`/api/health/detail`, ohne Kanzleibezug. Besteht der Rückstand nach drei
Läufen in Folge noch oder ist der älteste Kandidat seit mehr als sieben Tagen
fällig, erhalten die aktiven ADMIN/PARTNER jeder betroffenen Kanzlei einen
Hinweis mit deren eigenen Zahlen (höchstens eine Neuanlage je Empfänger und
Tag) und die Betriebsadresse `OPS_ALERT_EMAIL` höchstens eine Mail je Tag. Die
Schwelle ist eine Betriebsvorgabe, keine Löschfrist; der Alarm ändert weder
Auswahl noch Prüfungen oder Löschung. Ein Datenbanktest belegt die Messung
gegen PostgreSQL, Unit-Tests belegen Schwelle, Empfänger und Tagesdedupe.

Der DSGVO-Worker berechnet tenantbezogene Cutoffs, löscht beziehungsweise
nullt die definierten Klassen und schreibt nur bei tatsächlichen Änderungen
einen zusammenfassenden Audit-Eintrag. Der Request-Purge arbeitet in Batches,
revalidiert unter Sperren und neutralisiert Referenzen. Der n8n-Worker trennt
Routine-, Ausnahme- und Callbackfristen und lässt aktive Zustellungen bestehen.

Anforderungen mit persönlicher Bescheidentscheidung/Feedback oder einer
Jahreskampagnenzuordnung sind vom pauschalen Request-Purge ausgeschlossen.
Die neuen unveränderlichen Fachnachweise dürfen nicht durch das Auflösen
eines Fremdschlüssels unbemerkt entfernt werden. Eine eigene fachlich geprüfte
Fachfalllöschung und deren Nachweisführung bleiben erforderlich; daraus wird
keine neue pauschale Aufbewahrungsdauer abgeleitet.

Der sichere Mandantenposteingang ergänzt Nachrichten-, Staging-, Scan-,
Entscheidungs- und Lesedaten. Offene Uploadentwürfe besitzen einen
24-Stunden-Produktdefault. Abgelehnte oder blockierte Bytes verbleiben sieben
Tage in technischer Quarantäne und werden danach ausschließlich über das
idempotente Storage-Orphan-Journal zur Löschung vorgemerkt. Angenommene
Staging-Bytes dürfen nach der hash-erhaltenden Archivübernahme ebenfalls über
diesen Journalpfad bereinigt werden. Bereits journalisierte Identitäten werden
auch nach abgeschlossener Object-Store-Bereinigung nicht erneut selektiert.
Fehlen bei einem mindestens 24 Stunden alten, verworfenen oder abgelaufenen
PENDING-Intent nach eindeutiger Recovery-Prüfung die Bytes, werden ausschließlich
die kontaktprivate Intent-Zeile und ein inhaltsfreier Auditnachweis atomar im
Tenant-`SYSTEM`-Kontext geschrieben. Für abgesendete Threads wird keine stille
Löschung ausgeführt; ihr konfigurierbarer Kanzleiwert muss vor Aktivierung
organisatorisch dokumentiert sein. Legal Hold und die fachliche Angemessenheit
dieser Defaults bleiben vor dem Produktivpilot zu entscheiden.

## Bekannte Abweichungen und Grenzen

Die Umsetzung ist teilweise, weil nur eine geschlossene Liste technischer
Datenklassen abgedeckt ist. Die Fristen sind feste Defaults und keine
fallbezogene Rechtsprüfung. Es fehlen ein allgemeines Legal-Hold-Modell,
konfigurierbare Freigaben je Kanzlei, vollständige Abdeckung aller
personenbezogenen Tabellen sowie der Nachweis einer Löschung in angebundenen
externen Systemen.

Der Inbox-Cleanup löscht Object-Store-Daten nicht direkt, sondern erzeugt
nachweisbare, idempotente Orphan-Einträge. Die anschließende allgemeine
Orphan-Bereinigung bleibt der gemeinsame Löschpfad. Dies umfasst auch saubere,
noch nicht fachlich entschiedene Anlagen aus mindestens 24 Stunden alten,
terminalen Uploadentwürfen, solange sie an keine Nachricht gebunden sind;
abgesendete `PENDING_REVIEW`-Eingänge werden nicht erfasst. Nur ein nie
abgesendeter PENDING-Intent ohne auffindbare Bytes wird nach dem
24-Stunden-Default samt gekoppeltem Auditnachweis aus dem
Staging-Metadatenbestand entfernt. Nicht umgesetzt sind eine automatische
Nachrichtenlöschung und ein allgemeines Legal-Hold-Modell.

## Fachliche Prüffragen

- Sind die festen Fristen je Datenklasse und Kanzleizweck angemessen?
- Welche Sperr- und Legal-Hold-Gründe müssen technisch abbildbar sein?
- Welche weiteren Tabellen und externen Systeme gehören in das Löschkonzept?
- Wer genehmigt Friständerungen und dokumentiert deren Geltungsbeginn?

## Technische Nachweise

Die Worker-Tests belegen tenantgebundene Cutoffs, Jahresende-Logik,
Statusfilter, Revalidierung, Referenzneutralisierung, getrennte n8n-Fristen und
den zusammenfassenden Auditnachweis. Sie belegen keine Vollständigkeit des
Löschkonzepts oder fachliche Angemessenheit der Defaults.
