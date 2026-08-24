---
id: TAX-DEADLINE-AUTOREQUEST-001
title: Automatische Mandantenanforderung vor Steuerterminen steuern
domain: fristen-und-bescheide
rule_type: product_rule
jurisdiction: DE
validity:
  valid_from: null
  valid_until: null
professional_owner_role: Prozessverantwortlicher Deklaration
professional_review:
  status: unreviewed
  reviewer: null
  reviewed_at: null
  reviewed_content_hash: null
implementation:
  status: partial
  summary: >-
    Portal-Anforderung und Benachrichtigung sind getrennt persistiert;
    Request-Anlage, Vormerkung, begrenzter Retry eindeutiger Totalfehler,
    Fail-closed-Behandlung unklarer Ergebnisse und laufender Versandclaims
    sowie atomare interne Eskalation an aktive Zuständige sind umgesetzt.
    Externer Versand ist auf offene Requests begrenzt. Provider-Annahme beweist
    weder Zustellung noch Zugang.
sources:
  - kind: product_documentation
    citation: Funktionskatalog Steuertermine und automatische Anforderungen
    path: FEATURES.md
    checked_at: '2026-08-23'
    primary: true
  - kind: product_documentation
    citation: Benutzerhandbuch Kalender, Fristen und Bescheide
    path: docs/anwenderdoku/kalender-fristen-bescheide.md
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: § 57 Abs. 1 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__57.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: § 62a Abs. 2 bis 5 StBerG
    url: https://www.gesetze-im-internet.de/stberg/__62a.html
    checked_at: '2026-08-23'
    primary: false
  - kind: official_law
    citation: Art. 5, 6, 28 und 32 DSGVO
    url: https://eur-lex.europa.eu/legal-content/DE/TXT/HTML/?uri=CELEX%3A02016R0679-20160504
    checked_at: '2026-08-23'
    primary: false
code_refs:
  - packages/tax/src/materialize.ts
  - apps/web/src/lib/tax-deadline-pipeline.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/actions.ts
  - apps/web/src/app/staff/(protected)/tax-deadlines/group/page.tsx
  - apps/web/src/app/staff/(protected)/tax-deadlines/actions.ts
  - apps/worker/src/jobs/tax-deadline-materialize.ts
  - apps/worker/src/jobs/tax-deadline-notification.ts
  - apps/worker/src/jobs/dsgvo-retention.ts
  - apps/worker/src/jobs/reminders-daily.ts
  - packages/mail/src/dispatch.ts
  - packages/mail/src/request-opened.ts
  - packages/db/prisma/schema.prisma
  - packages/db/prisma/migrations/20260823200100_tax_deadline_notification_kind/migration.sql
  - packages/db/prisma/migrations/20260823201000_tax_professional_control_model/migration.sql
test_refs:
  - packages/tax/src/__tests__/materialize.test.ts
  - packages/mail/src/__tests__/dispatch-profile-context.test.ts
  - packages/mail/src/__tests__/request-opened.test.ts
  - apps/web/src/lib/__tests__/tax-deadline-pipeline.test.ts
  - apps/web/src/app/staff/(protected)/clients/[id]/tax-schedule/__tests__/actions.test.ts
  - apps/web/src/app/staff/(protected)/tax-deadlines/__tests__/actions.test.ts
  - apps/worker/src/jobs/__tests__/tax-deadline-materialize.test.ts
  - apps/worker/src/jobs/__tests__/tax-deadline-notification.test.ts
  - apps/worker/src/jobs/__tests__/dsgvo-retention.test.ts
  - packages/db/src/__tests__/tax-deadline-request-consistency.test.ts
feature_refs:
  - FEATURES.md
  - docs/anwenderdoku/kalender-fristen-bescheide.md
related_rules:
  - TAX-DEADLINE-WORKDAY-001
  - TAX-CONTROL-STATUS-001
tags:
  - anforderung
  - automation
  - steuertermin
---

# TAX-DEADLINE-AUTOREQUEST-001 — Automatische Mandantenanforderung vor Steuerterminen steuern

