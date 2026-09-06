# Changelog

Änderungsjournal für TaxTronik.

`v0.1.0` wurde am 10. Juni 2026 als erster versionierter interner Stand
markiert. Der am 21. August 2026 als `0.2.0` bezeichnete Stand war nur ein
**ungetaggter Kandidatenstand**; ein Git-Tag `v0.2.0` existiert nicht und darf
nicht als eigenständige Release-Identität verwendet werden. Seine Änderungen
gingen in den ersten nachfolgenden getaggten Stand `v0.2.1` vom 22. August 2026
ein. Neue, noch nicht getaggte Änderungen stehen unter `[Unreleased]`.

Einträge, die Module des Prüfungs-Scopes betreffen (Fakturierung,
Dokumentenarchiv, Audit-Protokollierung, Zugriffsschutz, Backup/Restore; siehe
[docs/compliance/idw-ps880-pruefungsbereitschaft.md](docs/compliance/idw-ps880-pruefungsbereitschaft.md)),
sind mit **[Scope]** gekennzeichnet. Diese Markierung dient später der
Abgrenzung zwischen bereits geprüfter Version und neuen Änderungen.

Pflegeregel: Änderungen werden hier im selben Arbeitsstand dokumentiert und
vor dem Release-Tag in den zum Tag passenden Versionsabschnitt überführt.

## [Unreleased]

### Behoben

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

### Hinzugefügt

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

## [0.3.0] - 2026-09-01

Version 0.3.0 bündelt den Ausbau nach `v0.2.1`. Die Versionsnummer ist keine
fachliche, rechtliche oder PS-880-bezogene Freigabe; ungeprüfte Fachregeln und
offene organisatorische Pilotentscheidungen bleiben ausdrücklich als solche
gekennzeichnet.

### Hinzugefügt

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

## [0.2.0 – ungetaggter Kandidatenstand] - 2026-08-21

Für diesen Abschnitt existiert **kein** Git-Tag `v0.2.0`. Die aufgeführten
Änderungen wurden erst als Bestandteil von `v0.2.1` versioniert ausgeliefert.

### Releaseabschluss

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

### Seit dem Kandidatenstand ergänzte Änderungen

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

### Betrieb, Deployment und Dokumentation

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

### Risk-Layer / TCMS

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

### Sicherheit, Auth und Plattform

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

### Fachliche Module und Workflows

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

### Fakturierung und E-Rechnung

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

### Backup, Archiv und Compliance-Nachweise

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
