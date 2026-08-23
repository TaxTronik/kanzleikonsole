# Release-Evidence-Dossier — Vorlage

Vorlagenstand: 2026-08-23

> **Noch kein Nachweis:** Diese Datei ist eine auszufüllende Vorlage. Leere
> Felder, Checkboxen und Beispielwerte dürfen nicht als tatsächlich
> durchgeführte Prüfung, Freigabe oder bestandene Kontrolle ausgelegt werden.
> Für jeden Release wird eine Kopie angelegt und ausschließlich mit Werten aus
> dem konkreten Release-Lauf befüllt. Fehlgeschlagene oder fehlende Nachweise
> werden als Abweichung dokumentiert, nicht auf „bestanden“ gesetzt.

Das Dossier verbindet Release-Identität, CI-Läufe, veröffentlichte Images,
Prüfberichte und Freigabeentscheidungen. Es unterstützt eine spätere
Softwareprüfung, ist selbst aber weder unabhängiger Prüfungsbericht noch
Softwarebescheinigung.

## 1. Dossier-Metadaten

| Feld                                 | Tatsächlicher Wert                         |
| ------------------------------------ | ------------------------------------------ |
| Dossier-ID                           | `…`                                        |
| Erstellt am (UTC)                    | `…`                                        |
| Erstellt durch                       | `…`                                        |
| Prüfungs-/Release-Scope              | `…`                                        |
| Zugehörige Prüfumgebungs-ID          | `…` oder „nicht zutreffend“ mit Begründung |
| Ablageort des vollständigen Dossiers | `…`                                        |
| Hashalgorithmus für diese Vorlage    | `SHA-256`                                  |
| Referenz im externen Hashmanifest    | relativer Pfad: `…`; SHA-256 dort: `…`     |

Der Hash dieser ausgefüllten Datei wird nach ihrem Abschluss in einem
separaten Hashmanifest oder Ablagenachweis gespeichert. Ein in derselben Datei
eingetragener Selbst-Hash wäre zirkulär und daher kein reproduzierbarer Wert.

## 2. Unverwechselbare Release-Identität

| Feld                                   | Tatsächlicher Wert / Fundstelle         |
| -------------------------------------- | --------------------------------------- |
| Release-Version                        | `…`                                     |
| Annotierter Release-Tag                | `v…`                                    |
| Tag-Objekt-ID, sofern verfügbar        | `…`                                     |
| Vollständiger Commit-SHA               | `…`                                     |
| Commit-Zeitpunkt (UTC)                 | `…`                                     |
| Hauptbranch und geprüfte Zugehörigkeit | `…`                                     |
| CHANGELOG-Abschnitt / SHA-256          | `…`                                     |
| Release-Workflow-Datei / SHA-256       | `.forgejo/workflows/release.yml` / `…`  |
| CI-Workflow-Datei / SHA-256            | `.forgejo/workflows/ci.yml` / `…`       |
| Security-Workflow-Datei / SHA-256      | `.forgejo/workflows/security.yml` / `…` |
| Release-Run-ID und unveränderliche URL | `…`                                     |
| Laufbeginn / Laufende (UTC)            | `…` / `…`                               |
| Runner-/Executor-Version               | `…`                                     |

Kontrollfrage: Zeigen Tag, Commit, Workflow-Checkout, OCI-Label
`org.opencontainers.image.revision` und Update-Manifest auf denselben
vollständigen Commit? Ergebnis und Gegenprüfer: `…`

## 3. Veröffentlichte Artefakte

| Artefakt          | Unveränderliche Referenz    | Registry/Quelle | Verifikation                             |
| ----------------- | --------------------------- | --------------- | ---------------------------------------- |
| Web-Image         | `…/web:…@sha256:…`          | `…`             | Digest erneut aufgelöst am `…` durch `…` |
| Worker-Image      | `…/worker:…@sha256:…`       | `…`             | Digest erneut aufgelöst am `…` durch `…` |
| Update-Manifest   | Pfad/URL: `…`; SHA-256: `…` | `…`             | Signaturprüfung: `…`                     |
| Manifest-Signatur | Pfad/URL: `…`; SHA-256: `…` | `…`             | Public-Key-Fingerprint/Version: `…`      |

Für beide Images werden Registry-Digest und lokaler Pull nach Digest
gegengelesen. Ein Tag allein gilt nicht als unveränderliche Referenz. Ist die
Manifest-Publikation fehlgeschlagen oder nur ein Teil der Images publiziert,
wird der Release als unvollständig dokumentiert und nicht nachträglich als
grüner Lauf dargestellt.