## Kurzfassung

TaxTronik darf zu einem bevorstehenden Steuertermin genau eine
Portal-Anforderung anlegen, wenn die Kanzlei die Automatik aktiviert, der
Mandant freigeschaltet ist und keine dokumentierte Sperre besteht. Nach Ablauf
des Fälligkeitstags wird keine neue automatische Anforderung mehr angelegt.

Portal-Anforderung und Benachrichtigung sind getrennte Vorgänge. Der intern
persistierte Zustand `PROVIDER_ACCEPTED` bedeutet ausschließlich, dass alle
ermittelten Einzelversuche technisch ohne Fehler vom konfigurierten
Mail-Dispatcher angenommen wurden. Er belegt weder Zustellung noch Zugang oder
Kenntnisnahme beim Mandanten. Auch ein n8n-Ereignis ist kein solcher Nachweis.

## Wann gilt die Regel?

Die Regel gilt für aktive Steuertermin-Konfigurationen, freigeschaltete
Mandanten und Fälligkeiten im Materialisierungshorizont. Sie steuert
ausschließlich den Kanzleiprozess.

Sie entscheidet nicht, wann Unterlagen materiell-rechtlich oder nach dem
Mandatsvertrag anzufordern sind, ob eine E-Mail zugegangen ist, ob Verzug
eintritt oder ob ein externer Versand- beziehungsweise Automationsdienst in der
konkreten Kanzlei eingesetzt werden darf.

## Benötigte Angaben

- aktive Konfiguration und fachlich freigegebene Terminart
- Fälligkeitsdatum sowie Vorwarn- und Anforderungsabstand
- Freischaltstatus des Mandanten
- aktive Portal- und Kontaktzuordnung mit Benachrichtigungsfreigabe und einem
  im Kontakt gespeicherten erfolgreichen Portal-Login
- aktive hauptverantwortliche Personen; ersatzweise aktive Admins oder Partner
- möglicher manueller Stopp mit Grund, Person und Zeitpunkt
- bereits verknüpfte Portal-Anforderung
- eigener Benachrichtigungs-, Fehler- und Versuchszustand
- eingesetzte interne oder externe Versand- und Automationsdienste

## Entscheidungslogik

| Wenn                                                             | Dann                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Termin liegt außerhalb des Vorschauhorizonts                     | noch keinen Termin materialisieren                                      |
| Konfiguration inaktiv oder Mandant nicht freigeschaltet          | keine automatische Anforderung                                          |
| Vorwarnfenster erreicht                                          | intern vorwarnen; spätere Anlage bleibt stoppbar                        |
| Anforderungsfenster erreicht, keine Sperre und keine Verknüpfung | genau eine Portal-Anforderung atomar anlegen und verknüpfen             |
| Pipeline gestoppt                                                | bis zur dokumentierten Freigabe keine Anforderung anlegen               |
| Fälligkeitstag vollständig abgelaufen                            | keine neue automatische Anforderung                                     |
| Request bereits verknüpft                                        | keine zweite Anforderung erzeugen                                       |
| Request ist nicht mehr `OPEN` oder `IN_PROGRESS`                 | nicht extern senden; technischen Pointer terminal lösen                 |
| alle Einzelversuche scheitern eindeutig                          | denselben Request höchstens dreimal versuchen; danach intern eskalieren |
| nur ein Teil wird technisch angenommen                           | nicht blind erneut senden; als Teilfehler intern eskalieren             |
| kein aktiver Kontakt mit Opt-in und gespeichertem Portal-Login   | nicht senden; fehlenden Empfänger intern eskalieren                     |
| Ausgang des Versuchs ist unklar                                  | `UNKNOWN`; wegen Doppelversandrisiko kein automatischer Neuversand      |
| Request-Verknüpfung wird regulär entfernt                        | `ORPHANED`; keine weitere Verarbeitung, technische Historie erhalten    |

### Persistierte getrennte Zustände

Der fachliche Status der Portal-Anforderung bleibt im Request-Modell. Am
Steuertermin wird davon getrennt der technische Benachrichtigungszustand
persistiert:

