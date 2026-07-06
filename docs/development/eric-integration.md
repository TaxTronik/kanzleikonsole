# ELSTER-Anbindung über ERiC: Architektur, Lizenzpflichten, Umgangsregeln

Arbeitsstand: 2026-07-05. Grundlage ist die ELSTER-Lizenzvereinbarung für
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
  die C-API, kleiner HTTP-Dienst. Umgesetzt: `GET /healthz`,
  `POST /v1/validate` (Stufe 1, lokal), `POST /v1/abfrage` (Stufe 2,
  generisch: Datenteil rein, Bridge erzeugt TransferHeader) und
  `POST /v1/kontoabfrage` (Stufe 2, strukturierte Parameter für
  Istbuchungen/offene Beträge/Sollstellungen). ALLES Schema-nahe —
  Datenteil-Aufbau, TransferHeader-Erzeugung (über die dafür vorgesehene
  ERiC-Funktion) und die Hersteller-ID (`ERIC_HERSTELLER_ID`) — lebt in
  der Bridge; die Eingabe an die TransferHeader-Erzeugung ist bewusst
  namespace-frei, sodass Aufrufer keine Schema-Marker brauchen.
- **Dieses Repo:** neutrale Schnittstelle `@taxtronik/elster` (Typen,
  Zod-validierter HTTP-Client, Fehlertaxonomie, Feature-Flag
  `ELSTER_BRIDGE_URL` + `ELSTER_BRIDGE_TOKEN`) — umgesetzt in
  `packages/elster`. Worker-Jobs/UI darauf folgen als eigene Iteration.
  Ohne konfigurierte Bridge ist das Modul unsichtbar (Muster:
  Signal-Engine/Risk-Layer). Fail-safe: Abfragen verlangen ENTWEDER einen
  Testmerker ODER die explizite Erklärung `echtfall: true` — versehentliche
  Echtübermittlungen aus Dev/Staging sind damit ausgeschlossen.
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

## 4. Stand und offene Entscheidungen

Erledigt:

- Hersteller-ID beantragt und erhalten (2026-07, produktbezogen). Der Wert
  ist ein Geheimnis: ausschließlich als `ERIC_HERSTELLER_ID` im
  Bridge-Deployment (Env/Secret), nie in Code, Doku oder Beispieldaten.
- Repo `taxtronik-eric-bridge` angelegt; Stufe 1 (Validierung) und Stufe 2
  (Kontoabfrage inkl. Sollstellungen) implementiert.
- Neutrale Schnittstelle `packages/elster` in diesem Repo.
- Integrationstest aus dem Bridge-Container (2026-07-06): Stufe 1 validiert
  den Beispieldatensatz der Distribution mit Rückgabecode 0 (die Demo-
  Hersteller-ID des Beispiels ist gesperrt — ERiC prüft die ID auch bei rein
  lokaler Validierung, es muss die eigene sein). Stufe 2 erreicht den
  Clearingstellen-Testbetrieb Ende-zu-Ende (Zertifikat-Handle, TransferHeader,
  CMS-Verschlüsselung, Serverantwort geparst); mit dem IdNr-Testzertifikat der
  Distribution antwortet der Server erwartungsgemäß mit „Signatur für
  Verfahren/Datenart nicht zugelassen" (130025001) — der letzte Schritt
  braucht ein Organisations-/Portalzertifikat. Dabei gefundener FFI-Bug
  (Zertifikat-Handle ist `uint32_t`, kein Pointer — Struct-Layout-Crash) in
  der Bridge behoben.
- Deploy-Verdrahtung: Service `eric-bridge` in
  `infra/compose/docker-compose.app.yml` (Opt-in-Profil `elster`, Muster
  Risk-Layer: internes Netz, kein Host-Port, Healthcheck auf `/healthz`).
  Distribution + Zertifikat kommen als Volumes vom Server
  (`ERIC_DIST_DIR`, `ERIC_CERT_FILE`), Geheimnisse als Env
  (`ERIC_HERSTELLER_ID`, `ELSTER_BRIDGE_TOKEN`) — Schritte in `.env.example`.

Offen:

- Stufe-2-Abschlusstest mit Organisations-/Portalzertifikat (das
  IdNr-Testzertifikat der Distribution ist für ElsterKontoabfrage nicht
  zugelassen; Test-Organisationszertifikat aus dem ELSTER-Entwicklerbereich
  besorgen oder das echte Portalzertifikat der Kanzlei mit Testmerker nutzen).
- PIN-Handling beim Versand (pro Vorgang eingeben vs. Sitzungs-Cache) —
  aktuell: pro Vorgang, wird nirgends persistiert.
- Worker-Jobs + UI auf `@taxtronik/elster` (Kontoabfrage-Ergebnisse in
  Fristen-/Steuerterminmodul einhängen; DSGVO-Kenntnisnahme-Dialog VOR
  erstmaliger Nutzung, siehe § 5-Pflicht in Abschnitt 2).
- Versand-Datenarten (UStVA zuerst) als Stufe-2-Ausbau.
- Bridge-Image-Verteilung: aktuell Build auf dem Server aus dem privaten
  Checkout; optional CI-Publish in die private Registry (Registry-Secret im
  Bridge-Repo nötig).
