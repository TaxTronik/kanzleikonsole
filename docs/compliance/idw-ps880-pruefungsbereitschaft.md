# Prüfungsbereitschaft IDW PS 880: Gap-Analyse und Maßnahmenplan

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

| Modul/Funktion | Begründung |
|---|---|
| **Fakturierung** (Rechnungen inkl. XRechnung/ZUGFeRD) | einzige Funktion mit direktem Rechnungslegungsbezug (Belegfunktion) — hier gelten die strengsten Kriterien (vgl. Tz. 25 ff.) |
| **Dokumentenarchiv** (GoBD-Tier, Object-Lock, Virenscan) | Aufbewahrung/Unveränderlichkeit ist das zentrale Kaufargument |
| **Audit-Protokollierung** (Hash-Chain, Versiegelung, Verify) | trägt Nachvollziehbarkeit und Unveränderlichkeit für alles andere |
| **Zugriffsschutzsystem** (Rollen, TOTP, RLS, Portal-Trennung) | programminternes Kontrollsystem, wird in jedem Scope mitgeprüft (vgl. Tz. 10, 35) |
| Backup/Restore inkl. Drill | Sicherheit der Daten (vgl. Tz. 33) — bereits stark nachweisbar |

Bewusst zunächst **außerhalb**: BWA, Workflows, Subsumtion/TCMS, n8n-Flows,
Portal-Fachfunktionen. Sie bleiben über die Abgrenzung im Auftrag und im
Bericht ausklammerbar (vgl. Tz. 44, 88) und können in Folgeprüfungen
nachgezogen werden.

## 3. Gap-Analyse

Status: ✅ vorhanden und prüfungstauglich · 🟡 vorhanden, aber formalisieren ·
🔴 fehlt.

### 3.1 Verfahrensdokumentation (vgl. Tz. 49 — gilt unabhängig vom Scope)

| Bestandteil | Status | Befund |
|---|---|---|
| Technische Dokumentation | 🟡 | architecture.md, 12+ ADRs, FEATURES.md, Prisma-Schema, dichte Code-Kommentare. Fehlt: ein zusammenführendes Dokument je Scope-Modul (Datenmodell, Verarbeitungslogik, Schnittstellen, Kontrollen) — der Prüfer darf nicht auf Code-Lektüre angewiesen sein. |
| Betriebsdokumentation | ✅/🟡 | README-Produktivbetrieb, release.md, disaster-recovery.md, Verfahrensdoku-Generator, Runbooks. Fehlt: Mengen-/Performance-Annahmen, vollständige Parameter-Referenz (.env-Optionen sind dokumentiert, aber verstreut). |
| **Anwenderdokumentation** | 🔴 | **Größte Einzellücke.** Es existiert kein Benutzerhandbuch (Bedienung der Module für Kanzlei-Mitarbeiter, Admin-Handbuch). Fehlende oder stark lückenhafte Anwenderdoku ist ein Beispiel für schwerwiegende Mängel, die die Bescheinigung gefährden (vgl. Tz. 81). |

### 3.2 Softwareentwicklungsverfahren (vgl. Tz. 50–63)

| Anforderung | Status | Befund |
|---|---|---|
| Beschriebenes Entwicklungs-/Wartungs-/Freigabeverfahren | 🟡 | Faktisch vorhanden und stark (CI-Gates, Reviews, Guard-Tests, Release-Pipeline) — aber nirgends als Verfahren **beschrieben** (Rollen, Phasen, Genehmigung von Änderungen, Hotfix-Pfad, Freigabe = Tag durch wen?). |
| Programmierstandards/Namenskonventionen | 🟡 | ESLint/Prettier/tsconfig erzwingen sie maschinell (vgl. Tz. 58 — genau das gewünschte Muster); kurzes Standards-Dokument fehlt, das sie benennt und auf die Configs verweist. |
| Versionsführung, abgegrenzte Releases | ✅ | Git-Historie, SemVer-Tags, signierte Update-Manifeste, Image-Digests, APP_VERSION/GIT_SHA im Produkt sichtbar (vgl. Tz. 59, 62 — Programmidentität ist besser gelöst als gefordert). |
| Test-/Abnahmekonzept dokumentiert | 🔴 | 700+ automatisierte Tests inkl. Negativ-, RLS-, Restore- und Upgrade-Pfad-Tests existieren — aber **kein Testkonzept-Dokument** (Testarten, Abdeckungsanspruch, Schnittstellen-/Parametertests, Fehlerbehebungs- und Wiederholungstest-Prozess; vgl. Tz. 60, 69 ff.). |
| Testnachweise je Release, für Dritte nachvollziehbar | 🔴 | CI-Läufe beweisen die Ausführung, werden aber nicht als **Release-Artefakt archiviert** (Testbericht: was lief, erwartet vs. erzielt, Abdeckung). |
| Doku-Aktualisierung bei jeder Programmänderung | 🟡 | Gelebt (Doku-Updates in denselben Commits), aber als Pflicht nirgends festgeschrieben (vgl. Tz. 63). |
| Kontrollumfeld-Risiken (Personal, Technologie) | 🟡 | Bus-Faktor 1 ist der relevante Risikoindikator (vgl. Tz. 53) — HANDOFF.md mildert; ehrlich dokumentieren statt verstecken. |

### 3.3 Programmfunktionen im Scope (vgl. Tz. 25–36)