| Zustand             | Aussage                                                                           |
| ------------------- | --------------------------------------------------------------------------------- |
| `NOT_REQUIRED`      | für diesen Termin ist kein aktiver Benachrichtigungsweg vorgemerkt                |
| `QUEUED`            | Request besteht und der erste Versuch ist vorgemerkt                              |
| `PROVIDER_ACCEPTED` | alle Einzelversuche wurden technisch angenommen; keine Zustellaussage             |
| `FAILED`            | eindeutiger Totalfehler; ein weiterer Versuch ist terminiert                      |
| `PARTIAL_FAILURE`   | nur ein Teil wurde angenommen; terminal und intern eskaliert                      |
| `UNKNOWN`           | In-Flight-Claim oder unklarer Ausgang; kein Blind-Retry, nach Abschluss eskaliert |
| `NO_RECIPIENT`      | kein aktiver Kontakt mit Opt-in und gespeichertem Portal-Login; intern eskaliert  |
| `ESCALATED`         | drei eindeutige Totalfehler; automatische Versuche beendet                        |
| `ORPHANED`          | Request-Link entfernt; kein Neuversand, technische Historie danach unveränderlich |

Die Zustände enthalten Versuchszahl, letzten und nächsten Versuch,
Provider-Annahme, letzten Fehler und Eskalationszeit. Keiner dieser Zustände
beweist tatsächlichen Zugang oder Kenntnisnahme.

## Ausnahmen und Grenzfälle

- Ein später Worker-Lauf kann die Vorwarnphase überspringen und unmittelbar im
  Anforderungsfenster anlegen.
- Parallele Läufe werden durch Datenbankregeln und atomare
  Compare-and-set-Logik auf dieselbe Request-Anlage zusammengeführt. Der
  Claim bindet dabei auch den gelesenen Snapshot von `reminderDaysBefore` und
  `staffLeadDays`; eine zwischenzeitliche Konfigurationsänderung wird nicht mit
  veralteten Abständen umgesetzt.
- Auch die interne Vorwarnung wird atomar beansprucht. Sie geht an alle aktiven
  Hauptbearbeiter; fehlen diese vollständig, werden alle aktiven Admins und
  Partner verwendet. Ohne aktiven internen Empfänger wird `staffNotifiedAt`
  nicht fälschlich als erledigt gesetzt.
- E-Mail und gegebenenfalls n8n-Ereignis folgen nach dem Datenbank-Commit und
  arbeiten immer mit derselben `requestId`. Fehler rollen die
  Portal-Anforderung nicht zurück. Das n8n-Ereignis wird je logischer
  Anforderung genau einmal ausgelöst, nicht einmal pro Kontakt.
- Vor dem externen I/O beansprucht der Worker den Versuch atomar als
  `UNKNOWN`. Stirbt der Prozess danach oder wirft der gemeinsame Dispatcher
  nach einem möglicherweise erfolgreichen SMTP- oder n8n-Schritt, wird nicht
  blind wiederholt.
- Nur wenn alle Einzelversuche durch eine ausdrückliche negative
  SMTP-Providerantwort eindeutig abgelehnt wurden, ist ein Retry zulässig.
  Eine Transport-, Socket- oder Timeout-Exception gilt als unklar, weil eine
  vorherige Annahme nicht sicher ausgeschlossen werden kann. Der nächste
  eindeutige Versuch ist in der Datenbank terminiert und der BullMQ-Lauf wird
  erneut angestoßen; nach Versuch drei folgt `ESCALATED`.
- Reguläres Entfernen des Request-Links setzt `ORPHANED` und erhält die
  Historie. Nur ein ausdrücklich dokumentierter DSGVO-Purge neutralisiert sie
  zu `NOT_REQUIRED` und löscht die Metadaten.
