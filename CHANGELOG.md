# Changelog

Änderungsdokumentation je Release. Einträge, die Module des
Prüfungs-Scopes betreffen (Fakturierung, Dokumentenarchiv,
Audit-Protokollierung, Zugriffsschutz, Backup/Restore — siehe
[docs/compliance/idw-ps880-pruefungsbereitschaft.md](docs/compliance/idw-ps880-pruefungsbereitschaft.md)),
sind mit **[Scope]** gekennzeichnet: Sie sind die Grundlage für
Folgeprüfungen (Abgrenzung geprüfte ↔ neue Version).

Pflegeregel: Jeder Release-Tag erfordert einen vollständigen Abschnitt hier;
der Eintrag entsteht mit der Änderung, nicht nachträglich.

## [Unreleased]

- ELSTER-Vorbereitung: Architektur- und Pflichtendokument für die
  ERiC-Anbindung (docs/development/eric-integration.md — Bridge als
  separater Dienst in privatem Repo, Lizenzpflichten→Produktanforderungen,
  Ausbaustufen ab UStVA-Validierung); neuer CI-Guard
  `check-no-eric-spec.sh` verhindert versehentliches Einchecken
  vertraulicher Spezifikationsartefakte
- Compliance: TCMS-Einordnung nach IDW PS 980 (docs/compliance/
  idw-ps980-tcms.md) — Mapping der CMS-Grundelemente auf vorhandene
  Bausteine und Konzept für den Teilbereich Organschaft als ersten
  Kontrollkreis (Risikoinventar, Kontrollzyklen je Governance-Typ,
  fünfstufiges Assessment; Umsetzung als iter88 geplant)
- Onboarding: Inbetriebnahme-Checkliste ausgebaut — prüft jetzt auch
  E-Mail/Telefon der Kanzlei (E-Rechnungs-Pflicht), die bewusste Modul-/
  Rechnungsmodus-Entscheidung und den ersten GwG-aktiven Mandanten;
  erscheint für Admins zusätzlich kompakt auf dem Dashboard und erledigt
  sich ausschließlich über echten Systemzustand; neues Anwenderdoku-Kapitel
  „Erste Schritte" (Inbetriebnahme in 30 Minuten)
- Deployment: Production-Provisionierung ohne Demodaten —
  `pnpm --filter @taxtronik/db provision` legt Tenant, Default-Dokumenttypen
  und ein Admin-Konto an (Zufallspasswort, einmalig angezeigt); der Dev-Seed
  verweigert in Produktion weiterhin, Doppel-Provisionierung wird erkannt
  und abgebrochen (dokumentiert in docs/operations/release.md §2.1)
- **[Scope]** Zugriffsschutz: granulare Einzelrechte je Mitarbeiter
  (Migration iter87) — Rechnungen anlegen/bearbeiten, Rechnungen versenden
  (= Festschreibung, inkl. Extern-Upload) und Urlaub entscheiden sind jetzt
  delegierbare Einzelrechte; Admin/Partner implizit alles, Vergabe/Entzug
  Admin-only und in der Audit-Chain (`staff.permissions.update`), Entzug
  wirkt sofort. Bestandsmitarbeiter behalten beim Update ihre
  Rechnungs-Rechte (Backfill); neue Mitarbeiter starten ohne Rechnungs-Rechte
