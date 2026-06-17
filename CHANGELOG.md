# Changelog

Vor-Release-Änderungsjournal für TaxTronik.

Es gibt derzeit noch kein freigegebenes Produkt-Release. Bis zum ersten
ausgelieferten/tagged Release beschreibt `[Unreleased]` den aktuellen
Arbeitsstand. Ein eigener Versionsabschnitt wird erst beim ersten echten
Release-Tag eröffnet.

Einträge, die Module des Prüfungs-Scopes betreffen (Fakturierung,
Dokumentenarchiv, Audit-Protokollierung, Zugriffsschutz, Backup/Restore; siehe
[docs/compliance/idw-ps880-pruefungsbereitschaft.md](docs/compliance/idw-ps880-pruefungsbereitschaft.md)),
sind mit **[Scope]** gekennzeichnet. Diese Markierung dient später der
Abgrenzung zwischen bereits geprüfter Version und neuen Änderungen.

Pflegeregel: Änderungen werden hier im selben Arbeitsstand dokumentiert. Beim
ersten echten Release wird der bis dahin gültige `[Unreleased]`-Stand in einen
Versionsabschnitt überführt.

## [Unreleased]

### Betrieb, Deployment und Dokumentation

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
- Deployment: CI-getestete Registry-Images vorbereitet (Trivy-Gate), Pull statt
  Build auf dem Server, automatisches Backup vor jeder Migration,
  dokumentierter Rollback-Pfad
- Toolchain: pnpm-Pin auf 11.7.0 angehoben (Root `packageManager` und
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

- **[Scope]** Backup: Admin-Trigger/Download-Routen sind im Build-Kontext
  enthalten; erfolgreiche Backups bieten getrennte Browser-Downloads für lokale
  Kopie und S3-Objekt
- **[Scope]** Backup: Browser-Backup-Verzeichnis wird vor App-Start
  vorbereitet und im Compose-One-Shot auf den Container-`node`-User
  berechtigt; Kanzleidateien können per `./taxtronik backup-files` bzw.
  `backup-full` als SeaweedFS-Bucket-Export gesichert werden
- **[Scope]** Restore: `./taxtronik restore` ergänzt den Operator-Pfad für
  `--list`, `--latest`, `--key` und lokale `--file`-Dumps; Container-Fallback
  streamt Host-Dumps korrekt in `pg_restore`
- **[Scope]** Retention-Abnahme: `pnpm demo:retention` erzeugt lokale
  GwG-/Object-Lock-Testfälle für löschreif/nicht löschreif sowie aktiven bzw.
  abgelaufenen Governance-Lock
- **[Scope]** Backup: monatlicher Restore-Drill mit Chain-Verifikation auf der
  wiederhergestellten DB; Health-Alarme per E-Mail bei Infrastruktur-Ausfall
- Audit-Archivierung: monatliche Archivläufe, Hash-Chain-Prüfung und
  Admin-UI unter `/staff/admin/archive`; HARD-Modus wird ehrlich auf SOFT
  normalisiert, wenn kein DB-Cleanup erfolgt
- Audit-Action-Labels für 80+ Action-Keys und Resource-Types in deutschen
  Views; Compliance-Ansicht bleibt technisch
- GoBD-Verfahrensdokumentation aus dem IST-Zustand im Admin-Panel
- Anwenderdokumentation für Scope-Module (`docs/anwenderdoku/`) und technische
  Modulbeschreibungen mit Traceability (`docs/development/module/`)
- Entwicklungsverfahren, Testkonzept und IDW-PS-880-Gap-Analyse dokumentiert