## 4. CI- und Workflow-Nachweise

Die tatsächlich ausgeführten Jobs des Release-DAG werden eingetragen. Die
aktuellen Workflow-Bezeichnungen unten sind eine Orientierung und vor dem
Ausfüllen gegen den gebundenen Workflow-Commit zu prüfen.

| Gate / Job                                  | Run-/Job-URL | Ergebnis | Beginn/Ende UTC | Artefakt oder Log + SHA-256       | Bemerkung                                               |
| ------------------------------------------- | ------------ | -------- | --------------- | --------------------------------- | ------------------------------------------------------- |
| Release-Preflight (Tag, SHA, Manifest-Ziel) | `…`          | `…`      | `…`             | `…`                               | `…`                                                     |
| Format, Lint, Typecheck, Unit Tests         | `…`          | `…`      | `…`             | `testbericht-unit`: `…`           | `…`                                                     |
| Operator-CLI-Tests                          | `…`          | `…`      | `…`             | `testbericht-ops`: `…`            | Bestandteil des Quality-Jobs                            |
| Fachkatalog-Prüfung und Diff-Gate           | `…`          | `…`      | `…`             | Joblog: `…`                       | Review-Stände nicht mit technischer Prüfung verwechseln |
| Migrations, RLS, Drift                      | `…`          | `…`      | `…`             | `testbericht-db`: `…`             | `…`                                                     |
| Backup→Restore Roundtrip                    | `…`          | `…`      | `…`             | `testbericht-restore`: `…`        | `…`                                                     |
| Upgrade-Pfad                                | `…`          | `…`      | `…`             | `…`                               | Ausgangsrelease: `…`                                    |
| Browser E2E                                 | `…`          | `…`      | `…`             | `playwright-report`: `…`          | `…`                                                     |
| E2E Paranoid                                | `…`          | `…`      | `…`             | `playwright-report-paranoid`: `…` | `…`                                                     |
| XRechnung-Konformität (KoSIT)               | `…`          | `…`      | `…`             | `kosit-pruefbericht`: `…`         | Details in Abschnitt 5                                  |
| Deploy-Readiness                            | `…`          | `…`      | `…`             | `…`                               | `…`                                                     |
| Dependency Audit                            | `…`          | `…`      | `…`             | `security-audit-prod`: `…`        | Details in Abschnitt 7                                  |
| Secret Scan                                 | `…`          | `…`      | `…`             | `security-gitleaks`: `…`          | Details in Abschnitt 7                                  |
| Release-Image-Smoke                         | `…`          | `…`      | `…`             | Joblog: `…`                       | geprüfte Digests: `…`                                   |
| Images bauen, scannen und publizieren       | `…`          | `…`      | `…`             | Joblog: `…`                       | `…`                                                     |
| Signiertes Update-Manifest publizieren      | `…`          | `…`      | `…`             | Manifest/Signatur: `…`            | Ziel-Commit: `…`                                        |

„Grün“ wird nur aus dem Abschlussstatus des gebundenen Jobs übernommen. Ein
Artefakt-Upload mit `if: always()` beweist für sich allein nicht, dass der
vorherige Test bestanden wurde.

## 5. KoSIT-/E-Rechnungsnachweis

Dieser Abschnitt betrifft die externe Formatvalidierung für
`INV-ARCHIVE-EINVOICE-001`. Am Vorlagenstand war die Fachregel
berufsträgerlich `unreviewed`; für das konkrete Dossier wird der Review-Stand
aus dem gebundenen Release neu ermittelt. Ein ACCEPTABLE-Validatorergebnis
bestätigt nur den vom konkreten Szenario geprüften Formatumfang und weder alle
steuerlichen Konstellationen noch eine allgemeine fachliche Freigabe.

| Feld                                                | Tatsächlicher Wert                              |
| --------------------------------------------------- | ----------------------------------------------- |
| KoSIT-Job-URL und Run-ID                            | `…`                                             |
| Validator-Version, Bezugsquelle und SHA-256         | `…`                                             |
| XRechnung-Szenarioversion, Bezugsquelle und SHA-256 | `…`                                             |
| Erzeugte Referenzfälle                              | `…`                                             |
| Einzelberichte mit SHA-256                          | `…`                                             |
| Validator-Gesamtergebnis                            | `ACCEPTABLE` / `REJECT` / Umgebungsfehler / `…` |
| Bekannte nicht geprüfte Formate/Fälle               | `…`                                             |
| Technische Gegenprüfung                             | Name / Datum / Ergebnis: `…`                    |
| Berufsträgerliche Einordnung, falls erfolgt         | Name / Datum / Umfang: `…` oder „nicht erfolgt“ |

