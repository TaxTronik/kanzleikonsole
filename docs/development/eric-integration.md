# ELSTER-Anbindung über ERiC: Architektur, Lizenzpflichten, Umgangsregeln

Arbeitsstand: 2026-06-10. Grundlage ist die ELSTER-Lizenzvereinbarung für
Softwarehersteller (§-Angaben beziehen sich darauf) und die
Herstellerunterlagen aus dem ELSTER-Entwicklerbereich. Dieses Dokument
beschreibt Regeln und Architektur in eigenen Worten — die Unterlagen
selbst sind vertraulich und liegen außerhalb des Repos.

## 1. Umgangsregeln (verbindlich, CI-erzwungen)

Die ERiC-Distribution (Bibliotheken, Schnittstellenbeschreibungen/XSDs,
Schemadokumentation, Entwicklerdokumentation) unterliegt der
Vertraulichkeit (§ 14); ein Verstoß kann zur Sperrung der Hersteller-ID
führen (§ 9). Repo-Inhalte landen in Releases, CI-Artefakten, Backups und
Kunden-Checkouts — deshalb gilt:

1. **Nichts davon ins Repo.** Weder Bibliotheken noch Schemata noch
   Auszüge aus der Doku (auch nicht „nur kurz" oder als Kommentar).
   Der CI-Guard `scripts/check-no-eric-spec.sh` (Job `quality`) blockt
   Dateinamen- und Inhaltsmarker; XSD-Dateien sind generell unzulässig.
2. **Ablageorte:** Entwicklung lokal außerhalb des Repos
   (`C:\Users\Rey\Desktop\ERiC`, perspektivisch `C:\dev\eric`); auf dem
   Produktionsserver ein eigenes, nicht versioniertes Verzeichnis (z. B.
   `/opt/taxtronik/eric`), das der Bridge-Container als Volume erhält.
3. **Die Bridge lebt in einem separaten, privaten Repository**
   (`taxtronik-eric-bridge`), nicht in diesem Monorepo. In dieses Repo
   kommt nur die neutrale Schnittstelle (Typen + HTTP-Client + Stub).
4. **Hersteller-ID ist ein Geheimnis** wie ein API-Schlüssel: nur als
   Konfiguration der Bridge, nie im Code oder in Beispieldaten.

## 2. Lizenzpflichten → Produktanforderungen

| Pflicht (sinngemäß) | Quelle | Umsetzung in TaxTronik |
|---|---|---|
| ERiC darf in das eigene Produkt integriert und als einheitliches Produkt verbreitet werden; keine Unterlizenzierung darüber hinaus | § 4 | Bridge-Image wird nur als Teil des TaxTronik-Deployments an Kanzleien ausgeliefert; kein separater Vertrieb |
| DSGVO-Informationsschreiben der Finanzverwaltung dem Endnutzer VOR Nutzung zur Kenntnis bringen, **mit Bestätigung** | § 5 | Feature-Pflicht: einmalige, pro Mitarbeiter bestätigte Kenntnisnahme vor erstmaliger Nutzung der ELSTER-Funktionen; Bestätigung als Audit-Event in der Hash-Chain |
| Vorgegebenen Datenschutzhinweis der Finanzverwaltung anzeigen | § 5 | Anzeige im selben Kenntnisnahme-Dialog; Wortlaut wird zur Umsetzung aus der Vereinbarung übernommen (dafür vorgesehen) |
| Verwendung gemäß Doku; regelmäßige Prüfung auf neue Versionen; **Mindestversion ist Pflicht** | § 5 | Versions-Monitoring: Release-Rhythmus ist Mai (technisch) / November (Jahresfortschreibung), Mindestversions-Anhebung typischerweise im April — Prüfung wird in den bestehenden Health-/Update-Check eingehängt, Alarm an Admins rechtzeitig vor dem Stichtag |
| Protokolldateien entstehen bei Serverbetrieb auf dem Server, können personenbezogene Daten enthalten; Endnutzer informieren, Weitergabe nur mit ausdrücklicher Erlaubnis | § 15, § 7 | Log-Verzeichnis der Bridge: eigenes Volume, rotierend (~10 MiB-Dateien), Zugriff nur Admin; Hinweis in der Anwenderdoku; kein automatischer Versand der Logs irgendwohin |
| Datensicherung in angemessenem Umfang; Endnutzer informieren | § 5 | Bereits abgedeckt (Backup + Restore-Drill); Hinweis ergänzt die Anwenderdoku |
| Marken: Kompatibilitätshinweis erlaubt, „ELSTER" nicht im Produktnamen, Logo nur per Sondervereinbarung | § 12 | Produktname unverändert „TaxTronik"; Formulierung „geeignet zur Verwendung mit ELSTER", kein Logo |
| Support gegenüber Endnutzern leistet der Hersteller; Support-Kontakte der Finanzverwaltung nicht weitergeben | § 7 | Supportweg bleibt Hirschmann-Koxha; keine LfSt-Kontakte in Doku/UI |

## 3. Architektur: eric-bridge als eigener Dienst

**Warum ein eigener Container:** Die Bibliothek ist natives C (Zugriff via
FFI), verlangt glibc ≥ 2.28 und wird für Debian/Ubuntu/RHEL/SUSE
unterstützt — der TaxTronik-Worker läuft auf Alpine/musl und scheidet als
Wirt aus. Außerdem isoliert ein eigener Dienst die vertraulichen Artefakte
(Volume nur an diesem Container) und das Absturzrisiko nativen Codes.

```
worker (BullMQ, Alpine)  ──HTTP (intern, Token)──▶  eric-bridge (Debian-slim)
                                                      ├─ native ERiC-Bibliotheken (Volume, nicht im Image)
                                                      ├─ Instanz-Pool (Multithreading-API)
                                                      └─ eric-Logs (eigenes Volume)
```

- **Privates Repo `taxtronik-eric-bridge`:** Node auf Debian-slim, FFI auf
  die C-API, kleiner HTTP-Dienst mit zwei Kernoperationen:
  `validate` (Datensatz prüfen, Fehlerliste zurück) und `submit`
  (prüfen + senden, Antwort/Transferticket zurück). Instanz-Pool nach
  Herstellerempfehlung (Instanzen sind teuer, 1 Instanz : 1 Thread).
- **Dieses Repo:** neutrale Schnittstelle `@taxtronik/elster` (Typen,
  HTTP-Client, Fehlertaxonomie, Feature-Flag `ELSTER_BRIDGE_URL` +
  Token) und die Worker-Jobs/UI darauf. Ohne konfigurierte Bridge ist das
  Modul unsichtbar (Muster: Signal-Engine/Risk-Layer).
- **Bauen/Deployen:** Das Bridge-Image wird außerhalb dieses Repos gebaut
  (privates Repo + privates Registry-Paket); compose bindet es nur ein.
  Die nativen Bibliotheken kommen als Volume vom Server-Verzeichnis —
  so erzwingt ein ERiC-Update keinen Image-Rebuild.

**Zertifikate:** Versand authentisiert sich mit dem Portalzertifikat der
Kanzlei (Datei + PIN). Ablage analog zu bestehenden Geheimnissen:
verschlüsselt je Tenant (Muster TOTP-Secret), PIN-Eingabe pro Vorgang oder
pro Sitzung — Designentscheidung in iter-Planung. Test vs. Produktion über
den vorgesehenen Test-Kennzeichnungsmechanismus der Schnittstelle, damit
Staging nie echte Übermittlungen auslöst (Clearingstellen-Testbetrieb
verwirft Daten nach Validierung).

**Sinnvolle Ausbaustufen:**

1. **Stufe 1 — Validierung:** UStVA-Datensätze erzeugen und gegen ERiC
   validieren (ohne Versand). Geringes Risiko, sofortiger Nutzen
   (Fehler vor Abgabe), kein Zertifikatshandling nötig.
2. **Stufe 2 — Versand UStVA/Dauerfristverlängerung** mit
   Portalzertifikat, Transferticket-Ablage GoBD-archiviert, Audit-Events.
3. **Stufe 3 — weitere Datenarten** (LStA, Jahreserklärungen) nach
   Bedarf; jede Datenart bringt eigene Jahresversionen mit (jährliche
   Pflege im November-Release-Takt).

## 4. Offene Entscheidungen vor iter-Start

- Hersteller-ID beantragen (produktbezogen) — Voraussetzung für alles.
- PIN-Handling beim Versand (pro Vorgang eingeben vs. Sitzungs-Cache).
- Welche Datenart zuerst produktiv (Vorschlag: UStVA, höchste Frequenz).
- Naming/Repo-Anlage `taxtronik-eric-bridge` auf dem Forgejo.