| Anforderung | Status | Befund |
|---|---|---|
| Unveränderlichkeit/Protokollierung | ✅ | Audit-Hash-Chain (append-only, Trigger), Object-Lock, RFC-3161-Versiegelung, Stammdaten-Änderungsprotokoll, täglicher Verify-Job, monatlicher Restore-Drill — Vorzeigebereich. |
| Zugriffsschutzsystem | ✅/🟡 | Rollen, TOTP-Pflicht, RLS-Backstop, Portal-/Staff-Trennung, Lockout. Passwort-Policy dokumentieren und begründen (TOTP-Zweitfaktor statt Ablauf/Historie — bewusste, zu erläuternde Abweichung von klassischen Beispielen in Tz. 35). |
| Eingabe-/Verarbeitungs-/Ausgabekontrollen | 🟡 | Vorhanden (zod-Validierung, Magic-Byte-Checks, Plausibilitäten), aber nicht als Kontrollsystem **beschrieben** — die Aufbauprüfung (vgl. Tz. 14, 64 ff.) arbeitet auf der Doku, nicht auf dem Code. |
| **Fakturierung: Belegnummern** | 🔴 zu klären | Rechnungsnummern sind tenant-eindeutig (DB-Unique-Constraint), CANCELLED-Status existiert. **Zu verifizieren/ergänzen:** automatische lückenlose Vergabe je Nummernkreis, Lücken-Auswertung, Schreibschutz nach Versand (Festschreibung), Storno statt Änderung (vgl. Tz. 27, 30). Das ist der einzige Bereich, in dem vermutlich **Produktfunktionen** fehlen, nicht nur Doku. |

### 3.4 Prüfungsorganisatorisches (vgl. Tz. 44 f., 56, 88 f.)

| Anforderung | Status | Befund |
|---|---|---|
| Definiertes Testsystem mit Stammdatenbestand | 🟡 | setup.sh + Demo-Seed existieren; als „Prüfumgebung" beschreiben (Hardware/OS/DB-Angaben für den Bericht, vgl. Tz. 89) und Seed ggf. um prüfungsrelevante Fälle erweitern (vgl. Tz. 56). |
| Änderungsdokumentation je Release | 🟡 | Tag-Annotationen + signierte Manifeste vorhanden; strukturiertes CHANGELOG mit Kennzeichnung scope-relevanter Änderungen einführen (Basis für Folgeprüfungen, vgl. Tz. 110, 113). |
| Vollständigkeitserklärung, Auftragsinhalte | — | Sache der Beauftragung (vgl. Tz. 44); kein Repo-Artefakt. |

## 4. Maßnahmenplan

**P1 — Fundament (vor jedem Prüferkontakt):**
1. `docs/development/entwicklungsverfahren.md`: Entwicklungs-, Wartungs-,
   Test- und Freigabeverfahren als beschriebenes Verfahren (Rollen,
   Änderungsweg Issue→Review→CI→Tag, Hotfix-Pfad, Doku-Pflicht je Änderung).
2. `docs/development/testkonzept.md`: Testarten, Abdeckungsanspruch je
   Scope-Modul, Negativ-/Schnittstellen-/Parametertests, Fehler- und
   Wiederholungstest-Prozess — plus CI-Job, der je Release einen
   **Testbericht als Artefakt** archiviert (Testliste, Ergebnisse, Coverage).
3. Scope-Entscheidung treffen (Abschnitt 2) und hier festschreiben.

**P2 — Substanz (der große Block):**
4. **Anwenderdokumentation** für die Scope-Module (Benutzerhandbuch +
   Admin-Handbuch), versioniert im Repo, Aktualisierung pro Release Pflicht.
5. Technische Modulbeschreibungen für den Scope (Datenmodell, Abläufe,
   Schnittstellen, programminterne Kontrollen) als Aufbauprüfungs-Grundlage.
6. Traceability je Scope-Modul: Anforderung → Implementierung → Testfälle
   (Tabelle reicht; keine Tool-Orgie).
7. CHANGELOG-Prozess mit Kennzeichnung scope-relevanter Änderungen.

**P3 — Produkt (Fakturierung GoB-fest):**
8. Belegnummernkreis mit automatischer lückenloser Vergabe + Lückenreport,
   Festschreibung nach Versand, Storno-Workflow — erst Code-Befund erheben,
   dann gezielt nachrüsten.
9. Verfahrensdoku-Generator um Verweise auf die neuen Dokumente erweitern.

**Pflegeregel ab sofort:** Jede Änderung an Scope-Funktionen aktualisiert die
zugehörige Anwender- und Technikdoku **im selben Commit** — das ist nicht
Kür, sondern Prüfvoraussetzung (vgl. Tz. 63) und bei uns ohnehin Kultur.

## 5. Realistische Einschätzung

Stärkster Block: Versionsführung, Unveränderlichkeit, Test-*Praxis*,
Betriebsnachweise (Drill!) — hier sind wir über dem üblichen Niveau geprüfter
Produkte. Schwächster Block: Anwenderdokumentation (existiert nicht) und die
Formalisierung dessen, was wir längst tun. Einzige echte Produktlücke
voraussichtlich die Fakturierungs-Festschreibung. Mit P1+P2 für den
vorgeschlagenen Scope ist Prüfungsbereitschaft realistisch erreichbar, ohne
die Architektur anzufassen.