- Wird ein Steuertermin mit terminaler Anforderung gelöscht, archiviert die
  Datenbank nur pseudonyme technische IDs, Status, Versuchszahl, Zeitstempel
  und gegebenenfalls einen SHA-256-Wert des früheren Fehlertexts. Die App-Rolle
  besitzt kein Leserecht. Der Retention-Worker löscht diese Hilfsnachweise
  tenantgebunden spätestens ein Jahr nach Archivierung; ein früherer
  Request-Purge entfernt sie kaskadierend.
- Hat der verknüpfte Request bereits `RESPONDED`, `CLOSED` oder `CANCELLED`,
  beendet der Worker die technische Benachrichtigung ohne Versand als
  `ORPHANED`. Der Request bleibt über seinen Rückverweis auf den Steuertermin
  erhalten.
- Solange ein persistierter `UNKNOWN`-Claim mit Versuch, Versuchsbeginn und
  noch ohne Eskalation einen möglicherweise laufenden externen Versand
  bezeichnet, blockiert die Datenbank sowohl den normalen Unlink als auch den
  DSGVO-Purge. Erst ein gespeicherter Versandabschluss oder die
  Timeout-Eskalation hebt dieses Fail-closed-Gate auf.
- Bei unklarer oder veralteter Empfängeradresse ist externer Versand ein
  Vertraulichkeitsrisiko.

### Datenschutz und Verschwiegenheit

Die Automatik verarbeitet Mandats- und Kontaktdaten. Benachrichtigungen sollen
auf erforderliche Hinweise beschränkt bleiben und für Details auf das
geschützte Portal verweisen. Empfängerzuordnung, Zugriff, Übermittlung,
Protokollierung und Speicherfristen sind kanzleispezifisch zu prüfen.

Bei externen Diensten sind insbesondere sorgfältige Auswahl, Vertrag in
Textform, Verschwiegenheitsbindung, Auslandsschutz und bei unmittelbar einem
Mandat dienenden Leistungen gegebenenfalls die Mandanteneinwilligung nach
§ 62a Abs. 2 bis 5 StBerG zu berücksichtigen. Datenschutzrechtliche
Rechtsgrundlage, Auftragsverarbeitung und Drittlandübermittlung bleiben
außerhalb dieser Produktregel.

## Beispiele

### Normalfall

Nach der internen Vorwarnung legt ein späterer Tageslauf atomar eine
Portal-Anforderung an und setzt den Benachrichtigungsstatus auf `QUEUED`. Nach
dem Commit beansprucht der Worker den Versuch und setzt bei vollständiger
technischer Annahme `PROVIDER_ACCEPTED`. Die Request-Anlage bleibt davon
fachlich unabhängig.

### Fehlgeschlagene E-Mail

Die Portal-Anforderung wurde erfolgreich gespeichert, der Mailversand schlägt
für sämtliche Empfänger eindeutig fehl. Die Anforderung bleibt bestehen und
wird nicht dupliziert. Derselbe Vorgang wird nach dem gespeicherten
Wiederholungszeitpunkt erneut versucht; nach dem dritten eindeutigen
Totalfehler endet die Automatik mit interner Eskalation.

### Unklare Empfängeradresse

Für einen Mandanten sind widersprüchliche Kontaktdaten hinterlegt. Ein
aktiver Kontakt mit freigeschalteten Benachrichtigungen und einem bereits
gespeicherten erfolgreichen Portal-Login fehlt vollständig. Die Pipeline
speichert `NO_RECIPIENT`, sendet nicht blind und erzeugt eine interne
Fehlerbenachrichtigung. Sie prüft jedoch nicht fachlich, ob eine vorhandene
Adresse weiterhin zum richtigen Empfänger gehört.

## Umsetzung in TaxTronik

`materialize.ts` materialisiert Termine bis 90 Tage voraus und führt
Vorwarnung, Stop/Freigabe und Request-Anlage. Portal-Anforderung, Verknüpfung,
Status `REMINDED`, Benachrichtigungsstatus `QUEUED` und Audit-Ereignis entstehen
in einer Transaktion.

