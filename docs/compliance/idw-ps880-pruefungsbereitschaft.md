# Prüfungsbereitschaft IDW PS 880: Gap-Analyse und Maßnahmenplan

Arbeitsstand: 2026-07-13.

**Ziel:** TaxTronik soll eine Softwareprüfung nach IDW PS 880 n.F. (01.2022)
mit Erteilung einer Softwarebescheinigung bestehen können. Dieses Dokument
hält fest, was der Prüfer vom Hersteller erwartet, was davon bereits existiert
und was noch fehlt — als lebendes Arbeitsdokument bis zur Prüfung.

> **Quellenregel:** Der Prüfungsstandard wird hier ausschließlich per
> Fundstelle referenziert (Tz.-Nummern). Sein Wortlaut ist urheberrechtlich
> geschützt und wird in diesem Repository nirgends wiedergegeben — weder in
> Dokumenten noch in Code-Kommentaren. Alle Formulierungen hier sind eigene.

## 1. Wie der Prüfer vorgeht — und was das für uns heißt

Die Prüfung läuft in vier Schritten (vgl. Tz. 11 ff.): Der Prüfer nimmt
zunächst Produkt, Entwicklungsumgebung und Verfahrensdokumentation auf,
beurteilt dann unser Entwicklungs-, Test- und Freigabeverfahren, prüft
anschließend anhand der Dokumentation, ob die fachlichen Anforderungen
sachgerecht festgelegt sind (Aufbauprüfung), und verifiziert zuletzt per
Testfällen die Umsetzung (Funktionsprüfung). Entscheidend: Je besser unsere
eigene Test- und Verfahrensdokumentation, desto stärker stützt sich der
Prüfer auf **unsere** Nachweise statt auf eigene, teure Testfälle
(vgl. Tz. 15 f., 68).

Daraus folgt: Prüfungsbereitschaft ist zu ~80 % eine **Dokumentations- und
Nachweisaufgabe**. Der Code selbst ist in gutem Zustand — was fehlt, sind die
Dokumente, die einem fachkundigen Dritten in angemessener Zeit erklären, was
das System tut, wie es entsteht und wie es getestet wird (vgl. Tz. 49).

Für **Folgeprüfungen** (jedes Release neu bescheinigen zu lassen wäre
unbezahlbar) verlangt der Standard ein wirksames Entwicklungs-, Wartungs-
und Freigabesystem plus eine Änderungsdokumentation, aus der die Unterschiede
zwischen geprüfter und neuer Version eindeutig hervorgehen (vgl. Tz. 109 ff.).
Unsere Release-Pipeline (Tags, signierte Manifeste, Image-Digests) ist dafür
die richtige Basis — die Änderungsdokumentation muss formalisiert werden.

## 2. Scope-Entscheidung (beschlossen am 2026-06-10)

Prüfungsgegenstand können das Produkt insgesamt, einzelne Module oder
einzelne Funktionen sein (vgl. Tz. 9, 44, 88). Beschlossener Scope für die
erste Bescheinigung:

| Modul/Funktion                                                | Begründung                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Fakturierung** (Rechnungen inkl. XRechnung/ZUGFeRD)         | einzige Funktion mit direktem Rechnungslegungsbezug (Belegfunktion) — hier gelten die strengsten Kriterien (vgl. Tz. 25 ff.) |
| **Dokumentenarchiv** (GoBD-Tier, Object-Lock, Virenscan)      | Aufbewahrung/Unveränderlichkeit ist das zentrale Kaufargument                                                                |
| **Audit-Protokollierung** (Hash-Chain, Versiegelung, Verify)  | trägt Nachvollziehbarkeit und Unveränderlichkeit für alles andere                                                            |
| **Zugriffsschutzsystem** (Rollen, TOTP, RLS, Portal-Trennung) | programminternes Kontrollsystem, wird in jedem Scope mitgeprüft (vgl. Tz. 10, 35)                                            |
| Backup/Restore inkl. Drill                                    | Sicherheit der Daten (vgl. Tz. 33) — bereits stark nachweisbar                                                               |

Bewusst zunächst **außerhalb**: BWA, Workflows, Subsumtion/TCMS, n8n-Flows,
Portal-Fachfunktionen. Sie bleiben über die Abgrenzung im Auftrag und im
Bericht ausklammerbar (vgl. Tz. 44, 88) und können in Folgeprüfungen
nachgezogen werden.

## 3. Gap-Analyse

Status: ✅ vorhanden und prüfungstauglich · 🟡 vorhanden, aber formalisieren ·
🔴 fehlt.

### 3.1 Verfahrensdokumentation (vgl. Tz. 49 — gilt unabhängig vom Scope)

