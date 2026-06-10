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

- **[Scope]** CI führt jetzt alle Testpakete aus (vorher 4 von 11) und
  archiviert Testprotokolle als Nachweis-Artefakte je Lauf
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