`tax-deadline-notification.ts` verarbeitet ausschließlich fällige `QUEUED`-
und `FAILED`-Datensätze mit stabiler `requestId` und atomarem
Compare-and-set-Claim, sofern der Request noch `OPEN` oder `IN_PROGRESS` ist.
Versuchsergebnis, Wiederholungszeitpunkt und Eskalation werden persistiert.
Teilannahme, kein Empfänger, inkonsistente oder fachlich bereits terminale
Verknüpfung und unklarer Ausgang erzeugen terminale interne Hinweise statt eines
Doppelversandrisikos. Die Web-Pipeline zeigt Request- und
Benachrichtigungszustand getrennt an.

Der gemeinsame Mail-Dispatcher wählt für fachliche Mandantenhinweise nur
aktive Kontakte mit `notificationsEnabled` und `lastLoginAt` aus. Der
gespeicherte erfolgreiche Portal-Login verhindert damit den Versand an bloß
eingeladene, noch nie erfolgreich angemeldete Kontakte. Ein Einladungsversand
bleibt ein eigener Pfad. Wird die Kontakt-E-Mail geändert, wird `lastLoginAt`
zurückgesetzt; die neue Adresse muss damit vor einem fachlichen Hinweis erneut
über einen erfolgreichen Portal-Login bestätigt werden.

Automatische Steuertermin-Anforderungen verwenden den eigenen Template-Slug
`tax-deadline-request-opened` mit neutralem Fallback und ausdrücklich leerem
Betreff-Suffix. Dem Mail-Template stehen nur Kontakt, Request-ID und Portal-Link
zur Verfügung; Mandantenname, Steuerart, Zeitraum, Fälligkeit, Request-Titel
und -Beschreibung verbleiben im geschützten Portal. Der interne n8n-Payload
führt die für den Workflow erforderlichen pseudonymen IDs, Priorität und
Fälligkeit getrennt weiter.

Das optionale n8n-Ereignis wird für die logische Anforderung einmalig neben den
kontaktbezogenen SMTP-Versuchen ausgelöst, auch wenn kein aktiver Mailkontakt
existiert. Fehlt ein Mailkontakt, bleibt der Mailstatus `NO_RECIPIENT`. Ist n8n
bereits erfolgt und wurden alle SMTP-Versuche ausdrücklich abgelehnt, wird das
Gesamtergebnis als terminale `PARTIAL_FAILURE` gespeichert. Ist der
SMTP-Ausgang dagegen unklar, bleibt der Gesamtstatus `UNKNOWN`. In beiden
Fällen erfolgt kein automatischer Neuversand.

Der Datenbank-Unlink-Trigger übernimmt bei regulären Unlinks Versuchszahl,
letzten Versuch, Provider-Annahme und Eskalationszeit aus dem alten Datensatz
nach `ORPHANED`, entfernt den künftigen Scheduler-Zeitpunkt und ergänzt den
Fehlertext um den Unlink-Hinweis. Danach sind diese technischen
`ORPHANED`-Metadaten datenbankseitig unveränderlich. Eine vollständige
Neutralisierung auf `NOT_REQUIRED` und leere Metadaten ist nur im expliziten
Löschpfad mit transaktionslokaler Purge-Freigabe zulässig. Auch diese Freigabe
überstimmt keinen laufenden `UNKNOWN`-Versandclaim. Der Zustands-Constraint
verbietet außerdem eine Provider-Annahme ohne vorherigen Versuch sowie die
gleichzeitige Provider-Annahme und Eskalation.

Vor einer regulären Terminlöschung verlangt ein weiterer Trigger einen
terminalen Request und blockiert laufende `UNKNOWN`-Claims. Der danach
gespeicherte technische Hilfsnachweis enthält keine Mandanten-ID, Falltitel,
Fälligkeit, Konfiguration oder Fehlerklartexte. Er ist an den Request gebunden,
für die App-Rolle nicht lesbar und wird zusätzlich nach einem Jahr durch den
tenantgebundenen Retention-Lauf gelöscht und gezählt.

## Bekannte Abweichungen und Grenzen

- `PROVIDER_ACCEPTED` ist nur eine technische Annahmeaussage. Es gibt keine
  belastbare Delivery-, Bounce-, Zugang- oder Kenntnisnahmebestätigung.
