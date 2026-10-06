# Changelog

Änderungsjournal für TaxTronik. Der letzte getaggte Release-Stand ist
[`v0.2.1`](#021---2026-08-22) vom 22. August 2026. **`0.3.0` ist noch nicht
veröffentlicht.** Die Versionsnummer in `package.json` bezeichnet den
Entwicklungsstand; alle Änderungen seit `v0.2.1` stehen unter `[Unreleased]`.

Einträge mit **[Scope]** betreffen Module des
[Prüfungs-Scopes](docs/compliance/idw-ps880-pruefungsbereitschaft.md)
(Fakturierung, Dokumentenarchiv, Audit-Protokollierung, Zugriffsschutz oder
Backup/Restore). Diese Kennzeichnung dient der späteren Abgrenzung für
Folgeprüfungen; sie ist keine fachliche oder PS-880-bezogene Freigabe.

Neue Einträge werden unter der passenden vorhandenen Kategorie in
`[Unreleased]` ergänzt. Ein datierter Versionsabschnitt entsteht erst bei der
tatsächlichen Release-Erstellung. Eine geplante Versionsnummer oder ein
Entwicklungsdatum begründet keinen Release-Abschnitt.

## [Unreleased]

Noch nicht veröffentlicht. Fachliche Prüfungen und organisatorische
Pilotentscheidungen bleiben gesondert zu dokumentieren.

### Hinzugefügt

- Mandanten-Mails (neue Anforderung, Kanzlei-Antwort, Formular, GwG-Einladung
  und -Freischaltung, Terminentscheidung, Rechnungsversand, Abholbereitschaft)
  werden im fachlichen Commit als Versandauftrag gespeichert und vom Worker
  zugestellt; eindeutig fehlgeschlagene Versuche werden bis zu sechsmal mit
  wachsendem Abstand wiederholt, bei endgültigem Fehlschlag, Teilzustellung
  oder unklarem Ausgang wird die Kanzlei benachrichtigt (Migration
  `20261006120000`, `FK-EXC-20261006-014`).
- CI-Prüfung `pnpm verify:fk-indexes` meldet Fremdschlüssel ohne führenden
  Index; bestehende Ausnahmen stehen in einer begründeten Allowlist
  (`FK-EXC-20261005-008`).
- Dashboard-Widget „Mein Arbeitskorb“ mit den persönlichen Aufgaben, Terminen
  und Eingängen, ihren Fälligkeiten und direktem Link zum Arbeitskorb. Es nutzt
  dieselben Modul- und Zugriffsfilter wie die Arbeitskorbseite
  (`PORTAL-INBOX-SUBMISSION-001`).

- Wiedervorlagen erhalten stabile kanzleiweite Nummern, eine durchsuchbare
  Übersicht und automatische Verweise sowie Rückverweise durch `#123` in
  Beschreibungen und Kommentaren. Vorhandene UUID-Links bleiben gültig.
- Erledigte Tickets können archiviert und als erledigt zurückgeholt werden.
  Kommentare, Anhänge und Verknüpfungen bleiben erhalten; neue Arbeit am
  archivierten Ticket wird gesperrt. Rechercheherkunft bleibt unabhängig von
  einer späteren erneuten Delegation bestehen.
- **[Scope]** Referenzen übernehmen keine Zugriffsrechte. Aktuelle Mandanten-
  und Beteiligungsrechte gelten auch für Ketten, Backlinks und Anhänge; der
  Upload prüft Archivierung unter derselben Zeilensperre wie die Ticketaktionen.
- Neue Produktregel `REMINDER-TICKET-001` als ungeprüfter Entwurf; keine
  fachliche Freigabe. Bedienung und Abgrenzung sind unter
  `docs/anwenderdoku/wiedervorlagen.md` dokumentiert.

- Optionaler Staff-Anmeldemodus **„Nur physische FIDO2-Sicherheitsschlüssel“**:
  Das persönliche Opt-in ist erst ab zwei registrierten Schlüsseln möglich und
  schließt danach Passwort, TOTP und Backup-Codes als Anmeldewege aus. WebAuthn
  verlangt Benutzerverifikation, `cross-platform`-Authentikatoren,
  `singleDevice`-Credentials ohne Backup-Eignung oder -Status sowie die
  Hardware-Transporte USB, NFC, BLE oder Smartcard. Recovery folgt der
  bestehenden ADMIN-/PARTNER-Hierarchie einschließlich CLI-Recovery für
  ADMIN-Konten und widerruft laufende Sitzungen. Der Web-Reset verlangt als
  Step-up im Passwortmodus aktuelles Passwort plus frischen TOTP ohne
  Backup-Code; Hardware-only-Akteure bestätigen mit dem eigenen Schlüssel und
  einer an Akteur, Zielkonto und Auth-Revision gebundenen Challenge. Die
  Recovery-Mutationen und das Audit erfolgen datenbankseitig atomar; der
  Portal-Magic-Link bleibt unverändert. Ein DB-gestützter Rollenboden
  verhindert den Entzug von ADMIN durch Staff und erlaubt den PARTNER-Entzug
  nur aktiven ADMIN desselben Tenants. Auch reguläre Passwort-/TOTP-Resets sind
  an die Actor-Auth-Revision gebunden und widerrufen ruhende aktive Hardware-
  Credentials; eine eigene Passwortänderung widerruft die eigenen
  Vorabregistrierungen.
  Enrollment verlangt nun `direct` + vollständige `packed`-Attestation, eine
  nichtleere `WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST` und FIDO MDS `strict`.
  Die Zertifikat-AAGUID muss zur signierten Authenticator-AAGUID passen;
  Registration, Attestation-Ketten und externe Abrufe haben harte Größen- und
  Zeitgrenzen. Zertifikatsketten werden vor CRL-Abrufen strikt an Root,
  CA-Constraints und Pfadlänge gebunden; CRLs müssen frisch und vom
  tatsächlichen Issuer signiert sein. Mehrere/partitionierte Distribution
  Points, Zertifikat-seitige Freshest-CRL-Verweise,
  Delta-/IDP-/Freshest-CRLs und unbekannte kritische CRL-Extensions werden bis
  zu vollständiger Scope-Unterstützung fail-closed abgewiesen.
  Aktuelle Allowlist und MDS-Statement werden bei jeder Hardware-Assertion
  fail-closed geprüft. `WEBAUTHN_HARDWARE_POLICY_REVISION` und ein kanonischer
  Hash binden aktive wie leere Allowlists clusterweit: Eine höhere Revision
  verdrängt alte Replicas, gleiche Revisionen mit anderem Hash werden
  abgewiesen. Der Produktionsstart beansprucht diesen Policy-Anker DB-only und
  ohne MDS-Netzzugriff. Der MDS-Snapshot wird spätestens stündlich erneuert;
  seine höchste kryptografisch verifizierte BLOB-Seriennummer wird vor dem
  lokalen Modellfilter clusterweit in einer Tabelle ohne App-Tabellenrechte
  verankert. Ein transaktionaler Exact-State-Lock auf Serie, Revision und Hash
  in der Reihenfolge `MDS -> Staff` verhindert Commits mit einem parallel
  überholten Zustand. Die ADMIN-CLI schreibt das Klartextpasswort nur in eine
  exklusive, symlinksichere Credential-Datei, nie in Terminal oder Logs.
  Ausgabefehler entfernen die eigene Teildatei und rollen Reset samt Audit
  zurück; Datei und POSIX-Elternverzeichnis werden vor dem Commit
  synchronisiert. Scheitert erst der DB-Commit, kann eine sichere, aber
  unwirksame Datei zurückbleiben. Die AAGUID belegt nur eine
  freigegebene Modellfamilie, nicht eine eindeutige Geräteinstanz: Beim Opt-in
  wird ein Schlüssel frisch bestätigt; der zweite aktive, policykonforme
  Schlüssel wird nur gezählt und beweist kein zweites physisches Gerät.
  Technische Nachweise werden `ACCESS-TENANT-RLS-001` (Credential-RLS) und
  `AUDIT-HASH-CHAIN-001` (auditierte Schlüssel-, Modus- und Recovery-Aktionen)
  zugeordnet; als allgemeine Auth-Härtung entsteht gemäß Fachkatalog-Scope
  keine neue Fachregel.

- **[Scope]** Separater, opt-in Mandantenposteingang (`clientInbox`, Default
  `false`) mit mandantenweit sichtbaren, unveränderlichen Nachrichten,
  kontaktprivaten Uploadentwürfen, RLS-gesichertem Staging, Magic-Byte- und
  Virenscan, idempotenten Mutationen, neutralem Themenrouting und sicher
  wiederaufnehmbarer Dokumentübernahme erst nach ausdrücklicher
  Kanzleientscheidung (`PORTAL-INBOX-SUBMISSION-001`).
- **[Scope]** Arbeitskorb unter `/staff/work` mit „Meine Arbeit“ und „Team“,
  Termin-Gruppierung und quellenspezifischen Deep-Links/Aktionen für
  Mandantenpost, Workflows, Wiedervorlagen, Termine und Telefonzettel.
- Gemeinsame serverseitige Navigationsregistry für Staff, Portal, mobile
  Navigation und Befehlspalette sowie mobile Karten, URL-stabile Suche,
  Filter und 25er-Pagination in den zentralen Portallisten.
- Zentraler rückwärtskompatibler `ActionResult`-Vertrag samt
  Fehlerzusammenfassung, Feldzuordnung, Fokusführung und Repository-Guard gegen
  neue lokale Vertragskopien oder pauschale Validierungsfehler.

- **[Scope]** Vierzehn einzeln zuschaltbare Ausbaupakete, standardmäßig deaktiviert:
  interne Wiki-Hilfe, Jahresendkampagnen, Bescheidrückmeldungen, Smart-Mailbox,
  Personalaufnahme, Bewirtungs-/Eigenbelege, Mandanten-Verfahrensdokumentation,
  Feedback, Beteiligungsstrukturen, Workflow-Abhängigkeiten, Offboarding,
  VDB-Vorbereitung, lokales EU-Screening/PEP-Dokumentation und StBVV-Vorschläge.
  Bestehende Anforderungs-, Formular-, Archiv-, Benachrichtigungs- und Workerwege
  bleiben die gemeinsame Grundlage. Fragen, Antworten und Ausgaben binden
  konkrete Fassungen; Legacy-Formularen wird keine historische Fassung unterstellt.
- **[Scope]** Getrennte Arbeitnehmer-Capabilities, ausdrückliche Lohnkontakte,
  zusätzliche Rechte `PAYROLL_MANAGE`/`INBOUND_MAIL_MANAGE`, geschützte
  Archivkopien und Mandatsende-Sperren. Berechtigungen gelten auch für
  Ausgaben und Hintergrundverarbeitung. Alle Migrationen sind additiv.
- **[Scope]** DATEV-LuG und VDB bleiben bis zur belegten Formatspezifikation und
  tatsächlichen Importabnahme gesperrt. Export ist keine externe Verarbeitung;
  Rückmeldungen, Einspruchsauftrag, Sofortmeldung und Fristerledigung bleiben getrennt.
  Neue Fachkatalogregeln bleiben ungeprüft; reale M365-, Ausgabe- und Fachabnahmen
  sind Teil der einzeln zu dokumentierenden Pilotierung. Umfang, Regel-IDs und
  verbleibende Abnahmen: [Ausbauintegration](docs/development/expansion-integration.md).

- **[Scope]** Lokale Ausweishilfe für Kanzlei und Einladungswizard mit unveränderten
  Originalen, versionierten PDF-Seiten/Ausschnitten und ausdrücklich ausgewählten
  OCR-Vorschlägen. Speichern bestätigt keine Identität; „Als geprüft markieren“
  bleibt ein eigener Schritt (GWG-OCR-ASSIST-001, GWG-IDENTIFICATION-EVIDENCE-001,
  GWG-SELF-ONBOARDING-001).
- **[Scope]** Gleichwertige GwG-Erfassung per Einladungslink oder direkt in der
  Kanzlei. Der Wechsel öffnet vorhandene Entwürfe und widerruft offene Links
  kontrolliert; Kontaktanforderungen und Freigabebedingungen bleiben erhalten
  (GWG-SELF-ONBOARDING-001).
- **[Scope]** GwG-Kontrollliste mit mandatslokalen Personenankern, bewussten
  Verknüpfungen und zwei zusammengehörigen XLSX-Blättern ausschließlich aus
  zugänglichen Mandaten (GWG-PERSON-LINKS-001, GWG-CONTROL-EXPORT-001).
- **[Scope]** Eigenständige steuerliche Stammdaten mit mehreren Steuerverbindungen,
  kontrollierten Portalanfragen und unveränderlichen ELSTER-Abrufreferenzen.
  USt-ID ist kein GwG-Änderungsauslöser mehr; neue Prüfprojektionen sind versioniert
  (TAX-MASTER-DATA-001, GWG-REVERIFICATION-VALIDITY-001).
- **[Scope]** Zusätzliches Berufsträgermerkmal und interne Beraternummer;
  GwG-Freigaben verlangen einen aktiven Mitarbeiter mit Berufsträgermerkmal und
  konkreter Zuordnung. Zentrale
  Auditansicht und CSV erhalten gemeinsame Kategorie-/Sortierfilter ohne Änderung
  der Hashkette (ACCESS-STAFF-PERMISSION-001, GWG-RISK-REVIEW-001,
  AUDIT-HASH-CHAIN-001, AUDIT-VERIFY-ALERT-001). Neue Fachregeln bleiben ungeprüft.
- **[Scope]** Vier Datenbankmigrationen übernehmen bestehende Steuernummern,
  ausdrückliche Berufsträgerzuordnungen und getrennte Personenanker. Historische
  Prüfhashes bleiben erhalten; alte offene Einladungen werden zur manuellen
  Neuausstellung widerrufen, ohne automatisch Ersatzlinks zu versenden. Die
  [Umstellungsschritte](docs/development/gwg-erfassung-steuerdaten.md#koordinierter-versionswechsel)
  verlangen ein gemeinsames Wartungsfenster für alte und neue Schreibprozesse
  (TAX-MASTER-DATA-001, GWG-RISK-REVIEW-001, GWG-SELF-ONBOARDING-001,
  GWG-PERSON-LINKS-001).

- Der persönliche Anzeigemodus lässt sich getrennt nach Schriftgröße
  (100/112,5/125 Prozent), Zeilenabstand, Standard-/verstärktem Kontrast und
  Bewegungsreduktion anpassen. Die Auswahl bleibt beim Ausschalten erhalten,
  wird profilgebunden gespeichert und kann auf die empfohlenen Werte
  zurückgesetzt werden. Betriebssystemseitige Bewegungsreduktion bleibt
  unabhängig davon wirksam.
- Dashboard und Portal-Layouteditor bieten benannte Eingabefelder für
  Position und Größe als Alternative zu Drag-and-drop. Änderungen werden erst
  nach „Übernehmen“ über den bisherigen Speicherweg angewendet; Entwürfe,
  Grenzwerte, Speicherstatus und Fehler sind sichtbar. Bei wenig Platz bleibt
  eine gestapelte Vorschau bedienbar, ohne das gespeicherte Raster allein
  durch den Ansichtswechsel zu verändern.
- Ein persönlicher barrierearmer Anzeigemodus ist im Mitarbeiterprofil und in
  den Portal-Einstellungen aktivierbar: größere Schrift und zentrale
  Bedienelemente, kräftigere Kontraste, deutlichere Links/Fokusrahmen und
  reduzierte Bewegung. Die Einstellung wird pro Mitarbeiter beziehungsweise
  Portal-Kontakt in der Datenbank gespeichert, bereits serverseitig angewendet
  und nicht zwischen Profilen geteilt. Die normale Ansicht behält ihre
  grundlegenden A11Y-Funktionen; der Modus ist keine Konformitätsgarantie.
- Eine versionierte Ist-/Gap-Dokumentation beschreibt das WCAG-2.2-AA-Ziel,
  den tatsächlich umgesetzten A11Y-Stand, die automatisierten Nachweise, die
  weiterhin erforderliche manuelle Prüfmatrix und bekannte Grenzen. Sie ist
  ausdrücklich weder Konformitätserklärung noch Zertifizierung.
- `eslint-plugin-jsx-a11y` ist Teil des normalen Repository-Lints. Eine neue
  Axe-/Playwright-Suite prüft repräsentative Staff- und Portaloberflächen in
  Light und Dark Mode, bei 320 CSS-Pixeln sowie das Tastaturverhalten von
  Skip-Link und mobiler Navigation; ihre Befunde werden als Testartefakte
  ausgegeben und die Suite ist in den paranoiden E2E-Lauf eingebunden.
- **[Scope]** Wissensartikel besitzen jetzt einen großen Markdown-Arbeitsbereich
  mit Formatierungsleiste, direkt gerendertem Inline-Modus und Markdown-
  Quellansicht. Bilder und
  beliebige Dateien lassen sich als Anhänge hochladen; sie durchlaufen den
  bestehenden Virenscan, werden mandantengetrennt im Dokumentenspeicher
  versioniert, revisionsnah protokolliert und erst nach erfolgreichem Scan über
  authentifizierte Vorschau- beziehungsweise Download-Endpunkte ausgeliefert.
- Die GwG-Personenverwaltung bündelt je erfasster Person die ausklappbaren
  Bereiche „Allgemeine Angaben“, „Personalausweis“ und „Rolle(n)“. Allgemeine
  Personendaten werden unabhängig von der Rolle zentral gepflegt; Rollen und
  Beteiligungsanteile lassen sich getrennt im Lese- und Bearbeitungsmodus
  ändern. Gesetzliche Vertreter können zugleich wirtschaftlich Berechtigte
  sein, ohne dass Personendaten doppelt erfasst werden müssen.
- GwG-Nachweise können ersetzt und fehlerhafte aktive Verknüpfungen über ein X
  aus der aktuellen Prüfungsansicht entfernt werden. Frühere Ausweise und
  Registernachweise bleiben für Verlauf und Aufbewahrung in eingeklappten
  Unterbereichen einsehbar, während die gespeicherten Dokumentversionen im
  Mandantenarchiv erhalten bleiben.
- Ein maschinenlesbarer und zugleich berufsträgertauglicher Fachkatalog führt
  erste atomare Regeln zu Fakturierung, Fristen und Bescheiden. Schema,
  generierte Indizes, Code-/Testnachweise und CI-Diff-Guard trennen technische
  Umsetzung von menschlicher Fachfreigabe; die initialen Regeln bleiben bis
  zum dokumentierten Berufsträger-Review ausdrücklich ungeprüft.
- Ein zentraler Dokumentationsindex, eine aktuelle Übergabe, ein historisches
  Handoff-Archiv sowie auszufüllende Vorlagen für PS-880-Prüfumgebung und
  Release-Evidence ordnen die Nachweise nach Zielgruppe und Dokumenttyp.

### Geändert

- Neues Workspace-Paket `@taxtronik/gwg` mit den GwG-Regeln für Web-App und
  Worker (Transaktions-Signatur, ohne Next.js-Abhängigkeit): Lebenszyklus der
  GwG-Prüfung, Aufbewahrungs- und Löschfristen samt Review-Queue nach § 8
  Abs. 4 GwG (vormals `@taxtronik/tax` bzw. Web-App) und die Eskalationsstufen
  der Wiederholungsprüfung (vormals nur im Worker-Job). Das Fachkatalog-Diff-Gate
  überwacht das Paket. Verhalten unverändert (`GWG-RETENTION-DESTRUCTION-001`,
  `GWG-REVERIFICATION-VALIDITY-001`, `FK-EXC-20261006-024`).
- GwG-Identifizierung: Die bearbeitenden GwG-Aktionen (Personen,
  wirtschaftlich Berechtigte, Angaben zum Rechtsträger, Ausweisnachweise,
  Prüfzyklus, Einreichen, Freigeben, Ablehnen) laufen über Services mit
  Transaktions-Signatur; das zuvor zwölfmal ausgeschriebene Prelude
  (Mandantenzugriff, Lifecycle-Sperre, Prüfung laden, Bearbeitbarkeit,
  Status-Claim) liegt einmal in `withEditableGwgCheckTx`. Meldungen,
  Audit-Ereignisse und Sperrreihenfolge bleiben unverändert; neue
  PostgreSQL-Tests prüfen die Services unter der App-Rolle
  (`GWG-IDENTIFICATION-EVIDENCE-001`, `GWG-BENEFICIAL-OWNERS-001`,
  `GWG-RISK-REVIEW-001`, `FK-EXC-20261006-023`).
- Die n8n-Administration ist in Server-Services je Aufgabe aufgeteilt;
  Eingabeprüfung und Normalisierung sind reine, eigens getestete Funktionen.
  SSRF-Prüfung, Secret-Behandlung, Audit-Events und Meldungen bleiben
  unverändert; neue PostgreSQL-Testsuite im CI-db-Job.
- Anlage, Versand und Widerruf von Vollmachten laufen über eigene
  Server-Services; Prüfungen, Schreibvorgänge, Versandsnapshot und Hash,
  Audit-Events und Meldungen bleiben unverändert. Neue PostgreSQL-Testsuite
  gegen die PoA-Integritätstrigger (`POA-LIFECYCLE-001`,
  `POA-SIGNING-SNAPSHOT-001`, `POA-SIGNING-CONFIRMATION-001`,
  `FK-EXC-20261006-021`).
- **[Scope]** Die Umklassifizierung von Dokumenten (einzeln und als Auswahl)
  läuft über einen gemeinsamen Dokument-Service; Sperren, journal-first
  Re-Store, Meldungen und Audit-Events bleiben unverändert. Neue
  PostgreSQL-Testsuite im CI-db-Job (`DOC-VERSION-IMMUTABILITY-001`,
  `DOC-UPLOAD-JOURNAL-001`, `FK-EXC-20261006-020`).
- **[Scope]** Verschieben, Freigeben, Löschen und Umtypisieren mehrerer
  Dokumente im Dokumenten-Explorer laufen als eine Server-Anfrage je Auswahl
  statt einer je Dokument; die Liste wird einmal statt je Dokument neu
  gerendert (100 Dokumente: 1 statt 101 Seiten-Renderings). Zugriffsprüfung und
  Audit-Event je Dokument bleiben, abgelehnte Dokumente werden einzeln
  gemeldet (`DOC-PORTAL-SHARING-001`, `FK-EXC-20261006-018`).
- Das Body-Limit für Server Actions leitet sich aus den Upload-Grenzen je
  Upload-Art ab und steigt von 10 MB auf 26 MiB, passend zu nginx
  (`client_max_body_size 26M`) und Traefik.
- Die n8n-Anbindung des Mail-Versands wird beim Start von Web-App und Worker
  ausdrücklich registriert; fehlt sie, bricht ein Versand im Modus „App + n8n“
  vor dem Mailversand mit klarer Fehlermeldung ab, statt das n8n-Ereignis
  still auszulassen (`FK-EXC-20261006-015`).
- Rechnung, Anforderung, Anlieferung, GwG-Einladung, Onboarding-Übersicht und
  Formular zeigen den Zustellstatus der Mandanten-Mail statt eines pauschalen
  Versandhinweises.
- ENV-Prüfung je Prozess: Der Worker verlangt keine Web-Werte mehr
  (`NEXTAUTH_URL` nur als Rückfall für `PORTAL_PUBLIC_URL`; `NEXTAUTH_TRUST_HOST`,
  `TRUST_PROXY_*`, Cookie-Domains, ELSTER und Lizenz entfallen),
  `pnpm secret-box:rewrap` und `pnpm verify:deploy-readiness` prüfen nur ihre
  eigenen Werte. Produktionsprüfungen und Meldungen bleiben unverändert.
- Interne Schichtgrenzen der Web-App sind per ESLint abgesichert:
  Komponenten und Server-Module importieren nicht mehr aus Routenordnern,
  Staff-Seiten nicht aus dem Portal; geteilte Oberflächenteile liegen unter
  `components/` (`FK-EXC-20261006-011`).
- Fristen-Kontrollbuch: Die Fristenseite lädt offene Einträge seitenweise
  (200 je Seite, dringendste zuerst); Zähler und Tagesabschluss-Vorschau
  kommen ohne zweiten Volllauf aus. CSV-Export und Tagesabschluss-Protokoll
  bleiben vollständig. Bei mehreren Hauptbearbeitern bzw. Zuständigen einer
  Wiedervorlage gilt einheitlich die erste Zuweisung als verantwortlich
  (vorher je Ansicht zufällig) (`TAX-CONTROL-STATUS-001`,
  `FK-EXC-20261006-010`).
- Die Feiertagsprüfung der Fristberechnung ist je Jahr, Region und
  Bayern-Annahme zwischengespeichert. Der veraltete, nicht exportierte
  Einspruchs- und Klagefristen-Rechenkern ist entfernt; Fristen berechnen
  ausschließlich die nachweisorientierten `assess*`-Funktionen, deren Tests nun
  auch Jahresfrist, Auslandspost und Datenabruf-Altfälle abdecken
  (`TAX-NOTICE-APPEAL-001`, `TAX-DEADLINE-WORKDAY-001`, `FK-EXC-20261006-009`).
- Der nie implementierte Sammel-Endpunkt `/api/n8n/*` (antwortete stets 501)
  ist entfernt. Aktivierte Legacy-Callbacks unter `/api/n8n/…` protokollieren
  je Route und Prozess einmal eine Deprecation-Warnung mit dem v1-Nachfolger.
- Ungenutzte Server-Actions (u. a. Alias-Actions für das Archivieren von
  Wiedervorlagen und den GwG-Prüfstart, manueller Audit-Rotations-Trigger),
  Komponenten und zehn CSS-Komponentenklassen entfernt. `autoprefixer` ist
  aus der PostCSS-Kette entfernt; Tailwind v4 erzeugt die Präfixe für die
  unterstützten Browser, `-webkit-backdrop-filter` bleibt für ältere
  Safari-Versionen erhalten (`FK-EXC-20261006-008`).
- Die E2E-Suite prüft den Produktions-Build über den ausgelieferten
  Standalone-Server mit `NODE_ENV=production` und den Produktions-Images von
  PostgreSQL und Redis; fehlgeschlagene Tests werden nicht mehr wiederholt
  (`ASSURANCE-RELEASE-EVIDENCE-001`, `FK-EXC-20261006-007`).
- Das Worker-Image startet einen gebündelten Worker
  (`node --enable-source-maps dist/index.js`) statt `tsx src/index.ts` und
  enthält nur Produktionsabhängigkeiten (Laufzeitbaum 422 MB statt 1,2 GB, ohne
  TypeScript, Vitest, Vite, tsx und esbuild). Image-Builds laden Pakete in
  einer von Quell- und Doku-Änderungen unabhängigen Schicht.
- Workspace-Pakete werden per Symlink statt als injizierte Kopie eingebunden;
  Quelländerungen wirken ohne Neuinstallation, und Host-Werkzeuge nutzen nach
  Updates keinen veralteten Paketstand mehr. Fehlende und ungenutzte
  Abhängigkeitsdeklarationen sind bereinigt (keine neuen Pakete oder
  Versionen). Nach dem Update einmal `pnpm install` ausführen.
- Dokumente im Mandanten-Tab: Ordnerauswahl und Suche filtern serverseitig
  über alle Dokumente des Mandanten statt nur über die angezeigte Seite;
  Zähler und Blättern beziehen sich auf die Auswahl, die Suche startet mit
  Enter. Löschen in der Dokumentenverwaltung fragt wie im Mandanten-Tab nach
  einem optionalen Grund und zeigt die GoBD-/GwG-Aufbewahrungshinweise, auch
  bei Mehrfachauswahl (`ACCESS-SEARCH-SCOPE-001`, `FK-EXC-20261006-006`).
- Die Dokumentvorschau erkennt den Dateityp über die ersten 1 KB
  (Range-Request), statt die ganze Datei zu laden; Downloads werden ohne
  zusätzliche Pufferkopie ausgeliefert.
- `pnpm backup:run` bzw. `./taxtronik backup` nutzen denselben Backup-Runner
  wie der nächtliche Worker-Job und schließen verwaiste RUNNING-Einträge
  (älter als 6 Stunden) ab.
- CI: DB-, Restore-, Upgrade- und E2E-Job laufen parallel nach dem
  Quality-Job auf eigenen PostgreSQL-Ports (kritischer Pfad 60 statt 140
  Minuten Timeout); der separate E2E-Smoke-Job ist in `e2e-paranoid`
  aufgegangen, das gemeinsame Job-Setup steht in `scripts/ci/setup.sh`
  (`ASSURANCE-RELEASE-EVIDENCE-001`, `FK-EXC-20261005-042`).
- Build: `pnpm typecheck` und `pnpm test` prüfen die Pakettypen nicht mehr
  doppelt (15 statt 27 Turbo-Aufgaben); die Root-`.env` invalidiert im
  Turbo-Cache nur noch Web-Build und DB-Tests.
- CI: Die Altbestandstests für GwG-Migration 034 und den Onboarding-Backfill
  041 laufen als SQL-Fixtures über `scripts/ci/migration-cutoff.sh` in jedem
  CI-Lauf statt nur nach einem Release-Tag und sind lokal ausführbar
  (`GWG-ACTIVATION-GATE-001`, `GWG-SELF-ONBOARDING-001`,
  `FK-EXC-20261005-040`).
- CI/Qualität: ESLint läuft je Quality-Lauf einmal und mit Cache statt
  dreimal. React-Compiler-Regeln sind Fehler; die bestehende
  Komplexitätsschuld steht je Datei in `eslint-suppressions.json`, die Zähler
  können nur sinken (`pnpm lint:prune-suppressions`). Prettier prüft alle
  `.mjs`-Dateien (`FK-EXC-20261005-039`).
- Der Dialog „Anforderung erstellen“ und die Terminanfrage im Portal laden
  Formular und Datumsauswahl erst beim Öffnen; der Start-JavaScript-Code sinkt
  dort von 142 auf 89 kB bzw. von 80 auf 32 kB (gzip).
- Dashboard: Die Widgets erscheinen direkt mit dem Seitenaufbau als
  serverseitiges Raster und stehen auf Smartphones untereinander; der
  Drag-&-Drop-Editor und sein CSS werden erst im Modus „Anpassen“ geladen.
- Kanzleioberfläche und Portal zeigen Seitenrahmen und Ladeplatzhalter
  sofort; das Mandanten-Cockpit zeigt Kopf und Navigation zuerst und lädt die
  übrigen Karten nach, statt vor dem ersten Byte auf alle 13 Abfragen zu
  warten (`ACCESS-SEARCH-SCOPE-001`, `FK-EXC-20261005-037`).
- Automatische Aktualisierung nur noch auf Seiten mit Live-Zustand
  (Dashboard, Arbeitskorb, Job-Monitor, Portal-Startseite und -Nachrichten);
  im Hintergrund pausiert sie, nach der Rückkehr lädt sie erst nach mindestens
  60 s Abwesenheit sofort neu. Die Glocke fragt bei verborgenem Tab nicht mehr
  ab, teilt sich eine Abfrage je Tab und lädt bei neuen Benachrichtigungen nur
  die betroffene Seite neu.
- Die Monatsansicht der Steuertermine zählt die Termine je Tag in der
  Datenbank (bei 15.000 Terminen im Monat 35 statt 15.000 Zeilen), statt alle
  Termine des Monats zu laden; Monatsraster und Termin-Pillen sind mit dem
  Kanzleikalender geteilt, die Pillen eines Tages erscheinen in fester
  Reihenfolge (`ACCESS-SEARCH-SCOPE-001`, `FK-EXC-20261005-036`).
- Hardware-Anmeldung, -Registrierung und Modus-Bestätigungen laden die
  FIDO-Metadaten nicht mehr im Request (bis 20 MiB, 30 s); der Hintergrundjob
  `fido-mds-refresh` prüft sie alle 20 Minuten und speichert den geprüften
  Stand. Ohne aktuellen Stand (älter als eine Stunde) bleiben
  Hardware-Vorgänge gesperrt; Passwort-, TOTP- und Portal-Anmeldung sind nicht
  betroffen (Migration `20261005120000`, `ACCESS-TENANT-RLS-001`,
  `FK-EXC-20261005-033`).
- Die Seitenzahl von PDF-Ausweisquellen wird beim Upload im begrenzten
  Worker-Thread gezählt und an der Dokumentversion gespeichert; die Prüfung
  der Ausweisausschnitte lädt und parst die Originaldatei (bis 25 MiB) nicht
  mehr unter Lifecycle-Lock und Zeilensperren (Migration `20261005140000`,
  `GWG-IDENTIFICATION-EVIDENCE-001`, `GWG-SELF-ONBOARDING-001`,
  `FK-EXC-20261005-030`).
- Der Sicherungs-Button der Admin-Übersicht reiht den Hintergrundjob
  `backup-run` ein und zeigt dessen Fortschritt, statt `pg_dump`, Prüfsumme und
  Upload im Web-Request auszuführen (bisher HTTP 504 nach dem Proxy-Timeout);
  eine laufende Sicherung blockiert einen zweiten Start. PDF- und DOCX-Texte
  der Subsumtionsakte werden in einem begrenzten Worker-Thread gelesen
  (`MAIL-INBOX-001`, `RISK-AI-SUGGESTION-001`, `FK-EXC-20261005-029`).
- Die Admin-Übersicht zeigt das gespeicherte Ergebnis des Update-Checks
  (Hintergrunddienst alle sechs Stunden) mit Prüfzeitpunkt und wartet nicht
  mehr bei jedem Aufruf auf den Update-Server; die Kacheln für löschreife
  GwG-Belege und fällige Anonymisierungen zählen per COUNT, die Ladevorgänge
  laufen parallel (`ASSURANCE-RELEASE-EVIDENCE-001`,
  `GWG-RETENTION-DESTRUCTION-001`, `DSGVO-MANDATE-ANONYMIZATION-001`,
  `FK-EXC-20261005-028`).
- Die Jahreswechsel-Übersicht blättert Kampagnen und Einträge seitenweise und
  zeigt die Statusverteilung je Kampagne, statt alle Kampagnen, Einträge und
  Einreichungen zu laden und im Render quadratisch abzugleichen. Der Rollout
  legt Einreichungen, Anforderungen und Zuordnungen gesammelt an (200
  Mandanten lokal 0,2 bis 0,4 s statt 1,7 s) (`YEAR-END-CAMPAIGN-001`,
  `FK-EXC-20261005-027`).
- Das Speichern eines Steuertermin-Zeitplans legt nur noch die Termine dieses
  Mandanten an, statt alle Termine der Kanzlei in einer Web-Transaktion zu
  materialisieren; Vorwarnung und automatische Anforderung erstellt der sofort
  angestoßene Hintergrundlauf (`TAX-DEADLINE-AUTOREQUEST-001`,
  `FK-EXC-20261005-026`).
- Staff- und Portal-Layout laden ihre Einstellungen samt Glocke
  beziehungsweise Mandantenprofil in einer Datenbanktransaktion statt in fünf
  bis sechs parallelen, der Setup-Status in einer statt sieben;
  Modulprüfungen in laufenden Transaktionen belegen keine zweite Verbindung
  mehr. Verbindungspools für App und Worker werden über
  `DATABASE_APP_POOL_MAX` und `DATABASE_OWNER_POOL_MAX` getrennt bemessen,
  `./taxtronik doctor` prüft die Summe gegen `POSTGRES_MAX_CONNECTIONS`;
  `DATABASE_CONNECTION_LIMIT` ist veraltet (`FK-EXC-20261005-025`).
- Audit-Archivierung und Bereinigung verwaister Speicherobjekte arbeiten je
  Lauf bis zu etwa zehn Minuten weiter, bis nichts mehr fällig ist; bisher
  fiel der Archivbestand Woche für Woche weiter zurück. Ein verbleibender
  Rückstand erscheint unter System → Jobs (`AUDIT-ARCHIVE-001`,
  `DOC-UPLOAD-JOURNAL-001`, `FK-EXC-20261005-021`).
- Der EU-Sanktionsabgleich bereitet die Aliasliste einmal je Lauf vor statt
  für jedes Prüfsubjekt neu (rund 6.000 Listeneinträge, 500 Subjekte: 3,9 s
  statt 60 s). Mandantenhinweise gibt es nur noch bei Namenstreffern, sonst
  höchstens einen Sammelhinweis je Kanzlei und Lauf statt eines Hinweises je
  Mandant an alle Admins. Fehler beim Listenabruf werden protokolliert statt
  verschluckt (`GWG-SCREENING-001`, `FK-EXC-20261005-020`).
- **[Scope]** Die Mitarbeiteranmeldung prüft das Passwort nur noch einmal;
  TOTP-/Recovery-Code und TOTP-Ersteinrichtung verwenden ein fünf Minuten
  gültiges Einmal-Ticket statt einer zweiten bcrypt-Prüfung. Nach einem
  falschen Code beginnt die Anmeldung wieder beim Passwortschritt
  (`ACCESS-TENANT-RLS-001`, `FK-EXC-20261005-014`).
- **[Scope]** GwG-Onboarding-Uploads werden der Einladung nur noch über den
  Fremdschlüssel am Dokument zugeordnet; die JSON-Liste der Einladung wird
  nicht mehr gelesen und bis zur Contract-Migration nur für Rollbacks
  gepflegt. Die Onboarding-Übersicht der Kanzlei zeigt einzeln vernichtete
  Belege nicht mehr an (`GWG-SELF-ONBOARDING-001`, `FK-EXC-20261005-011`).
- `inbound_message.status` und `bwa_plan.status` lassen per CHECK nur noch die
  vom Code geschriebenen Werte zu; die Migration bricht bei abweichendem
  Bestand mit Werten und Anzahl ab (`MAIL-INBOX-001`, `BWA-PROJECTION-001`,
  `FK-EXC-20261005-010`).
- **[Scope]** 18 vollständig durch andere Indizes gedeckte Indizes entfernt;
  das senkt die Schreiblast, vor allem bei Dokumentversionen. Alle
  Unique-Constraints bleiben (`FK-EXC-20261005-009`).
- **[Scope]** Indizes für `time_entry.invoice_id`,
  `workflow_dependency.successor_item_id` und `tax_notice.filing_id`
  beschleunigen Storno, Workflow-Bereitschaft und Bescheidzuordnung
  (`FK-EXC-20261005-008`).
- **[Scope]** Neue Indizes auf `audit_log` nach Aktion und Akteur beschleunigen
  Los-Liste, Vier-Augen-Prüfung des Risikokatalogs, Kategoriefilter der
  Audit-Seite und DSGVO-Kontaktauskunft; bei 3 Mio. Einträgen von bis zu
  0,7 s auf unter 2 ms. Der Indexaufbau dauert bei der Migration rund 15 s je
  3 Mio. Zeilen (`AUDIT-HASH-CHAIN-001`, `FK-EXC-20261005-006`).
- **[Scope]** Die globale Kanzleisuche ermittelt Kandidaten über die
  Trigramm-Indizes und lädt nur diese unter Row-Level-Security mit den
  bisherigen Zugriffsfiltern nach. Bisher konnte PostgreSQL die Indizes unter
  RLS nicht nutzen; bei 200.000 Dokumenten sinkt die Antwortzeit von rund 2 s
  auf wenige Millisekunden (`ACCESS-SEARCH-SCOPE-001`, `FK-EXC-20261005-005`).
- **[Scope]** Die Mandantensichtbarkeit (vertraulich, RESTRICTED-Modus) wird in
  Listen, Kalender, Dashboard, Arbeitskorb, Fristenkontrollbuch, Exporten,
  ZIP-Download und globaler Suche als Relationsfilter geprüft statt über
  NOT-IN-Listen aller gesperrten Mandanten (bei 5.000 Mandanten rund 4.800
  Parameter je Abfrage); sichtbare Zeilen bleiben gleich
  (`ACCESS-CLIENT-MODE-001`, `FK-EXC-20261005-004`).
- Vollmacht-, Rechnungs- und StBVV-Formulare wählen keinen Mandanten mehr
  still vor. Ein getippter, aber nicht ausgewählter Mandantenname blockiert
  das Absenden, damit kein Formular ohne den gemeinten Mandanten gespeichert
  wird.
- Fehlende Berechtigung bei Mandantenanlage und Onboarding zeigt eine Meldung
  im Formular statt zur Anmeldung umzuleiten; Validierungsfehler erscheinen im
  Formular statt über `?error=` in der Adresszeile.
- **[Scope]** Sammel-Downloads als ZIP erzeugen ein einziges Audit-Ereignis
  `document.download.bulk` mit allen gelieferten Dokument-IDs statt eines
  `document.download` je Dokument; die Hash-Kette der Kanzlei bleibt dadurch
  nicht mehr für Tausende Statements gesperrt. Vorschauen werden nur noch beim
  Byte-Abruf (`?stream=1`) als `document.preview` protokolliert. Der
  Audit-CSV-Export weist bei Sammel-Downloads Anzahl und Dokument-IDs in der
  neuen Spalte „Details“ aus (`DOC-UPLOAD-JOURNAL-001`,
  `FK-EXC-20261004-007`).
- **[Scope]** Rolling-RFC-3161-Anker werden je Kanzlei höchstens einmal pro
  Minute angefordert; offene Rechnungs- und GwG-Ereignisse weiterhin sofort.
  Gewöhnliche Einträge sind damit bis zu etwa 60 s nach dem vorigen Anker
  extern verankert statt innerhalb eines Ticks. Überlappende Läufe und
  Worker-Replikate fragen dieselbe Kettenspitze nicht mehr mehrfach bei der
  TSA an: Ein Tenant-Lease mit 30 s Laufzeit ersetzt die Datenbanktransaktion
  während des TSA-Aufrufs, eine erst nach Ablauf eintreffende Antwort wird
  verworfen. Nur TSA-Fehler lösen den Backoff aus, Datenbank- und Poolfehler
  nicht mehr (`AUDIT-RFC3161-ANCHOR-001`).
- **[Scope]** Die tägliche Integritätsprüfung der Audit-Kette rechnet nur noch
  die seit dem letzten Prüf-Checkpoint hinzugekommenen Einträge, Siegel und
  Rolling-Anker nach, in Abschnitten von höchstens 5.000 Einträgen statt in
  einer einzigen 120-Sekunden-Transaktion; TSA-Antworten werden in Blöcken
  geladen. Jeder Lauf prüft den Checkpoint vorher gegen die gespeicherte
  Kette. Mindestens alle sieben Tage und bei jedem manuellen Prüflauf folgt
  eine fortsetzbare Vollprüfung ab Genesis, die den Checkpoint bestätigen
  muss. Änderungen an bereits geprüfter Historie meldet erst die nächste
  Vollprüfung (in der Regel nach acht Tagen, sofort bei manuellem Prüflauf).
  Alarme, Benachrichtigungstexte und Audit-Aktionen bleiben unverändert
  (`AUDIT-VERIFY-ALERT-001`, `AUDIT-HASH-CHAIN-001`).
- **[Scope]** Die tägliche Kettenprüfung und die Prüfung eines
  Wiederherstellungssegments nutzen denselben Kettendurchlauf und dieselbe
  Siegelprüfung statt zweier Kopien. Ergebnisse und Bruchmeldungen bleiben
  unverändert (`AUDIT-HASH-CHAIN-001`, `FK-EXC-20261004-005`).
- Arbeitskorb mit einem gemeinsamen Leerzustand und kurzer Zusammenfassung
  leerer Fälligkeitsgruppen hinter den tatsächlich anstehenden Aufgaben.
  Bei leerem Filterergebnis führt eine direkte Aktion zurück zu allen Einträgen
  derselben Ansicht.
- Mandanten-Assistenten, Rechnungs- und Vollmachtenanlage erklären fehlende
  auswählbare Mandanten und bieten passende nächste Schritte an. Die
  Mandantenaufnahme erscheint nur mit dem bestehenden Recht `CLIENT_CREATE`.
- Einheitliche mobile Abstände, Karten, Feldbreiten und Aktionen für
  Mandantenfelder, Dokumenttypen, Rechnungstypen, Anforderungs-/E-Mail-Vorlagen
  und Tätigkeitsbereiche. Lange Namen und geöffnete Formulare bleiben auf
  schmalen Bildschirmen lesbar.

- Kürzere Navigationstitel und feste Icongrößen verhindern, dass lange
  Beschriftungen Symbole verkleinern oder verschieben. Bisherige Bezeichnungen
  bleiben als Suchbegriffe verfügbar.
- Datenschutz: Die Kanzlei kann jede aktive Option als „Zwingend“ für den
  Abschluss des öffentlichen Onboardings vorgeben, einschließlich Telefon,
  E-Mail und Kanzleiinformationen. Pflichtauswahl wird serverseitig geprüft und
  nie vorausgewählt. Hinweisfassung 4 beschreibt die Vorgabe; Widerrufsrechte,
  historische Nachweise und separate Benachrichtigungseinstellungen bleiben erhalten
  (`DSGVO-CONSENT-SNAPSHOT-001`).

- GwG-Kontrollliste und Smart-Mailbox erhalten die üblichen Seitenabstände,
  responsiven Formularfelder, Karten und Buttons. Das Anlegen eines Postfachs
  ist klar gegliedert; Nachrichten, Anhänge und Zuordnung bleiben getrennt lesbar
  (`GWG-CONTROL-EXPORT-001`, `MAIL-INBOX-001`).
- **[Scope]** Berufliches Profil und interne DATEV-Beraternummer sind zunächst
  schreibgeschützt dargestellt. Erst „Bearbeiten“ öffnet den Entwurf;
  „Abbrechen“ verwirft ihn. Speichern und die bestehende Bestätigung beim Entzug
  einer Qualifikation funktionieren auch gemeinsam. Die eigene Beraternummer
  ist mit führenden Nullen in den Kontodaten sichtbar. Rechte und serverseitige
  Validierungen bleiben unverändert (`ACCESS-STAFF-PERMISSION-001`).
- Die EU-Sanktionsquelle erklärt den Zustand vor dem ersten Abruf. Gespeicherte
  Quellversion, Umfang und Abrufzeitpunkte sowie Fehler werden beschriftet
  dargestellt. Bestehende Screening-Sperren und Prüfentscheidungen bleiben
  unverändert (`GWG-SCREENING-001`).
- Gebührenkalkulation, Mandatsorganisation, Personalfragebogen und
  Mandanten-Assistenten nutzen vorhandene Designklassen für Eingaben,
  Karten, Buttons und Rückmeldungen. Die Beteiligungsgrafik folgt dem hellen
  und dunklen Farbschema; breite Tabellen scrollen innerhalb ihrer Karte.
  Diese Darstellungsänderungen ändern keine fachliche Berechnung, Freigabe,
  Zuordnung oder Archivierung.

- `ERR_PNPM_IGNORED_BUILDS` für `tesseract.js@7.0.0` behoben: Dessen
  `opencollective-postinstall || true` zeigt nur einen Spendenhinweis an und
  wird versionsgebunden ausdrücklich deaktiviert. OCR benötigt diesen Hook
  nicht; unbekannte Installationsskripte bleiben gesperrt.
- Das Quality-Gate installiert mit leerem pnpm-Store und aktivierten,
  ausdrücklich geprüften Installationsskripten. Fehlende `allowBuilds`-Einträge
  fallen dadurch bereits in CI auf. AGENTS.md verlangt denselben frischen
  Linux-Installationsnachweis bei Dependency- und pnpm-Änderungen.
- pnpm in Projekt, Docker-Builds, Host-Setup und Tests von `11.20.0` auf
  `12.4.1` aktualisiert. Das entfallene `confirmModulesPurge` entfernt;
  Corepack lädt die native pnpm-Binary bereits beim Docker-Toolchain-Setup.
  Das Lockfile erhält die von pnpm 12 benötigten Paketmanager-Metadaten;
  der Anwendungsteil und die Supply-Chain-Schutzregeln bleiben unverändert.
- Der technische Umsetzungshinweis zu `ACCESS-TENANT-RLS-001` dokumentiert
  die Änderungen am referenzierten Supply-Chain-Guard. Die bestehenden
  SimpleWebAuthn-Patchprüfungen und fachlichen Zugriffsregeln bleiben gleich.

- **[Scope]** Audit-Verifikation unterdrückt neue Kettenfehler nicht mehr über
  alte Recovery-Checkpoints; BWA-Projektionen verwenden nur Jahre vor dem
  Zieljahr; stornierte, nie versandte Rechnungen bleiben im Portal unsichtbar.
- Staff-Suche, Expansion-Hubs und Navigation beachten Modulmodi, Featureflags,
  Einzelrechte und Mandantenzugriff je Quelle. Optimistische „Mein Tag“-Aktionen
  rollen bei Serverfehlern auf den bestätigten Zustand zurück.

- Der Integrationsabschluss zerlegt übergroße GwG-, Subsumtions- und
  Administrationskomponenten sowie reine Action-Datenabbildungen, ohne
  Fachentscheidungen, Sperrreihenfolge oder Auditinhalt zu ändern. Die
  Komplexitäts- und React-Compiler-Baselines werden für tatsächlich beseitigte
  Warnungen abgesenkt, nicht für neue Schulden erweitert. Die Abgrenzung ist
  unter `FK-EXC-20260830-012` dokumentiert.
- Lokale A11Y-Browserprüfungen können vorhandene Redis-Warteschlangen und
  MailHog-Nachrichten erhalten. Der Portal-Testlogin wartet dabei auf einen
  neuen Magic-Link zur aktuellen Anfrage; Authentisierung und Assertions
  bleiben vollständig aktiv. Lokale Diagnoseartefakte unter `.codex-run/`
  bleiben außerhalb von Git sowie Format- und Lint-Prüfung.
- Die gemeinsame Staff-/Portal-Shell besitzt Skip-Links, fokussierbare
  Hauptinhalte und semantisch isolierte mobile Navigation mit Zustand,
  Fokusfalle, Escape und Fokus-Rückgabe. Die globale Suche bildet nun ein
  semantisches Combobox-/Listbox-Muster mit Tastatursteuerung und
  Live-Trefferstatus ab; Dialoge benennen ihren Inhalt, isolieren den
  Hintergrund und führen den Fokus auch in leeren oder eingabebasierten
  Varianten sicher.
- Programmatische Formularbeschriftungen, Gruppenlegenden, Hilfetextbezüge und
  angesagte Fehler-/Erfolgsmeldungen wurden über Staff-, Portal-, GwG-,
  Datenschutz-, Kalender-, Workflow-, Bescheid-, Rechnungs- und
  Administrationsoberflächen vereinheitlicht. Die zuvor 98 vom neuen
  A11Y-Lint erkannten Labelverstöße wurden vollständig abgebaut.
- Wissensdatenbank- und Subsumtionseditoren weisen ihre Werkzeugleisten,
  Formatierungszustände, Modusumschalter und Uploadmeldungen für Tastatur und
  Screenreader aus. Pfeil-, Home- und End-Tasten navigieren innerhalb der
  Toolbars.
- Whitelabel-Akzentfarben erhalten automatisch eine kontrastgerechte schwarze
  oder weiße Inhaltsfarbe sowie einen auf hellen und dunklen Flächen geprüften
  Fokusfarbton. Wortmarken und farbiger Brand-Text erhalten zusätzlich eigene
  AA-konforme Vordergrundfarben für Light und Dark Mode. Zentrale und direkte
  Brand-Flächen verwenden diese Tokens; die Branding-Vorschau erklärt die
  konkrete Kontrastentscheidung. Muted- und bisherige
  Disabled-Informationstexte erreichen nun auch auf vertieften Flächen den
  normalen Textkontrast.
- Durch den verbreiterten Axe-Routensatz wurden weitere Bedienbarrieren
  beseitigt: Staff-Filter und der persönliche Portal-Kalenderlink besitzen
  zugängliche Namen, Monats- und Zurück-Navigationen sind für Screenreader
  benannt, scrollbare Dashboardlisten sind per Tastatur erreichbar und die
  Rollen-/Berechtigungs-Chips der Benutzerverwaltung erfüllen die
  WCAG-2.2-Zielgröße von 24 CSS-Pixeln.
- Der Mitarbeiter-Login verwendet jetzt das hinterlegte Kanzlei-Logo
  beziehungsweise den Kanzleinamen und zeigt TaxTronik nicht mehr als sichtbare
  Login-Wortmarke. Auch die herunterladbare TOTP-Backup-Datei ist neutral
  benannt.
- Der Editor für neue Subsumtionen nutzt analog zur Wissensdatenbank eine
  zusammenhängende, seitenfüllende Karte mit großer formatierter Schreibfläche,
  hervorgehobenem Titelfeld sowie gebündelten Import- und Analyseaktionen. Im
  Review bleibt die Formatierleiste dauerhaft sichtbar; die zusätzliche
  schwebende Leiste lässt sich direkt am Editor umschalten und ihr Kanzlei-
  Standard wird unter den Moduleinstellungen festgelegt. Dokument und
  Markierungspanel nutzen die verfügbare Breite besser aus.
- Kanzleiinterne Notizen in Anforderungen verwenden kontrastreiche semantische
  Flächen und Trennlinien, damit Text, Metadaten und Eingabe im Dark Mode klar
  lesbar bleiben. **[Scope]** Die fachliche Kanaltrennung nach
  `REQ-INTERNAL-COMMENT-001` bleibt unverändert.
- Die Tätigkeitszuordnung in der Benutzerverwaltung öffnet nun als fokussierter,
  scrollbar begrenzter Dialog und wird nicht mehr von der Benutzerliste
  abgeschnitten.
- Der eigenständige Status-Maschinen-Builder wurde entfernt. Da seine
  Definitionen nie an Mandanten, GwG-Prüfungen oder andere Ressourcen
  angebunden waren, entfallen die ungenutzte Administrationsoberfläche und
  die drei ausschließlich dafür vorgehaltenen Datenbanktabellen gemeinsam.
- Queue-Namen, Jobverträge, Wiederholungspläne und Health-Metadaten stammen
  jetzt aus einer gemeinsamen, runtime-leichten Definition. Die Web-App nutzt
  dafür eine geteilte Redis-Verbindung und wiederverwendete Queue-Instanzen.
- Dokument-Download und -Vorschau für Staff und Portal teilen sich nun einen
  geprüften Auslieferungsbaustein; die jeweiligen Freigabe-, Zugriffs-, Audit-
  und MIME-Regeln bleiben an den dünnen Routen explizit sichtbar. Wiederholte
  `tenant_setting`-Lese-, Schreib- und Löschsequenzen wurden ebenfalls zentral
  gekapselt.
- Native Browserdialoge und verstreute Portal-Modals wurden auf die gemeinsame
  Dialog-Infrastruktur mit Fokusfalle, Escape-/Backdrop-Verhalten und sicherer
  Formularbestätigung konsolidiert.
- Kategorien der Wissensdatenbank werden über „Kategorie anlegen“ direkt in
  der Kategorienleiste erfasst; der Seitenwechsel zum separaten Formular
  entfällt. Anlage und Bearbeitung von Wissensartikeln nutzen nahezu die volle
  verfügbare Seitenbreite, und die Artikeldetailseite zeigt vorhandene Anhänge
  zusätzlich als übersichtliche Downloadliste.
- Die Inline-Anlage einer Wissenskategorie ist auf eine einzige kompakte Zeile
  reduziert. Der Artikeldesigner startet nun als direkt formatierbarer
  WYSIWYG-Markdown-Editor; die bisherige Markdown-Eingabe ist als separate
  Quellansicht erreichbar. Überschriftsebenen, Schriftgröße, Text- und
  Markerfarbe, Unterstreichung, Durchstreichung, Listen, Zitate, Code und Links
  lassen sich unmittelbar über die Werkzeugleiste gestalten. Farb- und
  Größenangaben werden als eng begrenztes, serverseitig bereinigtes
  Inline-Markup im Markdown erhalten.
- Wissensartikel zeigen ihren Verfasser und das ursprüngliche Erstellungsdatum
  direkt in der Hauptliste, in Suchergebnissen und in der Artikelansicht an.
- Die GwG-Prüfungsseite beginnt mit dem Prüfverlauf. Stammdaten einschließlich
  der gesetzlichen Vertretung stehen vor der Mandanteneinladung; danach folgen
  „Personen“ (vormals „Identitätsnachweise“) und die Rechtsträger- und
  Registernachweise. Personen werden untereinander in voller Spaltenbreite als
  Expandables dargestellt und über „Neue Person erfassen“ ergänzt.
- Gesetzliche Vertreter werden nicht mehr über freie Namenstexte gepflegt,
  sondern aus vollständig erfassten Personen ausgewählt. Änderungen an
  gemeinsam genutzten Personendaten werden bei Doppelrollen atomar
  synchronisiert; beim Hinzufügen oder Entfernen der Rolle „Wirtschaftlich
  berechtigt“ bleiben die allgemeinen Angaben erhalten. Unvollständige
  allgemeine Angaben eines Vertreters sperren die abschließende Verifikation.
- Die Bereiche „Allgemeine Angaben“ und „Rolle(n)“ sind durch eigene Icons
  hervorgehoben; der bestehende Ausweisbereich behält sein Ausweissymbol.
- Der automatische Abgleich parallel geänderter allgemeiner GwG-Personendaten
  erfordert keinen manuellen Seitenreload mehr; der verbleibende Prüfhinweis
  lässt sich über ein X schließen.
- Die Anteilsangabe beim Ergänzen der Rolle „Wirtschaftlich berechtigt“ nutzt
  kontrastreiche semantische Oberflächen und Texte und bleibt damit auch im
  Dark Mode klar lesbar.
- Bei einer ausdrücklich über stabile IDs verknüpften Doppelrolle aus
  gesetzlicher Vertretung und wirtschaftlicher Berechtigung erkennt das
  GwG-Freigabegate den bereits bestätigten Owner-Ausweis nun zugleich als
  Vertreternachweis an. Eine bloße Namensgleichheit genügt weiterhin nicht.
  Betroffen sind `GWG-BENEFICIAL-OWNERS-001`,
  `GWG-IDENTIFICATION-EVIDENCE-001` und
  `GWG-REPRESENTATIVE-AUTHORITY-001`.
- Registernachweise starten eingeklappt. Das jeweilige Ersatzformular öffnet
  sich nur über den Button „Nachweis ersetzen“ und ist fest an den aufgeklappten
  Nachweistyp gebunden, sodass etwa ein Handelsregisterauszug nicht mehr als
  Transparenzregister-Nachweis hochgeladen werden kann.
- Für eine Person wird genau ein aktuelles Ausweis-Set mit höchstens zwei
  Dateien (Vorder- und Rückseite) ausgewertet. „Ausweis ersetzen“ macht ein
  neues Set zum aktuellen Nachweis; ältere Sets erscheinen nur unter
  „Alte Ausweise“. Änderungen an Identitätsdaten heben eine frühere
  Identitätsbestätigung und Risikoprüfung auf. Betroffen sind die Regeln
  `GWG-BENEFICIAL-OWNERS-001`, `GWG-REPRESENTATIVE-AUTHORITY-001` und
  `GWG-IDENTIFICATION-EVIDENCE-001`.
- **[Scope]** Die ungetaggten Sammelstände `7318ee1d` und `b5bfb8d4`
  enthalten umfangreiche fachliche, Berechtigungs-, Mandantentrennungs-,
  Formular-, Fristen-, GwG-, Rechnungs-, Archiv- und
  Nachweiskorrekturen. Sie sind auf `main`, aber noch keinem Release
  zugeordnet. Vor dem nächsten Tag sind die Release-Notes gegen diese Commits
  fachlich zu vervollständigen; dieser Sammelhinweis ist kein Ersatz dafür.
- Die PS-880-Gap-Analyse grenzt Release- und Source-Kanal, interne
  Statusbewertungen, offene Action-Level-Tests, zeitlich begrenzte
  CI-Artefakte und fehlende Fachfreigaben nun ausdrücklich ab. Vorlagen gelten
  nicht länger als bereits erbrachte Nachweise.

### Behoben

- **[Scope]** Das Einzelrecht `CLIENT_CREATE` wirkt: Mitarbeitende mit diesem
  Recht legen Mandanten per Schnellanlage und Onboarding an, wie
  Benutzerverwaltung, Mandantenliste und Formulare es anbieten; bisher lehnte
  die Action alle außer ADMIN/PARTNER nach dem Ausfüllen ab
  (`ACCESS-STAFF-PERMISSION-001`). Neue Mandanten bleiben bis zur GwG-Freigabe
  gesperrt.
- Uploads über Server Actions (externe Rechnungs-PDF, Steuererklärungs-PDF,
  DATEV-BWA-XLSX, Formular-Datei im Mandantenportal, GwG-Onboarding) werden
  binär statt als base64 übertragen; die angezeigten Grenzen von 10 bzw. 20 MB
  gelten jetzt tatsächlich (bisher Abbruch ab rund 7,5 MB). Vollmachts-,
  Lohn- und Subsumtions-Importe erreichen die vollen 25 MiB
  (`FK-EXC-20261006-017`).
- **[Scope]** Direkte Uploads (Staff- und Portal-Upload, neue Version,
  Wissensanhänge, Umklassifizierung mit Re-Store, externe Rechnungen,
  Steuererklärungs-PDF, Formular-Uploads, Aktenregal, E-Rechnungsarchiv)
  halten die Speicherabsicht vor dem Schreiben in den Object Store fest und
  schließen sie mit dem Datenbank-Commit ab. Nach einem Abbruch dazwischen
  räumt der Cleanup-Worker das Objekt nach der Sicherheitsfrist versionsgenau
  auf (unter Object Lock nach Ablauf der Aufbewahrung) (Migrationen
  `20261006130000`, `20261006130100`, `DOC-UPLOAD-JOURNAL-001`,
  `FK-EXC-20261006-016`).
- Die Dokument-Detailseite kennzeichnet GwG-Nachweise nicht mehr als
  „GoBD-immutable“ mit COMPLIANCE-Hinweis; Schutzstufe, Status- und
  Typbezeichnungen kommen aus einer gemeinsamen Quelle
  (`GWG-RETENTION-DESTRUCTION-001`, `FK-EXC-20261006-013`).
- Mandanten-Links in Mails des Workers (z. B. automatische Anforderungen aus
  Steuerterminen) zeigen bei getrennten Subdomains auf `PORTAL_PUBLIC_URL`
  statt auf die Staff-Domain; Compose reicht `PORTAL_PUBLIC_URL` jetzt an den
  Worker durch.
- `scripts/dev-magic-link.ts` funktioniert wieder mit Prisma 7. `pnpm typecheck`
  prüft zusätzlich `packages/db/scripts` und die TypeScript-Skripte unter
  `scripts/`; das seit dem Wegfall von `rawResult` nicht mehr lauffähige
  Backfill-Skript `backfill-norm-refs.ts` ist entfernt (Fachkatalog-Verweis
  in `RISK-ARCHIVE-SNAPSHOT-001` entsprechend bereinigt).
- Setup- und Startskripte (`setup.sh`, `setup.ps1`, `Start-TaxTronik.ps1`,
  `Start-SignalDev.ps1`) schreiben die `.env` über eine gemeinsame Hilfe
  (`scripts/env-tool.mjs`): Werte mit Sonderzeichen wie `|` oder `$` werden
  nicht mehr abgeschnitten oder ersetzt, Secrets entstehen auch bei
  CRLF-Vorlagen, bekannte Dev-Defaults werden einheitlich erkannt und die
  `.env` erhält Modus 0600.
- Deaktivierte Module sind auch bei Navigation innerhalb der App gesperrt
  (404); Navigation und Zugriffsprüfung nutzen eine gemeinsame
  Modul-Registry. Der Kanzleikalender erscheint, sobald Termine oder
  Steuertermine aktiv sind, und zeigt nur Inhalte aktiver Module; „Stunden
  abrechnen“ erscheint nur mit aktivem Rechnungsmodul, „Vollmachten“ nur mit
  aktivem Vollmachtsmodul (`FK-EXC-20261006-005`).
- Rechnungen aus Zeiterfassung und StBVV-Kostenvoranschlägen durchlaufen
  dieselben Prüfungen wie manuelle Rechnungen: Reverse-Charge ohne
  USt-IdNr der Kanzlei (§ 13b UStG), Beträge über den Datenbankgrenzen und
  Rechnungsdaten außerhalb des laufenden Jahres ±1 werden abgelehnt, bevor
  eine Rechnungsnummer vergeben wird; bisher scheiterte eine solche
  Stundenabrechnung erst beim Versand und hinterließ eine vergebene Nummer
  (`INV-NUMBER-ALLOCATION-001`, `INV-VAT-TOTALS-001`,
  `STBVV-CALCULATION-001`, `FK-EXC-20261006-004`).
- E-Rechnungs-Downloads (XRechnung/ZUGFeRD): Reverse-Charge-Rechnungen ohne
  USt-IdNr der Kanzlei liefern in beiden Routen 422 mit Hinweis auf die
  Kanzlei-Stammdaten statt 404 „nicht gefunden“; technische Fehlertexte
  erscheinen nicht mehr in der Antwort, sondern nur im Server-Log
  (`INV-ARCHIVE-EINVOICE-001`, `FK-EXC-20261006-003`).
- n8n: Erneut senden und Replay einer Zustellung an einen Endpunkt im
  Testmodus nutzen wieder die Test-URL, statt vom Worker als „Route geändert“
  verworfen zu werden. Ziel, Vorrang des Signaturgeheimnisses und
  Job-Optionen kommen für Web und Worker aus `@taxtronik/n8n-shared`.
- „Erneut versuchen“ auf Fehlerseiten lädt die Serverdaten neu, statt nur die
  Oberfläche neu zu zeichnen. Deutsche 404-Seiten für Kanzleibereich, Portal
  und unbekannte Adressen sowie eine eigene Seite für Fehler im Grundlayout
  ersetzen die englischen Next.js-Standardseiten.
- Dark Mode: Explizite `dark:`-Angaben werden nicht mehr von globalen
  Overrides überstimmt; Status- und Markenfarben schalten über Theme-Tokens
  um. Der Glaseffekt des modernen Modus liegt nur noch auf der Kopfleiste statt
  auf sticky Tabellenzellen und Aktionsleisten; auf Smartphones bleiben
  Kopfleiste und Menü im modernen Dark Mode deckend (`FK-EXC-20261005-038`).
- Tailwind-Token-Klassen wie `text-secondary`, `bg-surface-raised` oder
  `border-default` wirken jetzt auch mit Varianten (`hover:`, `dark:`,
  `[&_th]:`) und Deckkraft-Modifiern; bisher erzeugten rund 150 solcher
  Verwendungen kein CSS. Die Brand-Stufen 200, 300, 400, 800 und 950 sind für
  Standard- und Kanzleifarben definiert. Ein Test meldet Klassen, die kein CSS
  erzeugen.
- Steuertermine: Die Kacheln „Überfällig“ und „Anstehend“ zeigen die
  tatsächliche Anzahl statt der Länge der auf 100 bzw. 200 Zeilen begrenzten
  Listen; beide Listen sind blätterbar und zeigen „100 von 312 angezeigt“. Im
  Mandantenportal zählen „offen“ und „Offene Rechnungen“ alle offenen
  Einträge, gekappte Listen verweisen auf die vollständige Liste. Die
  Mandantenliste zählt wie Mandantenseite und CSV-Export keine gelöschten
  Dokumente mehr (`ACCESS-SEARCH-SCOPE-001`, `FK-EXC-20261005-035`).
- Fehler beim Entfernen eingeplanter Aufträge werden protokolliert statt
  verschluckt; Job-Fehler erscheinen nicht mehr doppelt im Log
  (`FK-EXC-20261005-023`).
- Die tägliche Erinnerungsrunde (Bescheide, Wiedervorlagen, Pendelordner)
  verarbeitet Mandanten in Abschnitten von 200 in kurzen Transaktionen statt
  alle Kandidaten einer Kanzlei in einer gesperrten 15-Sekunden-Transaktion;
  große Kanzleien laufen nicht mehr ins Transaktionslimit, und die Sperren
  blockieren morgens keine Bearbeitungen mehr (`TAX-NOTICE-APPEAL-001`,
  `FK-EXC-20261005-019`).
- **[Scope]** Audit-Archiv: Scheitert der RFC-3161-Stempel, wird das Segment
  als ausstehend archiviert und später nach Prüfung des gespeicherten Objekts
  nachgestempelt; bisher blieb es dauerhaft ohne externen Zeitnachweis. Die
  Zeitstempelstelle wird in allen Worker-Pfaden gleich gewählt, und die
  Prüfung vorhandener Stempel braucht in Produktion kein Netz mehr
  (`AUDIT-ARCHIVE-001`, `AUDIT-RFC3161-ANCHOR-001`, `FK-EXC-20261005-018`).
- Nicht weitergeleitete n8n-Übergaben aus Workflows (Ereignis nicht
  abonniert, n8n aus, Route inaktiv) werden abschließend verbucht statt
  minütlich ohne Grenze wiederholt; ab 100 solcher Zeilen blieben echte
  Schreibfehler bisher liegen. Schreibfehler werden jetzt mit Backoff
  nachgezogen (`WORKFLOW-LIFECYCLE-001`, `FK-EXC-20261005-017`).
- GwG- und Vollmachts-Ablaufwarnungen gehen nur noch an aktive Mitarbeitende
  mit aktuellem Mandantenzugriff; ist niemand mehr zuständig, an aktive
  Admins und Partner. Bisher erreichten die Vorwarnungen nach einem
  Personalwechsel niemanden (`GWG-REVERIFICATION-VALIDITY-001`,
  `FK-EXC-20261005-016`).
- **[Scope]** Sechs RLS-Policies lesen den Tenant-Kontext über
  `app.current_tenant_id()`; ein fehlender oder geleerter Kontext liefert keine
  Zeilen statt eines Fehlers 500. Die Kontextfunktionen sind `PARALLEL SAFE`
  (`ACCESS-TENANT-RLS-001`, `FK-EXC-20261005-007`).
- Das Dashboard-Widget „Wiedervorlagen“ blendet interne Wiedervorlagen ohne
  Mandant nicht mehr aus, sobald ein Mandant gesperrt ist
  (`REMINDER-TICKET-001`).
- Pausierte Workflows mit erreichtem Wiederaufnahmedatum setzt der Worker alle
  fünf Minuten fort; bisher geschah das erst, wenn jemand die Workflow-Seite
  des Mandanten öffnete, und bis dahin blieben sie in Übersicht, Dashboard und
  Arbeitskorb pausiert. Das Rendern der Seite schreibt nicht mehr
  (`WORKFLOW-LIFECYCLE-001`, `FK-EXC-20261005-003`).
- Cron-Zeitpläne nennen ihre Zeitzone. Die acht nächtlichen Wartungsjobs
  (u. a. Kettenprüfung, Audit-Rotation, DSGVO-Aufbewahrung, Backup und
  Restore-Drill) laufen wie dokumentiert in UTC; bisher liefen sie in den
  Containern nach Berliner Ortszeit und damit eine bzw. zwei Stunden früher als
  dokumentiert. Tagesbezogene Jobs laufen weiterhin in Europe/Berlin.
  Log-Beschriftungen werden aus den Zeitplänen erzeugt.
- Fehlgeschlagene Hintergrundjobs und Worker-Fehler werden für alle Worker
  protokolliert; bisher hatten 11 von 26 Workern keinen Fehler-Handler. Fehler
  beim Zählen fehlgeschlagener Staff-Anmeldungen werden geloggt statt
  verworfen. Das Sammel-Schließen von Anfragen schließt die übrigen und nennt
  nicht geschlossene mit Grund. Speicherfehler bei GwG-Ausweisen erscheinen
  als vorübergehender Speicherfehler statt als „Nachweis neu erfassen“. Ist
  die Kanzlei-SMTP-Konfiguration nicht lesbar, wird der Versand abgebrochen,
  statt still über den SMTP-Server aus der `.env` zu senden
  (`FK-EXC-20261005-001`).
- Mandantenauswahlen (Termin, Wiedervorlage, Zeiterfassung, Telefonnotiz,
  Mandanten-Assistent, Vollmacht, Rechnung, Lohn, StBVV, Jahreswechsel,
  Workflows, GwG-Kontrollliste, Mandatsorganisation, Anfragen) suchen
  serverseitig mit derselben Zugriffsregel, statt den ganzen Bestand oder nur
  die ersten 500 beziehungsweise 1.000 Mandanten zu laden; spätere Mandanten
  sind wieder auswählbar. Ohne Suchbegriff schlägt die Auswahl die eigenen
  zugeordneten Mandanten vor. Der Posteingang ermittelt Zuordnungsvorschläge
  per Datenbankabfrage und bietet je Anhang die Mandantensuche statt einer
  vollständigen Liste; „Archivdokument anzeigen“ öffnet die Dokumentansicht
  (`FK-EXC-20261004-016` bis `FK-EXC-20261004-018`).
- Formulare der Kanzlei und des Mandantenportals melden Eingabe-,
  Berechtigungs- und Fachfehler jetzt direkt im Formular; die Eingaben bleiben
  erhalten. Bisher endeten etwa die Plausibilitätsprüfungen der
  Bescheiderfassung, Fristen-Sammelaktionen, DSGVO-Anträge, Mandantenanlage,
  Rechnungsstatus oder Smart-Mailbox in „Seite konnte nicht geladen werden“,
  oder Fehler wurden still verworfen: Der Vollmachtswiderruf meldete Erfolg
  auch bei Ablehnung, ein abgelehnter Einwilligungswiderruf im Portal blieb
  ohne Hinweis, das Vier-Augen-Prinzip beim eigenen Urlaubsantrag griff ohne
  Meldung. Ein Guardrail-Test verhindert künftig Server-Actions ohne
  Rückmeldung und verworfene Prüfergebnisse; der Autorisierungs-Guardrail
  prüft jetzt alle `'use server'`-Dateien (`FK-EXC-20261004-014`,
  `FK-EXC-20261004-015`).
- Die GwG-Schutzinvarianten, die beim Deploy und Kunden-Update über den Start
  schreibender Dienste entscheiden, liefen in CI nie gegen eine echte
  Datenbank; die Tests ersetzten `compose` durch eine Funktion, die immer
  „erfüllt“ meldete. Die Prüfungen liegen jetzt versioniert unter
  `packages/db/invariants/gwg` und laufen beim Deploy (psql im
  Postgres-Container, nur lesend) sowie in CI im db- und upgrade-path-Job
  (`pnpm --filter @taxtronik/db verify:invariants`) gegen die echte Datenbank.
  Ein SQL- oder Verbindungsfehler wird nicht mehr als „Schutz unvollständig“
  gemeldet, sondern mit der psql-Fehlermeldung; verletzte Invarianten werden
  einzeln benannt. Schreibende Dienste bleiben in beiden Fällen gestoppt
  (`FK-EXC-20261004-012`).
- **[Scope]** ZUGFeRD-Rechnungen und Korrekturbelege sowie der
  Subsumtions-PDF-Export setzen Namen und Texte mit Zeichen außerhalb von
  WinAnsi (z. B. ı, Ş, ğ, Ł, ř) korrekt. Ausstellung und Storno scheiterten
  daran bisher mit `WinAnsi cannot encode`, der Subsumtions-Export
  verstümmelte sie still. Eingebettet werden die geprüften Noto-Schriften
  über die neue Abhängigkeit `@pdf-lib/fontkit` 1.1.1 (ohne
  Installationsskripte); bereits archivierte Rechnungsfassungen bleiben
  byte-identisch. Nicht darstellbare Zeichen wie Emoji, in Rechnungen auch
  CJK, sperren die Erzeugung mit Angabe der betroffenen Zeichen; im
  Subsumtions-Export erscheint der Hinweis direkt im Exportfenster.
  Tabulatoren erscheinen in PDF-Ausgaben als Leerzeichen statt als
  Ersatzkästchen (`INV-ARCHIVE-EINVOICE-001`, `FK-EXC-20261004-009`,
  `FK-EXC-20261004-010`).
- **[Scope]** Sammel-Download und DATEV-Belegexport streamen das ZIP direkt
  aus dem Object-Store in die Antwort, statt bis zu 1 GiB mehrfach im
  Webprozess zu puffern; ein großer Mandantenordner kann den Webprozess nicht
  mehr per Speichermangel neu starten. Der Export-Slot bleibt bis zum Ende der
  Übertragung belegt und wird bei Abbruch freigegeben; gestreamte Exporte
  haben einen eigenen Pool mit vier Slots. ZIP-Einträge tragen exakte Local
  Header ohne Data Descriptor und sind damit auch für Stream-Leser wie Javas
  `ZipInputStream` lesbar. Im DATEV-Export stehen `index.csv` und
  `manifest.txt` am Ende des Archivs. Ein Fehler nach Beginn der Übertragung
  bricht den Download ab, statt ein unvollständiges Archiv zu liefern.
  Gepufferte ZIP-Erzeugung (Lohnexport, Mandatsartefakte) richtet ihre
  Größengrenze nach dem Container-Speicherlimit: höchstens 1 GiB, bei 2 GB
  Speicher 256 MiB (`DOC-UPLOAD-JOURNAL-001`, `FK-EXC-20261004-008`).
- **[Scope]** Der DATEV-Belegexport protokolliert `client.belege.export` erst
  nach Größen-, Eintrags- und Slot-Prüfung; mit 413 oder 429 abgelehnte
  Exporte erscheinen nicht mehr im Prüfprotokoll. Der Sammel-Download schreibt
  seinen Abrufnachweis ebenfalls erst nach dem Slot-Erwerb
  (`DOC-UPLOAD-JOURNAL-001`, `FK-EXC-20261004-006`).
- **[Scope]** Die RLS-Prüfungen für Benachrichtigungen, Lohnakten und
  Mandatsartefakte suchen Ressourcen per UUID-Index statt per
  Textvergleich. Mit 200.000 Dokumenten sinkt die Abfrage der
  Benachrichtigungsglocke von rund 100 s auf unter 0,5 s; Treffermengen,
  Policies und Grants bleiben unverändert (`ACCESS-NOTIFICATION-RECIPIENT-001`,
  `ACCESS-TENANT-RLS-001`, `FK-EXC-20261004-001`).
- Der PostgreSQL-Nachweis `service-db.test.ts` für `MANDATE-STRUCTURE-001`,
  `GWG-BENEFICIAL-OWNERS-001`, `GWG-RISK-REVIEW-001` und
  `GWG-RETENTION-DESTRUCTION-001` lief bisher in keiner Pipeline. Der
  blockierende DB-CI-Job führt ihn jetzt gegen eine frische, isolierte
  Datenbank aus und lädt das Protokoll hoch; ein Guard-Test verhindert, dass
  der Schritt wieder herausfällt (`FK-EXC-20261004-003`).
- Datenbankfehler in Server-Actions erscheinen im Server-Log. Bisher meldete
  `toActionError` etwa Transaktions-Timeouts (P2028), Serialisierungskonflikte
  (P2034) oder einen erschöpften Pool (P2024) nur als „Datenbankfehler.“ im UI.
  P2025 und P2002 werden als Warnung, alle übrigen Codes als Fehler geloggt,
  ohne Zeilenwerte aus den Postgres-Details (`FK-EXC-20261004-002`).
- Abfragen des App-Clients enden jetzt auch in der Datenbank: `statement_timeout`
  20 s und `idle_in_transaction_session_timeout` 30 s, beide über dem
  Transaktionslimit von 15 s. Bisher lief eine von Prisma aufgegebene Abfrage
  serverseitig weiter und hielt ihre Verbindung. Owner-, Migrations- und
  Worker-Verbindungen bleiben ohne Limit.
- PostgreSQL protokolliert Abfragen ab 1 s (`POSTGRES_LOG_MIN_DURATION_MS`)
  und Lock-Wartezeiten, ohne Bind-Parameter und damit ohne Mandantendaten.
- Stammdaten-Änderungen eines Mandanten warten nicht mehr auf parallele
  Einfügungen in eine der 49 Kindtabellen. Der Paar-Guard sperrt den Mandanten
  mit `FOR KEY SHARE` statt `FOR SHARE`; Löschung, Schlüsseländerungen und
  explizites `FOR UPDATE` bleiben serialisiert (`ACCESS-TENANT-RLS-001`,
  `FK-EXC-20261004-004`).
- Die E2E-Bereinigung respektiert die Redis-Datenbank aus der URL und sendet
  `FLUSHDB` erst nach bestätigtem `SELECT`. Neue verpflichtende Helper-Tests
  verhindern das versehentliche Leeren von Datenbank 0 sowie übrig gebliebene
  Login-Sperren in einer anderen Testdatenbank
  (`ASSURANCE-RELEASE-EVIDENCE-001`).
- Der Root-Typecheck erfasst jetzt auch alle E2E-Specs und deren Helper-Units;
  die Inbox-Reply-Fixtures sind korrekt typisiert.
- **[Scope]** Admin-Einstellungen und ihr Audit werden gemeinsam committed;
  fehlgeschlagene Auditierung lässt keine bereits wirksame Einstellung zurück
  (`ACCESS-CLIENT-MODE-001`, `AUDIT-HASH-CHAIN-001`).
- Fristenmaterialisierung und Konfigurationswechsel sind gegen gleichzeitige
  Workerläufe abgesichert. Änderungen der Steuerregion erhalten vorhandene
  Termine entsprechend der bisherigen Bedienregel
  (`TAX-DEADLINE-WORKDAY-001`, `TAX-DEADLINE-AUTOREQUEST-001`).
- **[Scope]** Rechnungspositionen bleiben an ihre ursprüngliche Rechnung
  gebunden; Statusprüfung und Festschreibung verwenden dieselbe Zeilensperre.
  Zahlungsmarkierungen beanspruchen ihren Status atomar; Zahlung und
  Stornoversand halten dieselbe Sperrreihenfolge ein. Manuelle Mengen und
  Preise müssen zur gespeicherten Dezimalpräzision passen, Kopf- und
  Steuersummen werden vor einem Datenbanküberlauf abgewiesen
  (`INV-LIFECYCLE-FREEZE-001`, `INV-VAT-TOTALS-001`).
- Verspätete IMAP-Polls dürfen weder neuere Mailboxzustände noch bereits
  importierte Anlagen überschreiben (`MAIL-INBOX-001`).
- Risk-Exporte unterstützen internationale Dateinamen einschließlich Zeichen
  außerhalb der Unicode-Basisebene (`ACCESS-CLIENT-MODE-001`).
- Wiederholte Schema-Driftprüfungen bereinigen auch das eigene Shadow-Schema
  `app`. Verbindungs- und Datenbankidentitätsprüfungen schützen die eigentliche
  Zieldatenbank vor Verwechslung; CI prüft zwei vollständige Durchläufe
  (`ASSURANCE-RELEASE-EVIDENCE-001`).
- Addison-Importe unterscheiden echte Kalenderquartale von anderen Zeiträumen
  und weisen ungültige Monatsgrenzen zurück; DATEV-Leerbeträge gelten nicht
  als Nullwerte (`BWA-IMPORT-MAPPING-001`). GwG-Ausweisentscheidungen verwenden
  den Berliner Kalendertag auch unmittelbar um Mitternacht
  (`GWG-IDENTIFICATION-EVIDENCE-001`).
- **[Scope]** Risk-Archivierung bindet den vollständigen geprüften Stand und
  serialisiert konkurrierende Bearbeitungen mit Datenbanksperren und einem
  DB-Backstop. Verspätete Analyseergebnisse dürfen keinen archivierten oder
  anonymisierten Stand überschreiben (`RISK-ARCHIVE-SNAPSHOT-001`,
  `RISK-AI-SUGGESTION-001`, `DSGVO-MANDATE-ANONYMIZATION-001`).
- Fachkatalog-Ausnahmen können dieselben katalogreferenzierten Dateien
  abdecken, die der Diffguard überwacht; historische Einträge bleiben
  unveränderlich (`ASSURANCE-PROFESSIONAL-REVIEW-001`).

- Der Docker-Web-Build transpiliert auch das injizierte TypeScript-Paket
  `@taxtronik/elster`. Ein Regressionstest gleicht die Next.js-Konfiguration
  mit den Workspace-Laufzeitabhängigkeiten ab und verhindert weitere
  Auslassungen. Die technische Änderung ist bei `MAIL-INBOX-001` dokumentiert;
  die fachliche Posteingangslogik bleibt unverändert.

- Die Barrierefreiheitsprüfung der Staff- und Verwaltungsseiten ist in kürzere
  Rundgänge aufgeteilt, damit alle Seiten innerhalb der unveränderten
  Zeitbudgets geprüft werden.

- Die SQL-Regression der Rechnungs-Mandantenauswahl läuft verbindlich im
  CI-Datenbank-Job und erhält einen eigenen Testnachweis. Konfigurierte URLs
  aktivieren sie nicht mehr versehentlich im Unit-Job ohne PostgreSQL-Dienst.

- ClamAV kann seinen Laufzeitordner jetzt bereits beim ersten Containerstart
  korrekt anlegen. Eine fehlende Dateisystem-Capability führte bisher zu einem
  frühen Abbruch, den ein automatischer Neustart häufig verdeckte. Die
  Deployment-Prüfung verlangt nun einen erfolgreichen Start ohne Neustart.
- Nächtliche Qualitätsprüfung: Der Arbeitskorb priorisiert überfällige Aufgaben
  vor dem Gesamtlimit. Eigene Dokumenttypen erscheinen wieder im Mailbox-Import;
  inkonsistente aktive Dienstleisterbezüge blockieren neue Datenschutzerklärungen
  vor der Pflichtprüfung (`PORTAL-INBOX-SUBMISSION-001`, `MAIL-INBOX-001`,
  `DSGVO-CONSENT-SNAPSHOT-001`).
- Posteingangsantworten leeren Text und Dateiauswahl nach bestätigtem Speichern
  zuverlässig. Netzwerkfehler erhalten den Entwurf und die Retry-Identität.
  Portal-Lesestände bestätigen nur angezeigte Nachrichten und bleiben bei
  verspäteten Bestätigungen monoton (`PORTAL-INBOX-SUBMISSION-001`).
- Mobile Formularbreiten und Beschriftungen in Mandanten- und Benutzeranlage
  sowie Personalaufnahme korrigiert; Datenschutzsymbol behält seine Größe.
  Arbeitskorb-Schaltflächen, Onboardingkontrast, Zurück- und Monatslinks,
  Audit-Prüflink sowie scrollbare Feedback- und Abwesenheitstabellen sind besser
  per Tastatur, Touch und Screenreader bedienbar.
- Zwölf schmale Seitenansichten erhalten umbrechende Kopfzeilen und Aktionen
  sowie lokale Tabellenscrollbereiche. Die Browserprüfung erfasst jetzt auch
  seitlichen Überlauf im Hauptinhalt. Ungelesene Benachrichtigungen und
  Hintergrundjobs bleiben im Dark Mode lesbar.
- Heute fällige versendete Rechnungen werden in der Kanzleiübersicht erst ab
  dem folgenden Berliner Kalendertag als „Überfällig“ angezeigt, konsistent
  mit Portal und bestehender Fachregel (`INV-DUE-OVERDUE-001`).
- Kanzleileitfäden behalten ungespeicherte Auswahlen beim Wechsel der Vorlage.
  Auswahlgrenze, Leerzustände, ausstehende Änderungen und Speicherfehler werden
  direkt erklärt; gespeichert wird ausschließlich die aktuelle Auswahl
  (`KNOWLEDGE-CONTEXT-001`).
- Der Ticket-Browsertest wartet vor dem Neuladen auf den gespeicherten Kommentar.
  Text im Eingabefeld kann keinen vorzeitigen Testfortschritt mehr auslösen
  (`REMINDER-TICKET-001`). Der technische Prüfbericht steht unter
  `docs/development/qa-2026-09-14.md`.

- Im Arbeitskorb umfasst der Hover- und Tastaturfokus die gesamte Listenzeile
  einschließlich Symbol; die Erledigen-Aktion bleibt separat bedienbar.
- „Zuletzt“ bei Mandanten zeigt aktuelle, serverseitig sichtbare Namen statt
  alter Browserkopien. Die Besuchshistorie speichert nur IDs, getrennt nach
  Kanzlei und Mitarbeiter; Altwerte früherer Installationen werden verworfen
  (`ACCESS-SEARCH-SCOPE-001`).
- Das Audit-Log zeigt die aktuelle lokale Kettenspitze unabhängig von
  Tabellenfiltern neben der externen Verankerung. Eine leere oder nicht
  vertrauensverankerte externe Kette erhält keinen grünen Erfolgsstatus
  (`AUDIT-HASH-CHAIN-001`, `AUDIT-RFC3161-ANCHOR-001`).

- Der vollständige CI-Browsertestlauf erkennt neue und verschachtelte Specs
  automatisch, einschließlich der Profiltests. Eine zusätzliche manuelle
  Dateiliste entfällt. Der lokal und in CI identische Guard prüft die echte
  Playwright-Testerkennung, läuft unter Windows ohne `sh` und ist Bestandteil
  von `pnpm lint`; Regressionstests sichern die Abdeckung gegen Filter ab.

- Kanzlei- und Mandantenportal verwenden für ihre Navigation dieselbe schmale,
  an das helle oder dunkle Farbschema angepasste Scrollleiste wie die kompakten
  Dashboard-Listen. Damit entfällt der helle native Scrollbalken in Chrome.

- **[Scope]** Restore meldet Erfolg erst nach verpflichtender Prüfung der
  effektiven Rollen-, Audit-Schreibsperren und RLS-Policies, auch bei
  `--no-smoke-test`. Unsichere, durch Ziel-Defaultprivilegien veränderte Rechte
  führen zu einem Fehler und einem ausdrücklichen Hinweis, die Dienste
  gestoppt zu lassen (`ACCESS-TENANT-RLS-001`, `AUDIT-HASH-CHAIN-001`). Die
  nachgelagerte Prüfung rollt den bereits angewendeten Restore nicht zurück.
- **[Scope]** Dokumentdownload, Vorschau und ZIP-Exporte liefern die neueste
  Version erst nach erfolgreichem Scan und abgeschlossenem Upload aus; eine
  ältere Version wird nicht stillschweigend ersatzweise ausgegeben
  (`DOC-UPLOAD-JOURNAL-001`, `DOC-VERSION-IMMUTABILITY-001`,
  `DOC-PORTAL-SHARING-001`). DATEV-Belegexporte erhalten korrekte Office-Endungen
  und weisen ungültige oder umgekehrte Datumsbereiche zurück.
- **[Scope]** Die Audit-Kanonisierung erhält eigene JSON-Schlüssel wie
  `__proto__` vollständig. Gewöhnliche Hashes bleiben bytegleich. Historische
  Ereignisse mit diesem bislang ungebundenen Sonderfeld können jetzt eine
  Abweichung zeigen; historische Hashes und Archive werden nicht verändert
  (`AUDIT-HASH-CHAIN-001`, `AUDIT-ARCHIVE-001`).
- BWA-Auswertungen unterscheiden DATEV-Erlöse, Gesamtleistung, Betriebs- und
  Vorsteuerergebnis. Der Cashflow-Proxy verwendet die Abschreibungsposition.
  Fehlende Werte bleiben unbekannt; automatische Planvorbelegung erfordert
  vollständige, zum Modell passende Daten. Steuerschätzungen benötigen eine
  bekannte Vorsteuerbasis (`BWA-IMPORT-MAPPING-001`, `BWA-PROJECTION-001`,
  `BWA-TAX-ESTIMATE-001`).
- Vollmachtsablauf, Audit-Eintrag und Benachrichtigungen werden atomar
  gespeichert. Fehler können sicher wiederholt werden; Empfänger werden
  unmittelbar vor dem Versandauftrag erneut geprüft (`POA-LIFECYCLE-001`,
  `ACCESS-NOTIFICATION-RECIPIENT-001`). Gleich lange neue SMTP-Passwörter
  aktualisieren den zwischengespeicherten Transport ebenfalls.
- Gleichzeitige Terminentscheidungen überschreiben sich bei Portalabsagen
  nicht mehr. Der Editor erhält Formatierungen beim Import und selbst
  eingegebene Titel; fehlgeschlagene Formatierungssaves werden wiederholt.
  Erfassung, Prüfung und Speicherzustände sind in kleinere Komponenten und
  Hooks aufgeteilt (`FK-EXC-20260907-004`).
- Windows-Setup erhält bei fehlgeschlagenem Docker-Reset die Konfiguration.
  UTF-8-Kodierung, Docker-Argumente und Exitcodes funktionieren unter Windows
  PowerShell 5.1 und PowerShell 7 mit eigenen Regressionstests.
- **[Scope]** Ungelesene Benachrichtigungen stehen auch bei vielen gelesenen
  Einträgen zuerst. Der Zähler umfasst alle berechtigten ungelesenen Hinweise
  unabhängig vom 100er-Anzeigefenster (`ACCESS-NOTIFICATION-RECIPIENT-001`).
- **[Scope]** Der Dokumentenbrowser verschiebt bereits ausgewählte Dateien
  zuverlässig. Mandanten-, Ordner- und Suchkontextwechsel setzen Auswahl und
  Dialoge gemeinsam zurück; Aktualisierungen im selben Kontext erhalten sie.
- XLSX-Importe lesen Workbook-Relationships mit, damit Blattnamen zu den
  tatsächlichen Werten gehören. Der XML-Leser vermeidet quadratisches
  Backtracking bei fehlerhaften Attributen und lässt unbekannte Entities
  unverändert (`BWA-IMPORT-MAPPING-001`).
- Die GwG-Seite trennt Datenzugriff, Aufbereitung und Darstellung. Abgelaufene
  und vernichtete Prüfungen zeigen keine aktuelle Verifikation oder
  Weiterleitung zur nächsten Onboarding-Stufe mehr; vernichtete Aufzeichnungen
  bieten keine Personenbearbeitung oder Freigabe an
  (`GWG-REVERIFICATION-VALIDITY-001`, `GWG-RETENTION-DESTRUCTION-001`).
- Markdown-Ansichten blockieren bei unvollständigen Tabellen nicht mehr.
  Inline-Code bleibt wortgetreu; Formatierungszeichen in Linkzielen und
  private Unicode-Zeichen werden nicht mehr umgeschrieben. Blockerkennung und
  Inline-Verarbeitung sind in getrennte, überschaubare Funktionen aufgeteilt.
- Globale Suche entfernt vorherige Datensatztreffer bei jedem Begriffswechsel,
  damit Enter während einer laufenden Suche keinen alten Treffer öffnet.
  Deaktivierte Datumswähler senden auch ihren versteckten Formularwert nicht mit.
- Mandanten-Timeline berücksichtigt aktuelle Folgeereignisse älterer Vorgänge
  und wendet die Zeitgrenze auf jedes Ereignis an. Tagesgruppen verwenden
  durchgehend Berliner Zeit; ungültige Nachladelimits führen nicht mehr zu
  Datenbankfehlern, und der Nachladelink endet an der Grenze von 500 Ereignissen.
- **[Scope]** Die Audit-Übersicht zählt ausschließlich Einträge der eigenen
  Kanzlei statt einer datenbankweiten Tabellenschätzung. Datenzugriff,
  Filterzustand und Darstellung sind getrennt; Zugriffs- und Kettenprüfungen
  bleiben erhalten (`AUDIT-HASH-CHAIN-001`, `ACCESS-TENANT-RLS-001`).
- **[Scope]** Öffentliche TOTP-Einrichtung und Bestätigung binden ihren
  Schreibzugriff an den geprüften Passwort-, Konto- und Faktorstand.
  Verspätete Anfragen öffnen keine bereits abgeschlossene Einrichtung erneut
  und übernehmen keinen inzwischen geänderten Zugang (`ACCESS-TENANT-RLS-001`).
- **[Scope]** Vollmacht-Signaturcodes werden beim Schreiben erneut an den
  aktuellen Link und die aktuelle Challenge gebunden. Ersetzte Codes und
  verzögerte Fehlversuche wirken nicht auf einen neuen Signaturvorgang
  (`POA-SIGNING-CONFIRMATION-001`).
- **[Scope]** Rechercheversand maskiert auch Normanker und Governance-Typ.
  Alle Freitextfelder teilen einen Platzhalternamensraum; nachträglich
  ergänzte Angaben überschreiben keine Zuordnungen aus der Vorschau.
  Rückzuordnung ersetzt Originalwerte genau einmal
  (`RISK-EXTERNAL-ANONYMIZATION-001`).
- **[Scope]** Dokument-ZIPs vermeiden auch Datei-/Verzeichnis-Kollisionen
  einschließlich benötigter Elternpfade (`FK-EXC-20260907-001`).
- **[Scope]** Portal-Profilwechsel bewahren die ursprüngliche Kontaktidentität
  und den Anmeldezeitpunkt. Widerruf, Abmeldung, geänderte Mailboxidentität und
  gesperrte Ursprungskontakte werden auch nach einem Wechsel geprüft.
  Portalnutzer müssen sich nach diesem Update einmal neu anmelden
  (`ACCESS-TENANT-RLS-001`).
- **[Scope]** Redis-Sitzungswiderrufe können durch verspätete Schreibvorgänge
  nicht zurückgesetzt werden; ungültige Widerrufsdaten sperren den Zugriff.
  Kontakt-E-Mail-Änderung, Deaktivierung und Reaktivierung durch Einladung
  entwerten bestehende Kalenderlinks (`ACCESS-TENANT-RLS-001`).
- **[Scope]** Dokument-ZIPs vergeben auch bei vorhandenen Suffixnamen,
  Groß-/Kleinschreibung und Unicode-Normalisierung eindeutige Eintragsnamen,
  damit Dateien beim Entpacken nicht kollidieren (`FK-EXC-20260906-003`).
- **[Scope]** Gemeinsame HTTP-Abrufe lesen Antwortdaten nach Bedarf und reichen
  Abbruch und Zeitlimit an den Netzwerkstrom weiter. Die bestehende
  4-KiB-Grenze für Update-Signaturen greift schon beim Empfang der Bytes
  (`AUDIT-RFC3161-ANCHOR-001`, `ASSURANCE-RELEASE-EVIDENCE-001`).
- **[Scope]** Staff-Recovery-Codes lassen sich vollständig im regulären
  Loginfeld eingeben. Browser-Formatprüfung und Längenlimit akzeptieren die
  zehnstelligen Codes; Passwortprüfung und serverseitiger Einmalverbrauch
  bleiben unverändert (`ACCESS-TENANT-RLS-001`).
- **[Scope]** Direkte Staff-Testanmeldung und Portal-Magic-Link setzen jetzt den
  ursprünglichen Anmeldezeitpunkt im Sitzungscookie, damit neue Sitzungen die
  Widerrufsprüfung bestehen (`ACCESS-TENANT-RLS-001`).
- Kontrast des Hinweises „Einrichtung offen“ in der Benutzerverwaltung erhöht.
- Web-Dockerbuild: Node-Heap für die TypeScript-Prüfung von 2 auf 4 GiB
  erhöht. Lokale Operator-Builds erhalten 6 GiB Gesamtspeicher und verlangen
  zusätzlich 1 GiB freie Systemreserve; cgroup-Limit und Swap-Sperre bleiben aktiv.
- Secret-Scan-Fehlalarm für die öffentlich publizierte EU-Sanktionslisten-URL
  behoben. Die Ausnahme gilt nur für die vollständige, verifizierte Quellzeile
  in ihrer konkreten Datei. Acht Scanner-Regressionstests prüfen die Ausnahmen
  einschließlich anderer Token, zusätzlicher Schlüssel und abweichender Pfade;
  der amtliche Metadaten-Nachweis ist in `.gitleaks.toml` verlinkt.
- **[Scope]** Sitzungswiderruf vor der Cookie-Erneuerung und unveränderlicher
  Anmeldezeitpunkt; bestehende Staff-/Portal-Sitzungen müssen sich nach dem
  Update einmalig neu anmelden. Kalenderabonnements prüfen das Mandatsende
  (`ACCESS-TENANT-RLS-001`, `CLIENT-MANDATE-LIFECYCLE-001`).
- **[Scope]** Storno-XRechnungen verwenden Typ 384 mit Vorgängerreferenz;
  StBVV-Übernahmen erzeugen archivierbare XRechnungsentwürfe und reparieren eng
  begrenzt bisherige dokumentlose PDF-Entwürfe. Gebührenbeschreibungen werden
  vollständig im PDF umbrochen; Leistungsdaten aus Zeiterfassung verwenden
  Europe/Berlin (`INV-STORNO-REFERENCE-001`, `STBVV-CALCULATION-001`,
  `INV-TIME-ENTRY-CLAIM-001`).
- **[Scope]** IMAP-Anhänge über dem Ressourcenlimit blockieren die einzelne
  Nachricht statt den gesamten Import. Wiederholte Speicherlöschfehler
  verdrängen keine späteren Orphans mehr (`MAIL-INBOX-001`,
  `DOC-UPLOAD-JOURNAL-001`, `DSGVO-OPERATIONAL-RETENTION-001`).
- Workflow-Abschluss aus manuellen, automatischen und Datenbank-Schritten wird
  atomar abgeleitet; pausierte und abgebrochene Vorgänge bleiben geschützt.
  Feedback wird dauerhaft vorgemerkt und einmalig verarbeitet
  (`WORKFLOW-LIFECYCLE-001`, `CLIENT-FEEDBACK-001`).
- React-Zustands-/Effektwarnungen und Formatfehler bereinigt; komplexe Rechnungs-,
  BWA-, Workflow- und UI-Funktionen in kleinere Einheiten aufgeteilt.

- Die Profilüberschrift bricht bei schmalen Fenstern und vergrößerter Schrift
  auch mit breiteren Systemschriften um, ohne den Hauptinhalt seitlich
  hinauszuschieben.
- Die E2E-Tests für Suche, aktive Navigation, Kalender-/Workflowdialoge und
  Wissensartikel verwenden die aktuellen benannten Bedienelemente. Sie prüfen
  weiterhin Navigation, Speicherung und Artikelinhalt. Der Dashboard-Axe-Test
  beginnt nach einem Größenwechsel an einer definierten Scrollposition, damit
  die feste Kopfzeile keine zufällig angeschnittenen Schaltflächen als zu klein
  erscheinen lässt; Prüfregeln und Tastaturprüfungen bleiben erhalten.
- Der Mandantenfilter der Workflow-Übersicht besitzt auch nach dem Anlegen
  erster Workflows eine zugängliche Beschriftung.
- Der Initialfokus der mobilen Navigation wartet bei einer animierten
  Sichtbarkeitsänderung auf das tatsächlich sichtbare Menü. Im persönlichen
  Anzeigemodus konnte der erste Fokusversuch sonst zu früh stattfinden.
  Listener werden nach Erfolg oder Schließen entfernt; ein späterer Fokus
  wird nicht erneut übernommen.
- Suchtreffer bleiben bei Pfeil-/Home-/End-Navigation im eigenen Panel sichtbar.
  Suche und Benachrichtigungsdialog passen sich an niedrige und schmale
  Fenster an. Benachrichtigungen haben einen benannten Dialog, explizites
  Schließen, Fokus-Rückgabe und Tab-Ausstieg; im persönlichen Modus werden
  Titel, Text und Zeitangaben vollständig beziehungsweise größer dargestellt.
  Toasts verschwinden dort nicht automatisch. In der Standardansicht pausiert
  ihre Lesezeit bei Hover, Tastaturfokus oder geöffnetem Benachrichtigungsfeed.
- **[Scope]** Eine zusätzliche Forward-Migration erhält den write-only
  Portal-Benachrichtigungsschutz aus `main`, nachdem die ältere
  Sicherheits-Reparaturmigration des UI-Branches ausgeführt wurde. Bereits
  angewendete Migrationen bleiben unverändert. Der Nachweis nach
  `ACCESS-NOTIFICATION-RECIPIENT-001` umfasst die Reihenfolge sowie einen
  zurückgerollten Datenbank-Replay; die fachliche Freigabe bleibt offen.
- Der Konto-Avatar bleibt im persönlichen barrierearmen Anzeigemodus innerhalb
  seiner vergrößerten Klickfläche mittig. Konto- und gemeinsame Aktionsmenüs
  bleiben dort auch bei geringer Bildschirmhöhe scrollbar erreichbar und
  lassen längere Einträge umbrechen. Die gemeinsamen Menüs verstecken den
  fokussierbaren Hintergrund nicht mehr nur per `aria-hidden`; Tab und
  Umschalt+Tab verlassen sie auch in der normalen Ansicht sauber.
- Dashboard-Zähler berücksichtigen neben der OS-Bewegungsreduktion auch den
  persönlichen Anzeigemodus: Der Endwert erscheint ohne Hochzählanimation.
  Laufende Zähler werden bei Aktivierung des Modus oder der OS-Präferenz
  beendet; ausstehende Frames und Listener werden aufgeräumt.
- Bei einer ausdrücklich verknüpften GwG-Doppelrolle bleiben die vollständigen
  allgemeinen Personendaten und ein bereits dem wirtschaftlich Berechtigten
  zugeordneter Ausweis nun auch für die gesetzliche Vertretung sichtbar und
  freigabewirksam. Neue Rollenverknüpfungen und spätere Personenkorrekturen
  synchronisieren sämtliche allgemeinen Angaben statt nur des Namens. Die
  Zuordnung erfolgt weiterhin ausschließlich über stabile IDs, nicht über
  Namensgleichheit. Betroffen sind `GWG-BENEFICIAL-OWNERS-001`,
  `GWG-IDENTIFICATION-EVIDENCE-001` und
  `GWG-REPRESENTATIVE-AUTHORITY-001`.
- Vollständige, gültige Ausweissätze können in der GwG-Personenansicht nun
  direkt über „Als geprüft markieren“ bestätigt werden. Nach der Bestätigung
  aktualisieren sich Ausweisstatus, Prüfhinweise und Freigabegate automatisch;
  der Umweg über „Bearbeiten“ und ein manueller Seitenreload entfallen.
- Veraltete Formulare für allgemeine GwG-Personenangaben verlangen keinen
  manuellen Seitenreload mehr. Der aktuelle Serverstand wird automatisch
  nachgeladen, mit unberührten Feldern zusammengeführt und lokale Eingaben
  bleiben zur Prüfung und zum erneuten Speichern erhalten. Betroffen sind
  `GWG-BENEFICIAL-OWNERS-001`, `GWG-REPRESENTATIVE-AUTHORITY-001` und
  `GWG-IDENTIFICATION-EVIDENCE-001`.
- Die Jobs-Übersicht leitet ihre Überwachungsfenster jetzt aus den tatsächlichen
  Scheduler-Plänen ab. Auch sehr häufige, nächtlich pausierende sowie monatliche
  Queues werden ohne falsche Stale-Alarme überwacht; erfolgreiche und
  fehlgeschlagene Diagnosedaten bleiben dafür bis zu 60 Tage begrenzt erhalten.
- „Abmelden“ im Konto-Menü der oberen Leiste sendet den Logout-POST jetzt
  zuverlässig über ein dauerhaft gemountetes Formular. Das Schließen des
  Dropdowns kann den Submit nicht mehr vorzeitig abbrechen.
- Wissensanhänge lassen sich nach dem Datenmodellwechsel wieder hochladen. Der
  Dev-Stack lädt dazu den neu generierten Prisma-Client; verständliche
  Fehlermeldungen ersetzen interne Upload-Fehlercodes.
- Ein abgelaufener oder anderweitig nicht mehr gültiger Ausweis wird nicht
  länger als fehlend bezeichnet. Neu erfasste, gültige Ausweise und aktuelle
  Registerauszüge werden nicht mehr irrtümlich sofort unter den alten
  Nachweisen einsortiert; mehrere gleichzeitige aktuelle Ausweise derselben
  Person werden verhindert.
- Beim Aufklappen eines Handelsregisterauszugs bleibt ein daneben angeordneter,
  vorhandener Transparenzregisterauszug nicht mehr scheinbar leer. Offene
  Uploadformulare und die redundante Auswahl des Nachweistyps in jedem
  Registerbereich wurden entfernt.
- **[Scope]** Der Portal-Logout akzeptiert nach einem Magic-Link-Login den von
  Chromium unter `Referrer-Policy: no-referrer` gesendeten opaken
  `Origin: null` ausschließlich zusammen mit browsergesetztem
  `Sec-Fetch-Site: same-origin`. Cross-Site- und headerlose Requests bleiben
  gesperrt; der reale Logout-E2E-Fall prüft zusätzlich den 303-Redirect und
  die Cookie-Löschung (`0c1f8174`).

### Sicherheit

- Der GwG-Einladungslink liegt bis zur Zustellung nur verschlüsselt im
  Versandauftrag und wird danach gelöscht; `pnpm secret-box:rewrap` erfasst
  den neuen Ablageort.
- Server-Actions ordnen Fehler zentral nach Fehlerklasse bzw. SQLSTATE ein;
  fachliche Meldungen (z. B. GwG-Schranke, Virenscan, nicht gefundene
  Datensätze) erscheinen statt „Unerwarteter Fehler“, rohe Datenbank- und
  Systemmeldungen erreichen die Oberfläche nicht mehr, auch nicht im
  anonymen GwG-Onboarding (`GWG-ACTIVATION-GATE-001`,
  `GWG-SELF-ONBOARDING-001`, `FK-EXC-20261006-012`).
- Dokument-Download und -Vorschau prüfen Größe und SHA-256 der gebundenen
  Fassung beim Ausliefern; abweichende Bytes werden nicht mehr vollständig
  ausgeliefert. Postfach-Anhänge und Bescheid-Dokumente prüfen zusätzlich die
  angekündigte Größe (`DOC-VERSION-IMMUTABILITY-001`, `FK-EXC-20261006-002`).
- Der GwG-Fristjob widerruft Portal-Sitzungen wie das Web monoton und
  fail-closed; ein nicht bestätigter Widerruf lässt den Lauf fehlschlagen.
  Löschfristen, `pg_restore`-Argumente und Backup-Lauf haben je eine
  gemeinsame Implementierung für Web und Worker
  (`GWG-RETENTION-DESTRUCTION-001`, `BACKUP-DRILL-INTEGRITY-001`,
  `FK-EXC-20261006-001`).
- n8n: Ein nicht entschlüsselbares Legacy-Signaturgeheimnis fällt im Worker
  nicht mehr auf Klartext oder Umgebungsvariablen zurück; der Worker meldet
  nur den Feldnamen.
- Portal-Startseite: An persönliche Bescheid- oder Feedback-Rückfragen
  gebundene Anforderungen erscheinen wie unter „Anforderungen“ nicht mehr als
  allgemeine Anforderung, sodass andere Kontakte desselben Mandats Titel und
  Anzahl nicht mehr sehen; der angefragte Kontakt sieht seine offene
  Rückfrage als eigenes To-do. Formulare mit geschlossener Anforderung zählen
  wie in der Formularliste nicht mehr als offen (`REQ-LIFECYCLE-001`,
  `TAX-NOTICE-DECISION-001`, `FK-EXC-20261005-044`).
- Abhängigkeiten: Selbst gehostetes Renovate (`renovate.json`,
  `.forgejo/workflows/renovate.yml`) ersetzt die wirkungslose
  Dependabot-Konfiguration (npm mit 7 Tagen Mindestalter, Image-Digests,
  Action-SHAs); aktiv erst mit Bot-Konto, Secret `RENOVATE_TOKEN` und Variable
  `RENOVATE_ENABLED`. Das Alpine-Hilfsimage für Volume-Backups ist auf 3.24
  digest-gepinnt (3.20 ohne Sicherheitsupdates) und wird nirgends mehr
  ungepinnt verwendet (`FK-EXC-20261005-043`).
- CI/Container: exakte Node-Version 24.19.0 in `.nvmrc` für alle Workflows;
  Web- und Worker-Image auf derselben digest-gepinnten Basis
  (`NODE_BASE_IMAGE`, Alpine 3.23), pnpm aus `packageManager`. CI und Images
  installieren mit den in `allowBuilds` geprüften Install-Skripten statt
  `--ignore-scripts` plus handgepflegter Rebuild-Listen, denen
  `msgpackr-extract` fehlte (`FK-EXC-20261005-041`).
- Die Staff-Passwortprüfung (bcrypt, Kostenfaktor 12) läuft in einem
  begrenzten Worker-Thread-Pool statt im Haupt-Thread des Web-Prozesses; viele
  gleichzeitige Anmeldeversuche blockieren damit nicht mehr alle anderen
  Anfragen. Bei voller Warteschlange endet ein Versuch sofort mit der üblichen
  allgemeinen Meldung, ohne Fehlversuch zu zählen (`FK-EXC-20261005-034`).
- Die für die PDF-Erzeugung eingebetteten Noto-Schriften (18 MB) liegen nicht
  mehr im öffentlichen Verzeichnis der Web-App; `/fonts/noto/*` war bisher ohne
  Sitzung abrufbar. Prüfskript und Web-Image sichern Ablage und Prüfsummen im
  Produktionspaket (`INV-ARCHIVE-EINVOICE-001`, `RISK-ARCHIVE-SNAPSHOT-001`,
  `FK-EXC-20261005-032`).
- Gespeicherte Geheimnisse (SMTP-Passwort, Quantenlos-Token, n8n-Schlüssel,
  Postfach-Zugangsdaten, OAuth-State) sind per AAD an Kanzlei, Ablageort und
  Feld gebunden und tragen eine Schlüssel-ID (Format v3); ein in der Datenbank
  kopierter Wert lässt sich nicht mehr entschlüsseln. `SECRET_BOX_KEYRING`
  ermöglicht eine Schlüsselrotation ohne Ausfall, `pnpm secret-box:rewrap`
  verschlüsselt Bestandswerte neu (`MAIL-INBOX-001`, `AUDIT-HASH-CHAIN-001`,
  `FK-EXC-20261005-031`).
- Der verzögerte Auftrag „Wiedervorlage erledigt“ legt in der Warteschlange
  nur noch Kennungen statt Betreff und Namen ab; erledigte und fehlgeschlagene
  Aufträge werden nach 24 Stunden beziehungsweise 7 Tagen entfernt
  (`REMINDER-TICKET-001`, `FK-EXC-20261005-024`).
- Alle Hintergrundbenachrichtigungen des Workers laufen über einen gemeinsamen
  Pfad mit Textbereinigung, auch die bisher unbereinigten Titel externer
  RSS-Feeds. Eine Kettenbruch-Meldung zu einer neuen Bruchstelle bricht den
  Prüflauf nicht mehr ab (`ACCESS-NOTIFICATION-RECIPIENT-001`,
  `AUDIT-VERIFY-ALERT-001`, `FK-EXC-20261005-022`).
- **[Scope]** Sitzungen im Kanzlei- und Mandantenportal enden spätestens
  24 Stunden nach der ursprünglichen Anmeldung. Bisher verlängerte jeder
  Aufruf des Auth.js-Session-Endpunkts eine Sitzung ohne Obergrenze um volle
  24 Stunden, sodass ein entwendetes Cookie unbegrenzt gültig bleiben konnte;
  auch ein Portal-Profilwechsel verlängert nicht mehr
  (`ACCESS-TENANT-RLS-001`, `FK-EXC-20261005-015`).
- **[Scope]** Die Mitarbeiteranmeldung verrät weder über die Meldung noch über
  die Antwortzeit, ob eine Kanzlei oder ein Konto existiert, deaktiviert,
  gesperrt oder auf Hardware-Schlüssel umgestellt ist; bisher kehrten diese
  Fälle vor dem Passwortvergleich zurück (`ACCESS-TENANT-RLS-001`,
  `FK-EXC-20261005-013`).
- **[Scope]** Session-Cookies von Kanzlei und Mandantenportal werden nur noch
  über eine Session-Fabrik je Oberfläche gelesen, ausgestellt und gelöscht; in
  Produktion akzeptiert der Server ausschließlich den konfigurierten
  `__Host-`/`__Secure-`-Namen. Der ungenutzte zweite Portal-Login über
  `/api/auth/portal/callback/credentials`, der einen Magic-Link verbrauchen und
  eine Portal-Sitzung ausstellen konnte, ist entfernt; die wirkungslose Angabe
  `updateAge` entfällt (`ACCESS-TENANT-RLS-001`, `FK-EXC-20261005-012`).
- KI-Aufträge der Subsumtion enthalten keinen Sachverhalt mehr, nur Analyse-ID
  und Hash; der Worker liest den Text aus der Datenbank. Erledigte Aufträge
  werden nach 24 Stunden, fehlgeschlagene nach 7 Tagen aus Redis entfernt;
  bisher lagen die letzten 300 Aufträge unbefristet und unverschlüsselt auf
  der Platte. Altaufträge werden beim Worker-Start bereinigt
  (`RISK-AI-SUGGESTION-001`, `FK-EXC-20261005-002`).
- Der Startdialog der Workflow-Vorlagen zeigt nur noch Mandanten, die der
  Mitarbeitende sehen darf; bisher listete er alle Mandanten der Kanzlei
  einschließlich vertraulicher (`ACCESS-CLIENT-MODE-001`).
- **[Scope]** Ohne vertrauenswürdige Client-IP (Standard bei eigenem
  Reverse-Proxy, `TRUST_PROXY_REQUIRED=false`) fallen Login-Limits nicht mehr
  auf kleine globale Zähler zurück, mit denen eine Anfrage alle neun Sekunden
  sämtliche Portal-Logins blockierte. Magic-Link-Anforderungen werden
  zusätzlich pro E-Mail-Adresse (HMAC) begrenzt, Staff-Logins weiterhin pro
  Konto; global greift nur noch eine großzügige Sturm-Obergrenze.
  Fehlversuche ohne Client-IP sperren Staff-Konten nicht mehr 30 Minuten. Mit
  `TRUST_PROXY_REQUIRED=true` stammt die Client-IP vom rechten Ende von
  `X-Forwarded-For` statt aus dem vom Client setzbaren linken Eintrag;
  `X-Real-IP` und `CF-Connecting-IP` werden nicht mehr ausgewertet. Neue
  Variable `TRUST_PROXY_HOPS` (Standard 1); `./taxtronik doctor` warnt bei
  `TRUST_PROXY_REQUIRED=false` (`ACCESS-TENANT-RLS-001`, `FK-EXC-20261004-013`).
- **[Scope]** Alle Mandanten-Detailseiten unter `/staff/clients/[id]` prüfen
  den Mandantenzugriff (Vertraulichkeit, RESTRICTED-Modus) jetzt selbst über
  einen request-gecachten Seiten-Guard statt nur im Segment-Layout. Für 16
  Seiten, darunter GwG, Bescheide, Zeitstrahl, BWA, Datenschutz und
  Workflows, prüfte bisher nur das Layout, das bei Navigation zwischen
  Unterseiten und bei gezielten RSC-Requests nicht erneut läuft. Ein
  Strukturtest erzwingt den Guard vor jedem Datenzugriff jeder Seite
  (`ACCESS-CLIENT-MODE-001`, `FK-EXC-20261004-011`).
- **[Scope]** Die Restore-Sicherheitsabnahme und der CI-Restore-Selbsttest
  prüfen zusätzlich, dass die Anwendung Rolling-Anker weder ändern, löschen
  noch leeren, Prüf-Checkpoints der Kettenprüfung weder anlegen, ändern,
  löschen noch leeren und die Anker-Lease-Tabelle gar nicht nutzen darf
  (30 statt 22 Invarianten). Dumps vor Migration `20261004140000` werden
  abgewiesen (`ACCESS-TENANT-RLS-001`, `AUDIT-HASH-CHAIN-001`).
- **[Scope]** Prüf-Checkpoints der Audit-Kettenprüfung liegen in der neuen
  Tabelle `audit_verify_checkpoint`, die die Anwendung nur lesen darf, und
  tragen eine HMAC-Prüfsumme mit eigenem, aus dem Secret-Box-Schlüssel
  abgeleiteten Schlüssel. Ein fehlender, verfälschter oder durch einen
  älteren Stand ersetzter Checkpoint gilt als Manipulationsverdacht und
  erzwingt eine Neuprüfung ab Genesis. Eine Vollprüfung ohne Fortschritt über
  drei Tage meldet „Vollprüfung stockt“ und beginnt neu; läuft keine, meldet
  jeder Lauf nach 21 Tagen ohne abgeschlossene Vollprüfung „Vollprüfung
  überfällig“. Siegel- und Ankerbefunde halten die Prüfung nicht mehr an,
  sondern werden bei jedem Lauf erneut gemeldet (`AUDIT-VERIFY-ALERT-001`).
- **[Scope]** Eigenes kontogebundenes TOTP-/Backup-Code-Budget verhindert
  Umgehungen durch reine Passwortprüfungen und wechselnde IPs. Magic-Link-
  Vorschau und Bestätigung werden an den tatsächlichen Einstiegspunkten
  begrenzt. Persönliche RSS-Aktionen prüfen den Eigentümer; gespeicherte
  Filter werden nach Tenant und Mitarbeiter getrennt
  (`ACCESS-TENANT-RLS-001`, `ACCESS-SEARCH-SCOPE-001`).
- **[Scope]** Dokumentleser verwenden die gespeicherte S3-Version auch für
  Vollmachten, Rechnungen, Vorschauen, Sammeldownloads und Inbox-Anlagen.
  Alternative Downloadwege verlangen den aktuellen Scanabschluss
  (`DOC-VERSION-IMMUTABILITY-001`, `DOC-PORTAL-SHARING-001`,
  `POA-SIGNING-SNAPSHOT-001`, `INV-ARCHIVE-EINVOICE-001`).
- **[Scope]** Automatische Restore-Drills prüfen eine private, exklusive
  Laufkopie vollständig gegen BackupRecord-Hash und -Größe, bevor PostgreSQL
  Dumpanweisungen ausführt. Restore-CLI-Downloads verwenden ebenfalls private
  Dateien mit Fehler-Cleanup. Neue ungeprüfte Produktregel
  `BACKUP-DRILL-INTEGRITY-001`; keine fachliche Freigabe.
- **[Scope]** Auditrotation prüft Ketten und vorhandene Recovery-Objekte vor
  Wiederaufnahme. TSA- und n8n-Fehlerantworten werden beendet beziehungsweise
  begrenzt gelesen (`AUDIT-ARCHIVE-001`, `AUDIT-RFC3161-ANCHOR-001`).
- Technische Befunde, Nachweise und Grenzen der repositoryweiten Prüfung
  sind im [Prüfbericht](docs/reviews/2026-10-01-vollpruefung.md) dokumentiert.

- Dependency Audit 3673: Nodemailer auf `10.0.10`, Undici auf `8.10.2`,
  fast-uri auf `3.1.8`, ip-address auf `10.7.1` und die beiden benötigten
  brace-expansion-Zweige auf `1.1.21` beziehungsweise `5.0.12` aktualisiert.
  Exakte Overrides schließen auch die transitiven verwundbaren Kopien.
  Next.js und sein ESLint-Plugin erhalten zusätzlich `16.3.6` gegen den beim
  erneuten Audit gemeldeten kritischen Befund `GHSA-vcvr-r3jv-pc5j`.
  Ein echter Nodemailer-/Mailparser-Roundtrip prüft MIME-Kompatibilität und
  den korrigierten Empfängerparser. Hook-Prüfung und technische Nachweise:
  [Dependency-Audit 3673](docs/reviews/2026-09-30-dependency-audit-3673.md).

- **[Scope]** Die Mandantenauswahl bei neuer Rechnung und externem
  Rechnungsupload berücksichtigt jetzt bereits beim Laden den zentralen
  Mandantenzugriff. Rechnungsrechte allein zeigen damit keine vertraulichen
  oder im eingeschränkten Zugriffsmodus unzugeordneten Mandanten mehr an.
  Die bestehenden Schreibprüfungen bleiben erhalten
  (`ACCESS-CLIENT-MODE-001`, `ACCESS-STAFF-PERMISSION-001`).

- Lokale QA-Artefakte unter `.codex-run` werden ausdrücklich aus dem
  Docker-Buildkontext ausgeschlossen. Der bestehende Docker-Guard und eine
  negative Regression sichern den Ausschluss auch für verschachtelte Dateien.

- Next.js und sein ESLint-Plugin auf `16.3.3`, sharp auf `0.35.4`, js-yaml auf
  `4.3.2`, Nodemailer auf `9.1.1` und Vitest samt Begleitpaketen auf `4.1.11`
  aktualisiert. Damit werden die elf Befunde aus Dependency Audit 3497
  geschlossen, einschließlich der beiden kritischen Next.js-Schwachstellen.
- Exakte Overrides sichern auch die von Mailparser eingebundene Nodemailer-Kopie
  und Next.js' Bildverarbeitung ab. baseline-browser-mapping wird einheitlich auf
  den bereits für browserslist verwendeten gepatchten Stand `2.11.4` aufgelöst.
  Alle neuen Fixstände erfüllen die siebentägige Mindestwartezeit und benötigen
  keine zusätzliche Quarantäneausnahme.
- Der Vitest-Wechsel im überwachten Tax-Paket verändert keine Screening-Regel
  (`GWG-SCREENING-001`); die technische Ausnahme ist als `FK-EXC-20260910-001`
  dokumentiert.

## [0.2.1] - 2026-08-22

### Hinzugefügt

- **[Scope]** Alle Mitarbeiterrollen können ihr Passwort im neuen
  Benutzerprofil selbst ändern. Das bisherige Passwort wird geprüft, das neue
  muss bestätigt werden und nach erfolgreicher Änderung werden alle laufenden
  Sitzungen widerrufen. Der Vorgang ist rate-limitiert und wird ohne Passwort-
  oder Hashwerte in der Audit-Kette protokolliert.
- **[Scope]** Kontozugänge folgen einer festen Rollen-Hierarchie: ADMIN können
  Passwörter und verlorene 2FA-Zuordnungen von PARTNER/EMPLOYEE zurücksetzen,
  PARTNER ausschließlich die von EMPLOYEE. ADMIN-Zugänge sind in der
  Weboberfläche vollständig vom Passwort-/2FA-Reset ausgenommen und werden nur
  über die Administrations-CLI wiederhergestellt. Dort sind ADMIN-E-Mail und
  Tenant-Slug Pflicht; ohne genau einen Treffer erfolgt keine Änderung. Der
  2FA-Reset entfernt verschlüsseltes Secret, ein möglicherweise offenes Setup,
  Enrollment und Backup-Codes gemeinsam; beide Web-Aktionen widerrufen aktive
  Sitzungen und erzeugen einen Audit-Eintrag.
- Die Benutzerverwaltung nutzt auf breiten Ansichten den verfügbaren Platz für
  eine eigene Spalte „Kontosicherheit“. Initial- und Reset-Passwörter werden
  verdeckt eingegeben und müssen wiederholt werden.

### Behoben

- **[Scope]** Eine Privilege-Escalation in der Benutzerverwaltung ist
  geschlossen: PARTNER können weder ADMIN-Zugangsdaten oder -2FA zurücksetzen
  noch ADMIN-Konten deaktivieren, ADMIN-Rollen vergeben oder bestehende
  ADMIN-Rollen verändern. Die Regeln werden serverseitig anhand der frisch
  gelesenen Zielrollen erzwungen und zusätzlich in der Oberfläche abgebildet.
- Die Abmeldung auf Staff- und Portal-Oberfläche verwendet hosttreue
  POST-Endpunkte und entfernt alle Session-Cookie-Varianten zuverlässig, ohne
  interne Docker-/Proxy-Hosts in Browser-Weiterleitungen zu übernehmen.
- Die Magic-Link-E2E-Suite isoliert ihre Rate-Limit-Schlüssel pro Test und kann
  dadurch auch im vollständigen paranoiden CI-Lauf nicht mehr durch eigene
  Vorläuferfälle gedrosselt werden.

### Enthaltener Kandidatenstand vom 21. August 2026

Der damals als `0.2.0` bezeichnete Kandidat wurde nicht eigenständig getaggt.
Die folgenden Änderungen gehören zum Release `v0.2.1`; die frühere
Themengliederung bleibt zur historischen Zuordnung erhalten.

#### Releaseabschluss

- Der Abmelden-Button im Mandantenportal verwendet jetzt einen hosttreuen
  POST-Endpunkt statt einer proxy-empfindlichen Server-Action. Der Endpunkt
  loescht alle Portal-Session-Cookie-Varianten auch bei einem Auth.js-Fehler
  und bleibt durch SameSite plus Fetch Metadata gegen Cross-Site-POSTs
  geschuetzt.
- Der interaktive Erstinstallationspfad setzt bei Registry-Releases jetzt die
  öffentliche Manifest-URL und den fest eingebauten Ed25519-Verifikationskey
  automatisch. Damit sind die über Forgejo CI veröffentlichten Images auch bei
  einem frischen 1-Klick-Deploy ohne manuelle Manifest-Nachkonfiguration
  auflösbar.
- **[Scope]** Jeder Audit-Eintrag besitzt einen eigenen, von der App-/Hostuhr
  erzeugten UTC-Ereigniszeitpunkt (`occurredAt`, PostgreSQL `timestamptz(6)`).
  Er ist im Eintrags-Hash gebunden, aber für sich allein keine extern
  vertrauenswürdige Zeitangabe.
- **[Scope]** Die Audit-Protokollierung arbeitet jetzt mit zwei gekoppelten
  Ketten: Die vollständige lokale Hash-Kette nimmt Fachereignisse sofort und
  transaktional auf; eine zweite, dünne Anchor-Kette zieht ihre Spitzenstände
  asynchron per RFC 3161 nach. Jeder externe Anchor bindet lokalen ID-Bereich,
  rekonstruierten Spitzen-Hash und den Hash des vorherigen TSA-Tokens. Der
  2-Sekunden-Worker hält dabei weder Fachtransaktionen noch den lokalen
  Audit-Lock, verarbeitet Rechnungs-/GwG-Ereignisse bevorzugt und verwirft
  Parallel-Loser ohne Anchor-Zweig. Admin-Status, automatischer Refresh,
  Backoff und Ops-Alarm machen Rückstände sichtbar. Die TSA-`genTime` belegt
  weiterhin nur: Die bis zum Anchor verketteten Daten existierten spätestens
  zu diesem Zeitpunkt; sie attestiert nicht den exakten lokalen
  Ereigniszeitpunkt. Die Tagesversiegelung bleibt als zusätzlicher
  Defense-in-Depth-Nachweis bestehen.
- Managed Signal ist Bestandteil der geführten Ein-Klick-Installation:
  Quanten-Extras werden hash-gepinnt installiert, Engine-Liveness,
  Embedding- und LLM-Bereitschaft werden getrennt ausgewiesen und Granite kann
  ohne GPU lokal auf der CPU laufen. Die Oberfläche benennt CPU-Inferenz dabei
  ausdrücklich als deutlichen Performance-Bottleneck.
- Lokale Windows-Entwicklung unterstützt Signal wahlweise auf CPU oder GPU;
  Status und Slot-Auslastung zeigen das tatsächlich aktive Backend. Updates
  überspringen unveränderte Signal-Builds und erlauben einen bewussten
  Neuaufbau.
- n8n-Routen übernehmen die öffentlich erreichbaren Produktions-/Test-URLs
  statt interner Docker-Adressen. Importierte und erkannte Routen lassen sich
  mit „Speichern“/„Verwerfen“ dauerhaft übernehmen; Aktivstatus,
  Event-Abonnements und Callback-Credentials bleiben dabei konsistent.
- GwG-Uploads lassen sich vor dem Absenden verwerfen und werden unter
  `GwG/<Name der Person>` abgelegt. Eine neue Steuernummer allein startet keine
  Wiederholungsprüfung, Bestätigungen bleiben nach erneutem Speichern der
  Stammdaten möglich und die Willkommensmail wird nur beim ersten Onboarding
  versandt.
- Quellgebundene Benachrichtigungen werden beim Abschluss des zugrunde
  liegenden Vorgangs automatisch erledigt und erscheinen bei echter neuer
  Aktivität oder Wiedereröffnung erneut. Das Lesen ist über Navbar, Dashboard
  und Liste synchronisiert.
- Die Subsumtionsschicht zeigt ausstehende Delegationen direkt an und verlinkt
  zur Wiedervorlage oder Definition. Katalogprüfung, Backend-/Slot-Anzeige und
  KI-Vertiefung wurden für CPU-/GPU-Betrieb gehärtet.
- Produktionsabhängigkeiten sind zum Release reproduzierbar gepinnt, darunter
  SeaweedFS 4.41, n8n 2.33.7 und BullMQ 5.81.3.

#### Seit dem Kandidatenstand ergänzte Änderungen

- Signal-Integration: Die Integrations-Einstellungen zeigen Zustand, Aktualität
  und letzten protokollierten Lauf des Embedding-Index. Kanzlei-Admins können
  den globalen Wochencheck ein- oder ausschalten und einen Neuaufbau manuell
  anstoßen. Getrennte Operator-Authentisierung, Audit, Offline-Festwissen,
  persistente Generationen und fail-closed Deploy-/Doctor-Prüfungen sichern
  den Betrieb ab.
- Benachrichtigungen: Das Öffnen über das Dashboard-Widget oder die
  Benachrichtigungsseite markiert den Eintrag nun wie der Navbar-Klick als
  gelesen und synchronisiert den Navbar-Zähler sofort.
- Dashboard: „Mein Tag“ bündelt jetzt zugewiesene Workflow-Schritte,
  Wiedervorlagen, anstehende Kalendertermine und weitergeleitete Telefonzettel.
  Mitarbeiter können außerdem ihre eigenen aktiven RSS-Feeds manuell
  aktualisieren; der Abruf bleibt auf den aktuellen Mandanten und Mitarbeiter
  begrenzt.
- CI und Dependency-Audit: Die n8n-Outbox-Routing-Tests sind unabhängig vom
  globalen Delivery-Modus und von Legacy-ENV-Werten. Gepatchte Pins für
  `undici`, `postcss` und beide benötigten `brace-expansion`-Zweige schließen
  die neu gemeldeten Advisories. Der Deploy-Readiness-Job verwendet eigene
  Host-Ports für SeaweedFS und ClamAV, damit parallele Jobs nicht kollidieren.
  Der Tag-Release serialisiert diese servicebasierten Forgejo-Jobs, extrahiert
  Trivy aus einem digest-gepinnten Image und scannt die noch unveröffentlichten
  Images direkt am Build-Daemon; erst danach folgen SBOM, Stack-Smoke-Test,
  Registry-Push und das signierte Update-Manifest. Der Stack-Smoke backt
  Postgres-Initialisierung, Storage-/ClamAV-Konfiguration und die gebündelten
  n8n-Workflows über gestreamte Build-Kontexte ein und nutzt Named Volumes,
  sodass er auch am äußeren Forgejo-Docker-Daemon ohne fragile
  Workspace-Bind-Mounts läuft.
- Toolchain: pnpm ist auf 11.20.0 und Prisma ORM samt Client und PostgreSQL-
  Adapter auf 7.9.1 aktualisiert. Der neue Prisma-Tooling-Graph entfernt dabei
  den verwundbaren transitiven Hono-Pfad; `fast-uri` ist im verbleibenden
  Prisma-Pfad auf den gepatchten Stand 3.1.5 angehoben.
- Steuertermine: Die Auto-Anforderung an Mandanten läuft jetzt zweistufig.
  Zuständige (HAUPTBEARBEITER, Fallback ADMIN/PARTNER) werden konfigurierbar
  viele Tage vor dem Versand intern vorgewarnt und können den Versand pro
  Termin oder als Bulk stoppen (aufhebbar) — etwa wenn der Mandant bereits in
  Papierform geliefert hat; sonst geht die Anforderung automatisch raus.
  Beim Versand erhält der Mandant nun wie beim manuellen Anlegen die
  `request-opened`-E-Mail an alle aktiven Ansprechpartner samt n8n-Event —
  vorher entstand die Auto-Anforderung still im Portal. Die Konfiguration pro
  Mandant trennt An/Aus (vormals implizit „0 Tage") von den Versand- und
  Vorwarn-Tagen; nach Ende des Fälligkeitstags wird nie mehr automatisch
  angefordert (vorher theoretisch möglich). Hinweise fürs Deploy: Bestands-
  Configs mit 0 Tagen werden auf „Aus" migriert; für offene Termine, deren
  Versandfenster bereits läuft, geht nach dem Deploy einmalig eine
  Vorwarnungs-Welle an die Zuständigen raus. Technisch dafür extrahiert:
  Mail-Stack als `@taxtronik/mail` und n8n-Outbox-Enqueue-Kern in
  `@taxtronik/n8n-shared`, damit auch der Worker mandantengerichtete Mails
  und Events versendet (Web-Pfade als Re-Exports unverändert).
- **[Scope]** Audit-Protokollierung: Ein fehlgeschlagener Lauf des
  Verifikations-Jobs setzte den Monotonie-Anker (`lastAuditId`) auf `null`
  zurück. Die Erkennung gelöschter Ketten-Spitzen (Tail-Truncation) blieb
  danach dauerhaft stumm, bis wieder ein erfolgreicher Lauf einen Anker
  schrieb. Der Fehlerpfad reicht den bisherigen Anker jetzt weiter;
  `detectTailTruncation` ist mit Tests hinterlegt.
- **[Scope]** Dokumentenarchiv: Der BWA-Import prüfte die Mandanten-Berechtigung
  erst nach dem Parsen der hochgeladenen Datei. Das Zugriffs-Gate liegt jetzt
  davor. Der XLSX-Reader entpackt außerdem nur noch die tatsächlich
  ausgewerteten Container-Teile und bricht bei überzogener deklarierter Größe
  ab, statt den Zielpuffer blind zu allokieren (Zip-Bomben-Schutz).
- Der Betriebs-Alarm meldete ausgerechnet den Ausfall nicht, für den er gebaut
  ist: Der Backup-Frische-Check war der einzige ohne Fehlerabschirmung und riss
  bei DB-Ausfall den gesamten Lauf mit — ohne Wiederholung, da 5-Minuten-Job.
  Check abgeschirmt, Aggregation auf `allSettled` umgestellt.
- Öffentliche Prüfer-Verifikation: Der IP-Bucket entstand aus einer roh
  interpolierten IP. Ohne vertrauenswürdigen Proxy-Header teilten sich alle
  anonymen Aufrufer den Schlüssel `…:null`; ein einzelner Aufrufer konnte die
  Verifikation für sämtliche externen Prüfer sperren.
- Externe Aufrufe im Wartepfad sind jetzt durchgängig gedeckelt: BullMQ-Queue-
  Operationen (Redis-Ausfall ließ Promises nie auflösen) und beide
  SMTP-Transporter (vorher Nodemailer-Default von 10 Minuten).
- Die Pinning-Guards übersahen jede Zeile mit Trailing-Kommentar und meldeten
  trotzdem „OK"; der Release-Gate-Guard prüfte `continue-on-error` nur auf
  Job-, nicht auf Schritt-Ebene. Beides geschlossen und per Gegenprobe belegt.
- Dokumentation an den Code angeglichen, wo sie mehr zusagte als er hält:
  Aufbewahrungsfrist für Handels-/Geschäftsbriefe (6 statt 10 Jahre),
  Upload-Limit (25 MiB statt 100 MB), nicht existente Pre-Commit-Hooks und ein
  behaupteter Rate-Limit-Vorabcheck im Proxy sowie vier tote UI-/Ablagepfade.
- Alle bekannten Verwundbarkeiten im Abhängigkeitsgraphen geschlossen (zuvor
  34 Befunde, davon 4 kritisch): Next auf 16.2.11, Auth.js auf 5.0.0-beta.32
  samt `@auth/core` 0.41.3, dazu gepatchte Stände für postcss, js-yaml,
  fast-uri, sharp, hono, valibot und brace-expansion. `unpdf` 1.x lässt die
  optionale `canvas`-Abhängigkeit fallen und entfernt damit
  `@mapbox/node-pre-gyp`, `tar`, `rimraf` und `glob@7` aus dem Produktivgraphen.
- **[Scope]** Dokumentenarchiv: XLSX wird ohne `exceljs` gelesen. Die Bibliothek
  hat seit 2023 kein stabiles Release mehr und zog über
  `archiver`/`unzipper`/`fstream` ein Advisory nach, das sich nicht per Override
  beheben ließ. Beide Nutzungen (DATEV-BWA-Import, Inline-Vorschau) sind reines
  Lesen und laufen jetzt über einen eigenen, testabgedeckten Reader.
- **[Scope]** Dokumentenarchiv: Die Inline-Vorschau für Tabellen greift wieder.
  Hochgeladene XLSX wurden als `application/zip` erkannt, weil OOXML-Dateien
  ZIP-Container sind; ZIP-Container werden nun über das Central Directory
  aufgelöst, ohne Inhalte zu dekomprimieren. Der gespeicherte Dokumenttyp
  steuert als eigenes Feld die Auswahl des Viewers, während die Auslieferung
  unverändert `attachment`/`octet-stream` bleibt — die Inline-Whitelist ist
  nicht aufgeweicht. Downloads tragen dadurch wieder die Endung `.xlsx`.
- Der Dependency-Audit läuft täglich statt wöchentlich und erfasst zusätzlich
  in einem nicht blockierenden Lauf den gesamten Graphen inklusive
  Dev-Abhängigkeiten; blockierend bleibt `--prod --audit-level high`.
- Lokale Deploy-/Update-Builds begrenzen jetzt den gesamten Docker-Buildschritt
  per cgroup statt nur den V8-Heap des Next-Prozesses, deaktivieren Build-Swap
  und brechen vorab ab, wenn RAM plus Systemreserve fehlen. Damit kann ein
  ausufernder Next/Turbopack-Build den Produktivhost nicht mehr bis zur
  Unerreichbarkeit ins Swapping treiben.
- n8n auf den verifizierten Stable-Release 2.33.7 aktualisiert; globale
  Legacy-Callbacks sind nun standardmäßig deaktiviert und Production-n8n
  sendet keine Telemetrie oder automatischen Katalog-/Versionsabrufe.
- Update-/Migrationspfad gegen restriktive Checkout-Dateirechte gehärtet:
  Git-Updates normalisieren neue Quelldateien, Runtime-Images garantieren
  lesbare non-root-Migrationsskripte und CI simuliert den zuvor fehlschlagenden
  `0600`/`0700`-Operator-Checkout. Der Legacy-Pending-Vertrag kann nach einer
  nachweislich vollständig abgeschlossenen manuellen Prisma-Recovery sicher
  auf den nächsten Vorwärts-Commit fortgesetzt werden.
- Mandanten-Onboarding erhält einen expliziten, auditierbaren Abschlussmarker;
  bereits abgeschlossene Altbestände werden ehrlich zum Migrationszeitpunkt
  markiert und spätere Wiederholungsprüfungen öffnen das Erst-Onboarding nicht
  erneut.
- GwG-Prüfung als zusammenhängender Vier-Augen-Workflow ausgebaut: Mitarbeitende
  bearbeiten einen Entwurf und reichen ihn gezielt beim zugeordneten
  Berufsträger ein; Entscheidungen sind gegen parallele/stale Prüfsnapshots
  geschützt. Wirtschaftlich Berechtigte einschließlich PEP-Angabe sind
  vollständig korrigierbar, Rechtsträgernachweise werden direkt in Abschnitt 2
  hochgeladen und nicht registerpflichtige GbR erhalten passende
  Gründungsnachweise ohne sachfremde Ausweisfelder.
- Anforderungen lassen sich direkt aus Mandantenakte und Anforderungsübersicht
  in einem Dialog anlegen. Serverseitige Idempotenz, Payload-Bindung,
  Zugriffs-/GwG-Gates und konsistente Template-/Formular-Caps verhindern
  Doppelerfassung und versteckte Vorlagenabweichungen.
- Datenschutz-Einwilligungen sind kanzleispezifisch konfigurierbar: Standard-
  Optionen wie Fax/Newsletter lassen sich deaktivieren, eigene Checkboxen
  ergänzen und mit Dienstleistern samt eingefrorenem Datenzugriffs- und
  AVV-/Vertragszeitraum verknüpfen. Ein beschädigter Katalog bleibt in der
  Erfassung fail-closed und besitzt einen expliziten ACP-Reparaturpfad.
- Kalenderansichten verwenden beidseitig denselben Schalter für
  Kanzleikalender/Steuertermine. Die Integrationsübersicht erkennt alte
  `localhost`-/Loopback-n8n-Vorgaben als geführten Migrationszustand statt als
  irreführenden SSRF-Fehler.

#### Betrieb, Deployment und Dokumentation

- n8n-Integration: geführte Einrichtung trennt Instanz-UI, Management-API,
  Legacy-Webhook-Präfix und exakte Production-Webhook-URLs. Verwaltete und
  eigene Workflows erhalten explizite Event-Abonnements, unabhängigen Fan-out,
  einen fail-closed Ablauf aus Entwurf, synthetischem Test und unveränderter
  Aktivierung sowie eine bewusste Deaktivierungsoption; selektiver
  Vorlagenimport materialisiert die separat aus n8n erreichbare App-Basis und
  weitere Nicht-Geheimnisse Community-kompatibel,
  während Bearer-, HMAC- und SMTP-Secrets n8n-Credentials bleiben
- n8n-Zustellung: versionierter Envelope mit stabiler `eventId` und
  zielbezogener `deliveryId`, Status je Zustellung sowie
  `PARTIAL`/`UNROUTED`-Aggregat machen Retry, Deduplizierung und Fehlerbilder
  nachvollziehbar; Legacy-Routing bleibt als Übergangspfad erhalten
- n8n-Dokumentation: neues Anwenderkapitel mit vollständigem Eventkatalog,
  eigenen Workflows, Publish-/Test-URL-Erklärung, §-203-/DSGVO-Hinweisen und
  Troubleshooting; Day-2-, Subdomain- und Secret-Rotation-Runbooks wurden um
  API-Key-/Callback-Credential- und Multi-Workflow-Betrieb ergänzt
- n8n-Legacy-Sicherheit: `expiring-gwg-checks` akzeptiert keinen globalen
  Cross-Tenant-Abruf mehr; bestehende Legacy-Aufrufer müssen `tenantId`
  mitsignieren oder auf den tenantgebundenen v1-Callback wechseln
- Release-Gate: Die final geladenen Web-/Worker-Images werden vor jedem Push
  als vollständiger Compose-Stack inklusive Migration, Readiness,
  Worker-Heartbeat, Image-ID und OCI-Commit-Label gestartet und geprüft
- Rollback-Härtung: Ein atomarer Migrations-Pending-Marker und der persistierte
  DB-Kompatibilitätsstatus verhindern, dass alter Code nach einer möglichen
  Vorwärtsmigration startet; Legacy-/Probe-Fehler gelten fail-closed als
  `unknown`
- Restore-Härtung: mutierende Restores verlangen ein explizites Ziel;
  Produktionsrestores brauchen starke Bestätigung plus passende
  `--release-version`, stoppen alle Writer und autorisieren nur diesen einen
  signierten Release-Vertrag für den Wiederanlauf
- Container: Node-Basisimages sind per Digest gepinnt, native Rebuild-Fehler
  nicht mehr unterdrückt, der Standalone-Server bindet healthcheck-erreichbar
  auf alle Container-Interfaces und Docker-Liveness ist von
  Dependency-Readiness getrennt; ungenutzte npm/Corepack/Yarn-Werkzeuge sind
  aus den Runtime-Images entfernt
- Toolchain/Qualität: Node 24 LTS ist durchgängig, der Root-Lint erfasst das gesamte
  Repository, CI erzwingt eine einmalig bereinigte Prettier-Baseline und binäre
  TSA-Fixtures sind vor Zeilenende-Konvertierung geschützt
- Distribution: SPDX-Lizenzmetadatum ergänzt und Release-Version auf `0.2.0`
  angehoben; die finalen Web-/Worker-Images erhalten vor der Veröffentlichung
  archivierte CycloneDX-SBOMs
- Deployment: lokale `./taxtronik deploy`-/`update`-Builds räumen nach
  erfolgreichem Build ungenutzten Docker-BuildKit-Cache auf
  (`TAXTRONIK_BUILD_CACHE_PRUNE_UNTIL`, Default 168h), damit Server nicht
  durch alten Build-Cache volllaufen
- Deployment: Mailhog ist nur noch Dev-Komponente; der Prod-Compose-Stack
  verlangt ein echtes SMTP-Relay (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`) und
  `./taxtronik doctor` blockt `mailhog` sowie `localhost:1025`/`127.0.0.1:1025`
- Deployment: Production-Provisionierung ohne Demodaten -
  `pnpm --filter @taxtronik/db provision` legt Tenant, Default-Dokumenttypen
  und ein Admin-Konto an; der Dev-Seed verweigert in Produktion weiterhin,
  Doppel-Provisionierung wird erkannt und abgebrochen
- Release/Deployment: annotierte SemVer-Tags durchlaufen CI und Security im
  selben Promotion-DAG; Web und Worker werden erst danach gebaut, gescannt und
  als write-once Versions-Tags publiziert. Das Ed25519-signierte Manifest bindet
  Tag-Commit und beide Image-Digests; die Operator-CLI deployt
  `image:tag@sha256:…` und verwaltet einen vollständigen Last-Good-Vertrag für
  Rollbacks
- Release/Deployment: Pending-Verträge bleiben bis zum bestandenen Health- und
  Readiness-Gate ausschließlich im Prozess; `.env` und `.taxtronik.state`
  verankern erst danach den Last-Good-Stand. Rollback erkennt abgebrochene
  Updates, stellt dann `state.current` wieder her und wechselt Checkout, Web-
  sowie Worker-Artefakt gemeinsam
- Secret-Härtung: SeaweedFS rendert seine S3-Konfiguration erst beim
  Containerstart in ein flüchtiges tmpfs (`0400`, UID 1000); historische
  hostseitige `seaweedfs-s3.generated.json`-Kopien werden entfernt
- Toolchain: pnpm-Pin auf 11.8.0 angehoben (Root `packageManager` und
  Docker-Builds)
- Ops-Doku: README, FEATURES, Release-Doku, nginx-Beispiel und n8n-Workflow-Doku
  beschreiben getrennte Staff-/Mandantenportal-Setups, n8n-Proxy-Varianten,
  Risk-Layer-Anbindung und Produktions-SMTP
- Doku-Hygiene: lokale persönliche Plan-/Handoff-Pfade aus Architektur-,
  Handoff- und Entwicklungsdoku entfernt bzw. neutralisiert
- Windows: irreführender Root-Shortcut `start.cmd` entfernt; der verbleibende
  PowerShell-Helfer ist als lokaler Container-Dev-Helfer gekennzeichnet
- Qualitätssicherung: `pnpm test:ops` ergänzt Operator-CLI-Regressionen für
  `doctor`, Prod-SMTP/Mailhog-Gates, Risk-Layer-Konfiguration und
  Build-Cache-Prune; CI archiviert `testbericht-ops`
- Security-Nachweise: `security.yml` archiviert Dependency-Audit- und
  Gitleaks-Logs als prüfbare Artefakte
- Supply-Chain-Schutz: pnpm blockt frische npm-Releases sieben Tage,
  prüft Lockfile-Trust erneut und CI/Release erzwingen einen Guard gegen
  exotische Paketquellen sowie ungeprüfte Install-Scripts
- Betriebsreife: Runbooks für Day-2 Operations, Secret-Rotation und
  Release-Rehearsal ergänzt; Testkonzept und Assurance-Modell aktualisiert

#### Risk-Layer / TCMS

- Risk-Layer-Client nutzt ein dediziertes trusted Backend-Fetching für die
  festen `/v1/*`-Endpunkte; `RISK_LAYER_URL` darf Docker-Service-DNS,
  Loopback (`127.0.0.1`) oder interne IPs enthalten, ohne
  `INTERNAL_FETCH_HOSTS` zu erweitern
- Compliance: TCMS-Einordnung nach IDW PS 980
  (`docs/compliance/idw-ps980-tcms.md`) mit Mapping der CMS-Grundelemente auf
  vorhandene Bausteine und Konzept für den Teilbereich Organschaft als ersten
  Kontrollkreis
- Subsumtions-Workspace / TCMS: on-prem Analyse-Engine als zustandsloser
  `/v1/*`-Dienst, tenant-scoped Persistenz in TaxTronik, Zugriff nur für
  berechtigte Rollen bzw. Mandantenverantwortliche

#### Sicherheit, Auth und Plattform

- Dokumentvorschau: unsichere DOCX-HTML-Inline-Darstellung entfernt; DOCX
  nutzt ausschließlich den authentifizierten Download-Pfad
- Upload-Schutz: Browser-Limit auf 25 MiB reduziert und nginx begrenzt
  gleichzeitige Uploads pro IP sowie global
- Secrets/Proxy: Neuinstallationen erhalten einen getrennten
  `SECRET_BOX_KEY`; Auth.js-Host-Trust ist verpflichtend und der nginx-VHost
  pinnt Host-/Forwarded-Host kanonisch, während Client-IP-Proxy-Trust
  standardmäßig deaktiviert bleibt
- Log-/Scan-Hygiene: Magic-Link-URLs werden zuverlässig redigiert; Gitleaks ist
  auf 8.29.0 aktualisiert und ignoriert nicht länger pauschal die gesamte
  `.env.example`
- Vollmachts-Provenienz: der DB-generierte Versandzeitpunkt nutzt dieselbe
  monotone Millisekundenpräzision wie das Legacy-Erstellungsfeld; manipulierte
  zukünftige Erstellungszeiten bleiben durch die Integritätsprüfung blockiert
- Session-/Cookie-Härtung: Produktions-Cookies mit `__Host-`/`__Secure-`
  Präfixen, strengere Host-/Proxy-Annahmen und Dokumentation des einmaligen
  Re-Login-Effekts beim Wechsel
- Review-Härtung des Release-Deltas: unabhängige Review-Durchgänge,
  verifizierte Befunde behoben, u. a. Produktions-Login,
  Portal-Freigaben, Doppelsubmit-Schutz, Overdue-Worker-Robustheit,
  USt-ID-Pflichtcheck und Berechtigungs-Metadaten-Drift-Guard
- **[Scope]** Zugriffsschutz: granulare Einzelrechte je Mitarbeiter
  (Migration iter87) für Rechnungen anlegen/bearbeiten, Rechnungen versenden
  und Urlaub entscheiden; Admin/Partner implizit alles, Vergabe/Entzug
  Admin-only und Audit-Event `staff.permissions.update`
- **[Scope]** Dokumente: Detailseite prüft RESTRICTED-Zuständigkeit und
  schließt damit einen Metadaten-Leak
- **[Scope]** Portal: Rechnungs-PDFs sind für Mandanten abrufbar; die fehlende
  Freigabe für versendete Rechnungen wurde geschlossen
- **[Scope]** CI führt alle Testpakete aus und archiviert Testprotokolle als
  Nachweis-Artefakte je Lauf

#### Fachliche Module und Workflows

- ELSTER: neutrales Paket `@taxtronik/elster` (Feature-Flag
  `ELSTER_BRIDGE_URL`/`ELSTER_BRIDGE_TOKEN`, typisierter Client für
  Validierung und Kontoabfrage inkl. Sollstellungen). Datenteil und
  TransferHeader — und damit die Hersteller-ID — entstehen ausschließlich in
  der privaten eric-bridge; ohne konfigurierte Bridge bleibt das Modul
  inaktiv (Muster Risk-Layer)
- Posteingang: Architektur-Konzept für intelligenten Dokumenteneingang
  (`docs/development/posteingang-konzept.md`) über Outlook, UNC/Scanner und
  mehrstufige Triage-Pipeline mit Vision-Stufe für Beleg-Scans
- Fristenkontrollbuch (`/staff/fristen`): einheitliche Kontrollsicht über
  Steuertermine, Einspruchsfristen, Anforderungen und Wiedervorlagen mit
  Verantwortlichen, Erledigungsnachweis und Audit-Chain-CSV-Export
- ELSTER-Vorbereitung: Architektur- und Pflichtendokument für die
  ERiC-Anbindung (`docs/development/eric-integration.md`); CI-Guard
  `check-no-eric-spec.sh` verhindert versehentliches Einchecken vertraulicher
  Spezifikationsartefakte
- Onboarding: Inbetriebnahme-Checkliste prüft Kanzlei-Kontaktdaten,
  Modul-/Rechnungsmodus-Entscheidung und ersten GwG-aktiven Mandanten; neues
  Anwenderdoku-Kapitel "Erste Schritte"
- Abwesenheiten: Krankmeldung zur generischen Abwesenheitsmeldung erweitert;
  neutrale Teamanzeige, Kanzleikalender-Einträge und Benachrichtigungen an
  Entscheidungsträger

#### Fakturierung und E-Rechnung

- **[Scope]** Fakturierung: USt-Satz je Position (Migration iter86; 19 %,
  7 %, 0 %) mit Steuerausweis und Rundung je Satz-Gruppe in Anzeige, PDF und
  E-Rechnung; Bestandsrechnungen übernehmen den bisherigen Kopfsatz
- **[Scope]** E-Rechnung: XRechnung-Generator besteht den KoSIT-Validator
  (XRechnung 3.0.2, Schema + Schematron inkl. BR-DE); ergänzt u. a.
  Geschäftsprozess, Käuferreferenz, Verkäufer-Kontakt und Leistungsdatum;
  CI-Job `e-rechnung` validiert gegen den gepinnten Validator
- **[Scope]** Fakturierung GoB-fest (Migration iter85): automatische
  lückenlose Rechnungsnummern je Jahr, DB-seitige Festschreibung nach Versand,
  Statusübergänge nur vorwärts, GoBD-Archivkopie vor Versand und Schutz
  abgerechneter Zeiteinträge

#### Backup, Archiv und Compliance-Nachweise

- **[Scope]** Backup: Admin-Trigger ist im Build-Kontext enthalten;
  vollständige Datenbank-Dumps sind wegen ihres installationsweiten Inhalts
  im Browser nicht herunterladbar und bleiben dem Betreiber-Host/S3 vorbehalten
- **[Scope]** Backup: Browser-Backup-Verzeichnis wird vor App-Start
  vorbereitet und im Compose-One-Shot auf den Container-`node`-User
  berechtigt; `./taxtronik backup-files` erstellt weiterhin einen ergänzenden
  SeaweedFS-Byte-Export
- **[Scope]** Full-Backup: `./taxtronik backup-full` erstellt unter einem
  globalen Lock einen quieszierten Recovery Point aus TaxTronik-/n8n-Dumps,
  Object-Export, Cold-Snapshots von SeaweedFS/Redis/n8n und
  Recovery-Konfiguration, versiegelt ihn gemeinsam mit age und signiert das
  SHA-256-Inventar per Ed25519; optionaler Offsite-Upload erzwingt HTTPS,
  Versioning und Object Lock COMPLIANCE samt Receipt
- **[Scope]** Restore: `./taxtronik restore` ergänzt den Operator-Pfad für
  `--list`, `--latest`, `--key` und lokale `--file`-Dumps; Container-Fallback
  streamt Host-Dumps korrekt in `pg_restore`
- **[Scope]** Restore-Härtung: Dumps und Restores erhalten PostgreSQL-ACLs und
  sicherheitsrelevante REVOKEs; der CI-Roundtrip prüft `taxtronik_app`, RLS,
  Audit-Tabellen und GwG-SECURITY-DEFINER-Funktionen
- **[Scope]** Retention-Abnahme: `pnpm demo:retention` erzeugt lokale
  GwG-/Object-Lock-Testfälle für löschreif/nicht löschreif sowie aktiven bzw.
  abgelaufenen Governance-Lock
- **[Scope]** Dokumentenarchiv: Object-Lock-Uploads persistieren die konkrete
  S3-`VersionId`; die bestätigte GwG-Vernichtung löscht und verifiziert genau
  diese Version und setzt den Governance-Bypass nur im doppelt fristgeprüften
  Fachpfad. GWG→GOBD-Retagging ist wegen der eigenständigen
  GwG-Vernichtungsfrist gesperrt
- **[Scope]** Aufbewahrung: GoBD-Dateitypen unterscheiden nun 6 Jahre für
  Handels-/Geschäftsbriefe, 8 Jahre für Buchungsbelege und 10 Jahre für
  Bücher/Abschlüsse bzw. gesondert einzuordnende Steuerunterlagen; längere
  Einzelfallpflichten bleiben ausdrücklich fachlich zu prüfen
- **[Scope]** Backup: monatlicher DB-Restore-Drill mit Chain-Verifikation auf
  der wiederhergestellten Wegwerf-Datenbank; der isolierte Full-Restore-Drill
  bleibt dokumentierte Betreiberpflicht; Health-Alarme per E-Mail bei
  Infrastruktur-Ausfall
- Audit-Archivierung: monatliche Archivläufe, Hash-Chain-Prüfung und
  Admin-UI unter `/staff/admin/archive`; HARD-Modus wird ehrlich auf SOFT
  normalisiert, wenn kein DB-Cleanup erfolgt
- Audit-Action-Labels für 80+ Action-Keys und Resource-Types in deutschen
  Views; Compliance-Ansicht bleibt technisch
- GoBD-Verfahrensdokumentation aus dem IST-Zustand im Admin-Panel
- Anwenderdokumentation für Scope-Module (`docs/anwenderdoku/`) und technische
  Modulbeschreibungen mit Traceability (`docs/development/module/`)
- Entwicklungsverfahren, Testkonzept und IDW-PS-880-Gap-Analyse dokumentiert

## [0.1.0] - 2026-06-10

Erster versionierter interner Stand. Enthielt unter anderem CI-geprüfte
Registry-Images, signierte Update-Manifeste, Backup vor Migrationen,
monatlichen Restore-Drill, GoBD-Verfahrensdokumentation und die damalige
Portal-Härtungsrunde. Der annotierte Git-Tag bleibt die maßgebliche historische
Quelle für die vollständigen Release-Notizen.