- Abwesenheiten: Krankmeldung zur generischen Abwesenheitsmeldung
  verallgemeinert (Krankheit/Sonstige, Migration iter87); Grund nur für
  Melder + Entscheidungsträger sichtbar, Team-Ansichten zeigen neutral
  „abw."; genehmigte Urlaube („‹Name› Urlaub") und Abwesenheiten
  („‹Name› abw.") erscheinen im Kanzleikalender; Entscheidungsträger
  (Admin/Partner + Einzelrecht) werden bei Anträgen und Meldungen gezielt
  benachrichtigt, Antragsteller über die Entscheidung
- **[Scope]** Fakturierung: USt-Satz je Position (Migration iter86,
  19 % / 7 % / 0 % je Zeile, § 14 Abs. 4 Nr. 8 UStG) mit Steuerausweis
  und Rundung je Satz-Gruppe in Anzeige, PDF und E-Rechnung
  (EN-16931-Kategorien S/Z); Bestandsrechnungen übernehmen den bisherigen
  Kopfsatz auf alle Positionen
- **[Scope]** E-Rechnung KoSIT-konform: XRechnung-Generator besteht jetzt
  den KoSIT-Validator (XRechnung 3.0.2, Schema + Schematron inkl. BR-DE) —
  ergänzt: Geschäftsprozess (BT-23), Käuferreferenz (BT-10),
  Verkäufer-Kontakt (BG-6, dafür sind Kanzlei-E-Mail + -Telefon jetzt
  Pflichtangaben), Leistungsdatum (BT-72 = Rechnungsdatum), korrigiert:
  Namespace der Datumselemente; neuer CI-Job `e-rechnung` validiert jeden
  Lauf gegen den gepinnten Validator und archiviert den Prüfbericht
- **[Scope]** Fakturierung GoB-fest (Migration iter85): automatische
  lückenlose Rechnungsnummern je Jahr (Nummernkreis, manuelle Eingabe nur
  noch im Extern-Modus), DB-seitige Festschreibung nach Versand (Felder +
  Positionen), Statusübergangs-Matrix nur vorwärts, GoBD-Archivkopie ist
  Pflicht vor dem Versand, abgerechnete Zeiteinträge unlöschbar
- **[Scope]** Portal: Rechnungs-PDFs sind für Mandanten abrufbar
  (Freigabe wurde nie gesetzt — „Öffnen" lief auf 404)
- **[Scope]** Dokumente: Detailseite prüft jetzt die
  RESTRICTED-Zuständigkeit (Metadaten-Leak geschlossen)
- **[Scope]** CI führt jetzt alle Testpakete aus (vorher 4 von 11) und
  archiviert Testprotokolle als Nachweis-Artefakte je Lauf
- Anwenderdokumentation für die Scope-Module (docs/anwenderdoku/:
  Dokumente, Rechnungen, Administration) und technische Modulbeschreibungen
  mit Traceability (docs/development/module/)
- Entwicklungsverfahren und Testkonzept als beschriebene Verfahren
  dokumentiert (docs/development/)
- IDW-PS-880-Gap-Analyse mit beschlossenem Prüfungs-Scope

## [0.1.0] — 2026-06-10

Erstes versioniertes Release.

- Deployment: CI-getestete Registry-Images (Trivy-Gate), Pull statt Build
  auf dem Server, automatisches Backup vor jeder Migration, dokumentierter
  Rollback-Pfad
- Update-Benachrichtigung: Ed25519-signiertes Update-Manifest, Anzeige
  verfügbarer Versionen im Admin-Panel
- **[Scope]** Backup: monatlicher Restore-Drill (Wiederherstellungstest mit
  Chain-Verifikation auf der wiederhergestellten DB, als Audit-Event
  verankert); Health-Alarme per E-Mail bei Infrastruktur-Ausfall
- **[Scope]** Audit: Katalog-Freigaben (Risk-Engine) mit Vier-Augen-Prinzip,
  Übergänge in der Audit-Chain
- Compliance: GoBD-Verfahrensdokumentation auf Knopfdruck aus dem
  IST-Zustand (Admin-Panel)
- **[Scope]** Zugriffsschutz: Portal-Sicherheitsaudit (3 unabhängige
  Reviews, keine kritischen Befunde); Härtungen: OTP-Gesamtlimit je
  Signatur-Lebenszyklus, iCal-Feed-Einzelwiderruf (Token-Versionierung),
  CSP-Sandbox für text/plain-Previews, Referrer-Policy; tote
  Quarantäne-/Presigned-Konfiguration entfernt
- **[Scope]** Hinweis Datenmigration: iCal-Kalender-Abos müssen nach dem
  Update einmalig neu abonniert werden (neues Token-Format)
