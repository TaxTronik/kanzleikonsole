# Changelog

Änderungsjournal für TaxTronik.

`v0.1.0` wurde am 10. Juni 2026 als erster versionierter interner Stand
markiert. Der hier vorbereitete `v0.2.0`-Stand ist der erste umfassend
gehärtete Release-Kandidat für Installation und Betrieb; neue Änderungen
landen danach wieder unter `[Unreleased]`.

Einträge, die Module des Prüfungs-Scopes betreffen (Fakturierung,
Dokumentenarchiv, Audit-Protokollierung, Zugriffsschutz, Backup/Restore; siehe
[docs/compliance/idw-ps880-pruefungsbereitschaft.md](docs/compliance/idw-ps880-pruefungsbereitschaft.md)),
sind mit **[Scope]** gekennzeichnet. Diese Markierung dient später der
Abgrenzung zwischen bereits geprüfter Version und neuen Änderungen.

Pflegeregel: Änderungen werden hier im selben Arbeitsstand dokumentiert und
vor dem Release-Tag in den zum Tag passenden Versionsabschnitt überführt.

## [Unreleased]

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
- n8n auf den verifizierten Stable-Release 2.25.7 aktualisiert; globale
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

## [0.2.0] - 2026-07-14

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