| Bestandteil               | Status                          | Befund                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Technische Dokumentation  | ✅ (Scope)                      | architecture.md, 12+ ADRs, FEATURES.md, Prisma-Schema, dichte Code-Kommentare. **Seit 2026-06-10:** Modulbeschreibungen je Scope-Modul inkl. Kontrollen + Traceability unter `docs/development/module/`.                                                                                 |
| Betriebsdokumentation     | ✅/🟡                           | README-Produktivbetrieb, release.md, disaster-recovery.md, Verfahrensdoku-Generator, Runbooks. Fehlt: Mengen-/Performance-Annahmen, vollständige Parameter-Referenz (.env-Optionen sind dokumentiert, aber verstreut).                                                                   |
| **Anwenderdokumentation** | ✅ (Scope) / 🟡 (übrige Module) | **Seit 2026-06-10:** Benutzerhandbuch für die Scope-Module unter `docs/anwenderdoku/` (Dokumente, Rechnungen, Administration inkl. Mandanten-Portal-Abschnitte). Übrige Module (BWA, Workflows, Subsumtion …) folgen sukzessive — für den beschlossenen Scope ausreichend (vgl. Tz. 81). |

### 3.2 Softwareentwicklungsverfahren (vgl. Tz. 50–63)

| Anforderung                                             | Status | Befund                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Beschriebenes Entwicklungs-/Wartungs-/Freigabeverfahren | ✅     | **Seit 2026-06-10:** `docs/development/entwicklungsverfahren.md` (Rollen inkl. KI-Assistenz, Änderungs-/Hotfix-Weg, Freigabe = annotierter Tag, Fehlermanagement, Doku-Pflicht je Änderung).                                                                |
| Programmierstandards/Namenskonventionen                 | ✅     | maschinell erzwungen (ESLint/Prettier/tsconfig, vgl. Tz. 58) und im Entwicklungsverfahren benannt.                                                                                                                                                          |
| Versionsführung, abgegrenzte Releases                   | ✅     | Git-Historie, SemVer-Tags, signierte Update-Manifeste, Image-Digests, APP_VERSION/GIT_SHA im Produkt sichtbar (vgl. Tz. 59, 62 — Programmidentität ist besser gelöst als gefordert).                                                                        |
| Test-/Abnahmekonzept dokumentiert                       | ✅     | **Seit 2026-06-10:** `docs/development/testkonzept.md` (Testarten inkl. Negativ-/Schnittstellen-/Parametertests, Abdeckungsanspruch je Scope-Modul, Fehler-/Wiederholungstest-Prozess). Nebenbefund behoben: CI testet jetzt ALLE Pakete (vorher 4 von 11). |
| Testnachweise je Release, für Dritte nachvollziehbar    | ✅     | **Seit 2026-06-10:** CI archiviert Testprotokolle als Artefakte (`testbericht-unit/-ops/-db/-restore`, Playwright-Reports, Security-Logs); Nachweis-Kette Tag → Commit → CI-Lauf → Artefakte im Testkonzept beschrieben.                                    |
| Doku-Aktualisierung bei jeder Programmänderung          | ✅     | als Pflicht im Entwicklungsverfahren festgeschrieben (vgl. Tz. 63) und gelebt.                                                                                                                                                                              |
| Kontrollumfeld-Risiken (Personal, Technologie)          | 🟡     | Bus-Faktor 1 ist der relevante Risikoindikator (vgl. Tz. 53) — HANDOFF.md mildert; ehrlich dokumentieren statt verstecken.                                                                                                                                  |

### 3.3 Programmfunktionen im Scope (vgl. Tz. 25–36)

| Anforderung                                   | Status | Befund                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unveränderlichkeit/Protokollierung            | ✅     | Audit-Hash-Chain (append-only, Trigger), Object-Lock, RFC-3161-Versiegelung, Stammdaten-Änderungsprotokoll, täglicher Verify-Job, monatlicher Restore-Drill — Vorzeigebereich.                                                                                                                                                                                                                                                                                                               |
| Zugriffsschutzsystem                          | ✅/🟡  | Rollen, TOTP-Pflicht, RLS-Backstop, Portal-/Staff-Trennung, Lockout. Passwort-Policy dokumentieren und begründen (TOTP-Zweitfaktor statt Ablauf/Historie — bewusste, zu erläuternde Abweichung von klassischen Beispielen in Tz. 35).                                                                                                                                                                                                                                                        |
| Eingabe-/Verarbeitungs-/Ausgabekontrollen     | 🟡     | Vorhanden (zod-Validierung, Magic-Byte-Checks, Plausibilitäten), aber nicht als Kontrollsystem **beschrieben** — die Aufbauprüfung (vgl. Tz. 14, 64 ff.) arbeitet auf der Doku, nicht auf dem Code.                                                                                                                                                                                                                                                                                          |
| **Fakturierung: Belegnummern/Festschreibung** | ✅     | **Seit 2026-06-10 (iter85):** automatische, lückenlose Nummernvergabe je Tenant+Jahr (Sequenz, atomar in der Anlage-Tx — Lücken-Auswertung damit obsolet, Lücken können nicht entstehen); DB-seitige Festschreibung nach Versand (Felder + Positionen, auch für Owner); Status-Matrix nur vorwärts; GoBD-Archivkopie ist Pflicht VOR dem Versand; abgerechnete Zeiteinträge unlöschbar. Details + bewusste Grenzen (USt-Kategorien, Stornobeleg): `docs/development/module/fakturierung.md`. |