## 6. SBOM und Artefakt-Hashmanifest

Der Release-Workflow erzeugt derzeit CycloneDX-SBOMs aus den final gebauten
Web- und Worker-Images und lädt sie als
`release-sbom-<version>` hoch. Für das konkrete Dossier werden Name und Inhalt
aus dem gebundenen Lauf verifiziert.

| Artefakt                              | Format                 | Quelle | SHA-256                                   | Größe in Bytes |
| ------------------------------------- | ---------------------- | ------ | ----------------------------------------- | -------------- |
| `web.cdx.json`                        | CycloneDX JSON         | `…`    | `…`                                       | `…`            |
| `worker.cdx.json`                     | CycloneDX JSON         | `…`    | `…`                                       | `…`            |
| Dossier-Hashmanifest ohne Selbst-Hash | `sha256sum`-kompatibel | `…`    | separat im Abschluss-/Ablagenachweis: `…` | `…`            |

Zusätzlich erhält **jede** übernommene Datei einen Eintrag im Hashmanifest:

| Relativer Dossierpfad | Ursprünglicher Run/Job | Abrufzeit UTC | SHA-256 | Größe | Prüfung auf Secrets/Personendaten |
| --------------------- | ---------------------- | ------------- | ------- | ----- | --------------------------------- |
| `…`                   | `…`                    | `…`           | `…`     | `…`   | `…`                               |

Beispielbefehle zur Hashbildung; der tatsächliche Befehl und die verwendete
Werkzeugversion werden im Dossier notiert:

```sh
sha256sum relative/path/to/artifact
```

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath 'relative\path\to\artifact'
```

## 7. Security-Nachweise

| Kontrolle                      | Werkzeug/Version  | Tatsächliches Ergebnis | Bericht/Log + SHA-256 | Offene Befunde / Abweichungs-ID |
| ------------------------------ | ----------------- | ---------------------- | --------------------- | ------------------------------- |
| Produktionsabhängigkeiten      | `pnpm audit`: `…` | `…`                    | `…`                   | `…`                             |
| Vollständiger Dependency-Graph | `pnpm audit`: `…` | `…`                    | `…`                   | nicht blockierender Lauf; `…`   |
| Secret Scan                    | Gitleaks `…`      | `…`                    | `…`                   | `…`                             |
| Web-Image                      | Trivy `…`         | `…`                    | `…`                   | `…`                             |
| Worker-Image                   | Trivy `…`         | `…`                    | `…`                   | `…`                             |
| Release-Stack-Smoke            | Skript/Commit `…` | `…`                    | `…`                   | `…`                             |

Die Gate-Semantik wird aus dem gebundenen Workflow dokumentiert. Im derzeitigen
Release-Workflow wird ein HIGH/CRITICAL-Überblick nicht blockierend ausgegeben;
der zweite Trivy-Lauf blockiert CRITICAL-Befunde mit verfügbarem Fix, weil er
mit `--severity CRITICAL --ignore-unfixed --exit-code 1` läuft. Daraus darf
nicht pauschal „keine Schwachstellen“ abgeleitet werden. Nicht blockierende,
unfixbare oder akzeptierte Befunde bleiben sichtbar und werden bei Bedarf in
Abschnitt 8 bewertet.

## 8. Abweichungen und Risikoentscheidungen

Fehlende Nachweise, rote/übersprungene Jobs, manuelle Wiederholungen,
Scope-Lücken und offene Security-Befunde werden einzeln erfasst. Eine
Risikoakzeptanz ändert nicht das technische Testergebnis.

| ID      | Befund / fehlender Nachweis | Auswirkung und Scope | Entscheidung / Kompensation | Verantwortliche Rolle und Name | Datum UTC | Ablauf / Nachprüfung |
| ------- | --------------------------- | -------------------- | --------------------------- | ------------------------------ | --------- | -------------------- |
| `DEV-…` | `…`                         | `…`                  | `…`                         | `…`                            | `…`       | `…`                  |

Nicht anwendbare Kontrollen erhalten eine konkrete Scope-Begründung; ein leeres
Feld oder „N/A“ ohne Begründung gilt als unvollständig.

## 9. Freigaben

Freigaben werden erst nach Prüfung der vorstehenden Nachweise eingetragen.
Automatische CI-Ergebnisse ersetzen keine benannte Release-Entscheidung. Eine
technische Freigabe setzt keine Fachkatalogregel auf `approved`; eine
berufsträgerliche Fachfreigabe muss separat nach dem im Fachkatalog
dokumentierten Verfahren erfolgen.

| Freigabe                               | Name und Rolle           | Entscheidung und Scope                          | Datum/Zeit UTC | Referenz / dokumentierte Bestätigung |
| -------------------------------------- | ------------------------ | ----------------------------------------------- | -------------- | ------------------------------------ |
| Technische Release-Verantwortung       | `…`                      | `…`                                             | `…`            | `…`                                  |
| Security-Gegenprüfung                  | `…`                      | `…`                                             | `…`            | `…`                                  |
| Betrieb / Deployment                   | `…`                      | `…`                                             | `…`            | `…`                                  |
| Fachliche Freigabe betroffener Regeln  | `…` oder „nicht erfolgt“ | Regel-IDs: `…`                                  | `…`            | Fachkatalog-Nachweis: `…`            |
| Prüfungskoordination, falls beauftragt | `…`                      | Vollständigkeit der Übergabe, keine Prüfaussage | `…`            | `…`                                  |

Gesamtentscheidung: `freigegeben` / `nicht freigegeben` / `freigegeben mit
dokumentierten Abweichungen` — Begründung und Abweichungs-IDs: `…`

## 10. Aufbewahrung und Wiederauffindbarkeit

| Merkmal                               | Festgelegter Wert / Nachweis     |
| ------------------------------------- | -------------------------------- |
| Primärer Archivspeicher               | `…`                              |
| Zweite unabhängige Kopie              | `…`                              |
| Zugriffsrollen                        | `…`                              |
| Verschlüsselung / Schlüsselreferenz   | `…`                              |
| Unveränderlichkeit / Versionierung    | `…`                              |
| Aufbewahrungsbeginn und -ende         | `…`                              |
| Rechts-/Vertrags-/Prüfgrund der Frist | `…`                              |
| Löschfreigabeverfahren                | `…`                              |
| Letzter Restore-/Lesbarkeitstest      | Datum / Ergebnis / Nachweis: `…` |
| Verantwortliche Stelle                | `…`                              |

Die Workflows fordern derzeit 90 Tage Artefaktaufbewahrung an. Eine
Forgejo-Instanz kann diese Frist begrenzen, und auch 90 Tage sind keine
automatische Daueraufbewahrung. Vor Ablauf werden die Nachweise mit ihren
Metadaten in den festgelegten Archivspeicher übernommen; erfolgreicher Upload
und spätere Lesbarkeit werden verifiziert.

## 11. Abschlusskontrolle

- [ ] Alle Werte stammen aus dem bezeichneten Release-Lauf.
- [ ] Tag, Commit, OCI-Labels, Digests und Manifest sind widerspruchsfrei.
- [ ] Fehlgeschlagene und wiederholte Läufe sind erkennbar erhalten.
- [ ] Alle übernommenen Dateien stehen im Hashmanifest; dessen eigener Hash
      steht separat im Abschluss-/Ablagenachweis.
- [ ] KoSIT-Version, Szenarien, Fälle und Einzelberichte sind gebunden.
- [ ] SBOMs gehören nachweislich zu den veröffentlichten Image-Builds.
- [ ] Nicht blockierende Security-Befunde sind bewertet oder offen markiert.
- [ ] Abweichungen haben Verantwortliche, Frist und Nachprüfung.
- [ ] Technische und fachliche Freigaben sind getrennt.
- [ ] Aufbewahrung und Wiederherstellung sind dokumentiert.
- [ ] Logs und Berichte wurden auf Secrets und personenbezogene Daten geprüft.

- Abschlusskontrolle durch: `…`
- Datum/Zeit UTC: `…`
- Ergebnis und offene Abweichungs-IDs: `…`

## Referenzen

- [Eingefrorene Prüfumgebung](./pruefumgebung.md)
- [PS-880-Readiness-Analyse](../compliance/idw-ps880-pruefungsbereitschaft.md)
- [Testkonzept](../development/testkonzept.md)
- [Entwicklungs- und Freigabeverfahren](../development/entwicklungsverfahren.md)
- [Release-Prozess](../operations/release.md)
- [Assurance Model](./assurance-model.md)
- [Known Limits](./known-limits.md)
- [Fachkatalog](../fachkatalog/README.md)