- SMTP und der optionale, einmalige n8n-Side-Effect laufen im gemeinsamen
  Dispatcher. Eine Exception kann nach einem bereits erfolgreichen Teilschritt
  auftreten; nur eine ausdrückliche negative SMTP-Antwort wird als eindeutige
  Ablehnung eingeordnet. Andere Exceptions bleiben fail-closed `UNKNOWN`, auch
  wenn n8n bereits lief oder einzelne SMTP-Versuche sicher angenommen wurden.
  Ein unklar beendeter oder per Timeout liegengebliebener Claim wird ohne
  Blind-Retry eskaliert und verlangt manuelle Prüfung.
- Vorhandene Kontakte werden nach Aktivstatus, Benachrichtigungsflag und einem
  gespeicherten erfolgreichen Portal-Login ausgewählt. Der Login ist keine
  erneute Bestätigung der aktuellen E-Mail-Adresse bei jedem Versand und keine
  eigenständige fachliche Empfängerfreigabe; die Pipeline erkennt später
  veraltete oder inhaltlich falsche Adressen nicht sicher.
- Interne Eskalation dokumentiert einen Handlungsbedarf, garantiert aber nicht,
  dass ein Mitarbeiter ihn liest oder erledigt.
- Die Software kann die berufsrechtliche oder datenschutzrechtliche
  Zulässigkeit einer konkreten Tenant- und Dienstleisterkonfiguration nicht
  selbst feststellen.

Der Implementierungsstatus bleibt deshalb **teilweise**.

## Fachliche Prüffragen

- Welche Terminarten dürfen automatische Anforderungen auslösen?
- Darf eine Portal-Anforderung ohne validierten Benachrichtigungskanal
  angelegt werden?
- Welche technischen Ereignisse rechtfertigen welchen
  Benachrichtigungsstatus?
- Ist für `UNKNOWN`, Teilannahme und fehlende Empfänger ein eigener manueller
  Erledigungsworkflow erforderlich?
- Soll eine echte Delivery-/Bounce-Rückmeldung ergänzt werden?
- Welche Inhalte dürfen in der E-Mail stehen?
- Sind externe Dienste nach § 62a StBerG und Art. 28 DSGVO eingeordnet?

## Technische Nachweise

Materialisierungs-, Pipeline-, Worker- und Datenbanktests prüfen Zeitfenster,
Stop/Freigabe, Atomizität, parallele Läufe und Doppelanlage-Schutz. Die neuen
Worker-Tests decken atomaren In-Flight-Claim, Provider-Annahme, eindeutigen
Totalfehler mit maximal drei Versuchen, Teilannahme, fehlende Empfänger,
unklare/liegengebliebene Versuche, aktive Zuständigkeits-Fallbacks, exakte
Konfigurations-Snapshots, terminale Request-Status, einmaliges n8n-Ereignis,
interne Eskalation und `ORPHANED` ab. Echte
Datenbanktests prüfen Status-Constraints, atomare Request-Verknüpfung und
Parallelität, den geschützten Übergang nach `ORPHANED`, dessen anschließende
Unveränderlichkeit, die explizite Purge-Freigabe, ungültige
Annahme-/Eskalationskombinationen und das Unlink-/Purge-Gate für laufende
Claims sowie den minimierten Terminlöschungsnachweis; der Retention-Test prüft
dessen tenantgebundene Einjahreslöschung und Audit-Zählung. Die Mail- und
Kontakt-Tests prüfen den Filter auf aktive,
benachrichtigungsfähige und bereits erfolgreich angemeldete Kontakte, den
datenminimierten Template-Scope, den einmaligen n8n-Aufruf auch ohne Mailkontakt,
die Trennung expliziter SMTP-Ablehnungen von unklaren Exceptions sowie den
Login-Reset bei E-Mail-Änderung. Nicht belegt sind tatsächliche
Zustellung oder Zugang, die fortdauernde Richtigkeit der Adresse, fachliche
Empfängerfreigabe und kanzleispezifische Datenschutzkontrollen.