### 3.4 Prüfungsorganisatorisches (vgl. Tz. 44 f., 56, 88 f.)

| Anforderung                                  | Status | Befund                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definiertes Testsystem mit Stammdatenbestand | 🟡     | setup.sh + Demo-Seed existieren; als „Prüfumgebung" beschreiben (Hardware/OS/DB-Angaben für den Bericht, vgl. Tz. 89) und Seed ggf. um prüfungsrelevante Fälle erweitern (vgl. Tz. 56).                                                                  |
| Änderungsdokumentation                       | ✅     | `CHANGELOG.md` führt bis zum ersten echten Release den `[Unreleased]`-Arbeitsstand und danach versionierte Abschnitte; scope-relevante Änderungen sind mit `[Scope]` gekennzeichnet (Pflegeregel: Eintrag entsteht mit der Änderung; vgl. Tz. 110, 113). |
| Vollständigkeitserklärung, Auftragsinhalte   | —      | Sache der Beauftragung (vgl. Tz. 44); kein Repo-Artefakt.                                                                                                                                                                                                |

## 4. Maßnahmenstand und verbleibende Arbeiten

**P1 — Fundament: umgesetzt.** Entwicklungs-, Wartungs-, Test- und
Freigabeverfahren sind unter `docs/development/` beschrieben; CI erzeugt
Testnachweise, und der Scope ist in Abschnitt 2 festgeschrieben.

**P2 — Substanz im beschlossenen Scope: umgesetzt.** Anwenderdokumentation,
technische Modulbeschreibungen, Traceability und CHANGELOG-Prozess sind im Repo
vorhanden. Vor einer Beauftragung ist ihre Vollständigkeit gegen den konkreten
Prüfungsauftrag noch einmal gemeinsam mit dem Prüfer abzugrenzen.

**P3 — Technische GoB-Kontrollen der Fakturierung: umgesetzt.** Atomare
Nummernvergabe, Festschreibung nach Versand, Storno-Workflow und
Verfahrensdokumentation sind vorhanden; die Grenzen sind in der technischen
Modulbeschreibung festgehalten.

**Vor Prüferkontakt verbleibt:**

1. Prüfungsauftrag und Testsystem einschließlich Hardware-, OS-, DB-, Mengen-
   und Performance-Annahmen formal beschreiben.
2. Parameterreferenz konsolidieren sowie Passwort-/TOTP-Konzept und die
   Eingabe-, Verarbeitungs- und Ausgabekontrollen als Kontrollsystem
   zusammenhängend dokumentieren.
3. Nachweis-Matrix für den gewählten Release einfrieren und die Artefakte eines
   vollständigen, grünen Release-Laufs extern prüfbar bereitstellen.

**Pflegeregel ab sofort:** Jede Änderung an Scope-Funktionen aktualisiert die
zugehörige Anwender- und Technikdoku **im selben Commit** — das ist nicht
Kür, sondern Prüfvoraussetzung (vgl. Tz. 63) und bei uns ohnehin Kultur.

## 5. Realistische Einschätzung

Technisch stark belegt sind Versionsführung, Schutz vor unbemerkter Änderung,
Testpraxis und betriebliche Restore-Nachweise. Die früheren Lücken bei
Anwenderdokumentation und Fakturierungs-Festschreibung sind geschlossen.
Verbleibend sind vor allem die prüfungsauftragsspezifische Formalisierung, eine
reproduzierbar beschriebene Prüfumgebung und die Konsolidierung einzelner
Kontrollbeschreibungen. Das schafft eine gute Ausgangslage, ersetzt aber weder
die unabhängige Prüfung noch eine Softwarebescheinigung; deren Erteilung kann
nur der beauftragte Prüfer nach Festlegung des konkreten Scopes beurteilen.
