# Prüfungsbereitschaft IDW PS 880: Gap-Analyse und Maßnahmenplan

- **Arbeitsstand:** 2026-08-23
- **Dokumenttyp:** interne Gap-Analyse, kein Prüfungsbericht und keine
  Softwarebescheinigung
- **Bezugsfassung:** IDW PS 880 n.F. (01.2022), Stand 24.01.2022

Die Bezugsfassung wurde am 2026-08-23 gegen die
[offizielle Einzelseite des IDW](https://www.idw.de/idw/idw-verlautbarungen/idw-eps-880-n-f-03-2021.html)
und die
[aktuelle Liste der IDW-Verlautbarungen](https://www.idw.de/idw/idw-verlautbarungen/aktuelle-liste/)
geprüft. Der Volltext ist nicht Bestandteil dieses Repositorys.

**Ziel:** Dieses Dokument ordnet vorhandene Repository-Nachweise vorsichtig
den erwarteten Themen einer Softwareproduktprüfung zu, benennt Lücken und
bereitet eine spätere Abstimmung mit einem unabhängigen Prüfer vor. Statuswerte
sind interne Arbeitseinschätzungen. Sie sind weder ein Prüfungsurteil noch die
Zusicherung, dass eine Bescheinigung erteilt wird.

> **Quellenregel:** Der Prüfungsstandard wird hier ausschließlich per
> Fundstelle referenziert. Sein Wortlaut ist urheberrechtlich geschützt und
> wird in diesem Repository nicht wiedergegeben. Die folgenden
> Zusammenfassungen sind eigene Arbeitsformulierungen und im Prüfungsauftrag
> mit dem beauftragten Prüfer abzugleichen.

## 1. Arbeitsmodell der Prüfung

Für die interne Vorbereitung wird der Prüfungsweg in vier Arbeitsbereiche
gegliedert (vgl. insbesondere Tz. 11 ff., 49 ff. und 64 ff.):

1. Produkt, Prüfungsumfang, Entwicklungsumgebung und Dokumentation abgrenzen.
2. Entwicklungs-, Wartungs-, Test- und Freigabeverfahren beurteilen.
3. Dokumentierte fachliche Anforderungen und Kontrollen nachvollziehen.
4. Die Umsetzung anhand belastbarer Test- und sonstiger Nachweise prüfen.

Diese Gliederung ist eine Planungshilfe und ersetzt nicht die Methodik oder
Ermessensentscheidung des Prüfers. Code, Dokumentation und tatsächlich
ausgeführte Nachweise müssen für einen **konkret benannten Release**
zusammenpassen. Repository-Dateien allein beweisen noch keine wirksame
Durchführung.

Für spätere Folgeprüfungen ist zusätzlich eine eindeutige
Änderungsdokumentation zwischen dem bereits geprüften und dem neuen Stand
erforderlich (vgl. Tz. 109 ff.). Tags, signierte Manifeste und Image-Digests
sind dafür technische Bausteine; die eingefrorene Differenz- und
Release-Evidence-Matrix fehlt bis zu ihrer tatsächlichen Befüllung weiterhin.

## 2. Vorgesehener Prüfungsumfang

Der am 2026-06-10 intern festgelegte **Vorschlag** für den ersten
Prüfungsumfang umfasst:

| Modul/Funktion                                                      | Interne Begründung                                                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Fakturierung** (Rechnungen inkl. XRechnung/ZUGFeRD)               | rechnungslegungsnahe Beleg-, Status-, Festschreibungs- und Archivierungsfunktionen |
| **Dokumentenarchiv** (GoBD-Tier, Object Lock, Virenscan)            | Aufbewahrung, Schutzstufen, Unveränderlichkeit und kontrollierte Ausgabe           |
| **Audit-Protokollierung** (Hash-Chain, Versiegelung, Verify)        | Nachvollziehbarkeit von Fach- und Administrationsereignissen                       |
| **Zugriffsschutzsystem** (Rollen, TOTP/FIDO2, RLS, Portal-Trennung) | programmierte Kontrollen, die auch die übrigen Scope-Funktionen schützen           |
| **Backup/Restore einschließlich Drill**                             | Wiederherstellbarkeit, Integritätskontrollen und betriebliche Datensicherheit      |

Die endgültige Abgrenzung ist Bestandteil des Prüfungsauftrags (vgl. Tz. 44, 88) und kann vom Prüfer abweichend beurteilt werden. BWA, Workflows,
Subsumtion/TCMS, n8n-Flows und Portal-Fachfunktionen sind in diesem internen
Vorschlag zunächst nicht enthalten.

### 2.1 Auslieferungskanal und Programmidentität

Der formale Nachweisumfang gilt ausschließlich für den
`TAXTRONIK_DEPLOY_CHANNEL=release`: annotierter SemVer-Tag, vollständiger
Release-CI-Lauf, signiertes Manifest sowie digest-gepinnte Web- und
Worker-Images müssen auf denselben Commit zeigen.

Der unterstützte `source`-Kanal baut dagegen lokal aus einem Checkout. Er ist
ein betrieblicher Installationsweg, aber **kein** automatisch gleichwertiger
PS-880-Release-Nachweis. Ein Source-Deployment darf nur dann in einen
Prüfungsumfang aufgenommen werden, wenn Checkout, Buildumgebung, erzeugte
Digests, Tests, Abweichungen und Freigabe gesondert eingefroren werden. Bis
dahin ist er vom formalen Scope ausgeschlossen.

## 3. Statuslogik

- ✅ **Repository-intern belegt:** Beschreibung und technische Nachweise sind
  auffindbar. Das Symbol ist kein externes Prüfungsurteil.
- 🟡 **teilweise/formalisieren:** Mechanismen oder Dokumente bestehen, aber
  Vollständigkeit, Wirksamkeitsnachweis, Release-Bindung oder Freigabe fehlen.
- 🔴 **offen:** der erforderliche Nachweis oder Prozess ist noch nicht
  vorhanden beziehungsweise noch nicht durchgeführt.
- — **außerhalb des Repository-Nachweises:** Bestandteil von Auftrag,
  Erklärung oder unabhängiger Prüfung.

## 4. Gap-Analyse

### 4.1 Verfahrensdokumentation (vgl. Tz. 49)

| Bestandteil              | Status | Repository-Nachweis und Grenze                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Technische Dokumentation | 🟡     | [Architektur](../architecture.md), ADRs, `FEATURES.md`, Prisma-Schema und Scope-Modulbeschreibungen sind vorhanden. Der [Fachkatalog](../fachkatalog/README.md) startet die regelweise Traceability; seine ersten Regeln sind bis zum Berufsträger-Review ausdrücklich nicht fachlich freigegeben. Eine vollständige Querschnittsmatrix aller Eingabe-, Verarbeitungs- und Ausgabekontrollen fehlt noch. |
| Betriebsdokumentation    | 🟡     | Release-, Backup-, Restore- und Day-2-Runbooks bestehen. Mengen-/Performance-Annahmen, konsolidierte Parameterreferenz und die installationsabhängigen externen Datenflüsse müssen für das konkrete Prüfsystem eingefroren werden.                                                                                                                                                                       |
| Anwenderdokumentation    | 🟡     | Das Benutzerhandbuch beschreibt zentrale Scope- und weitere Module. Vollständigkeit für jede Rolle, Bedienvariante und Fehlersituation ist noch nicht formal abgenommen; der Fachkatalog ersetzt keine Bedienungsanleitung.                                                                                                                                                                              |
| Dokumentenlenkung        | 🟡     | Dokumenttypen, Änderungspflicht und Archivierung sind im Entwicklungsverfahren beschrieben. Eine technisch erzwungene personenbezogene Freigabe, `CODEOWNERS`-Regel oder vollständig gepflegte Owner-/Review-Metadaten je Dokument bestehen noch nicht.                                                                                                                                                  |

### 4.2 Entwicklungs-, Wartungs-, Test- und Freigabeverfahren (vgl. Tz. 50–63)

| Anforderung                                     | Status | Repository-Nachweis und Grenze                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entwicklungs-/Wartungsverfahren beschrieben     | ✅     | [Entwicklungsverfahren](../development/entwicklungsverfahren.md) beschreibt Rollen, Änderungsweg, Hotfix, KI-Assistenz, Tests und Dokumentationspflicht. Die geringe personelle Trennung bleibt als Risiko ausgewiesen.                                                                       |
| Programmierstandards und Namenskonventionen     | ✅     | TypeScript strict, ESLint, Prettier, Strukturkonventionen und Guard-Tests werden in CI geprüft.                                                                                                                                                                                               |
| Versionsführung und abgegrenzte Releases        | 🟡     | Git, SemVer-Tags, signierte Manifeste und Image-Digests ermöglichen eindeutige Identität im Release-Kanal. Die Changelog-Historie kennzeichnet den nie getaggten `0.2.0`-Kandidaten nun ausdrücklich; ein vollständiges Evidence-Bundle für einen Prüf-Release fehlt.                         |
| Test-/Abnahmekonzept dokumentiert               | 🟡     | Das [Testkonzept](../development/testkonzept.md) beschreibt Testarten und das Scope-Soll. Offene Action-Level-Tests werden dort ausdrücklich genannt; deshalb ist noch keine vollständige Scope-Testfreigabe belegt.                                                                          |
| Testnachweise je Release für Dritte             | 🟡     | CI erzeugt Logs und Artefakte. Eine feste Aufbewahrungsanforderung wird im Workflow angefordert, ersetzt aber keine langfristige, unveränderliche Prüferablage. Die [Release-Evidence-Vorlage](../assurance/ps880-release-evidence.md) ist erst mit realen Hashes und Freigaben ein Nachweis. |
| Dokumentation mit Programmänderung aktualisiert | 🟡     | Die Pflicht und der Fachkatalog-Diff-Guard bestehen. Fachliche Freigaben bleiben menschlich; ein allgemeiner Link-Guard schützt nur die technische Navigierbarkeit, nicht die inhaltliche Aktualität.                                                                                         |
| Kontrollumfeld-Risiken                          | 🟡     | Aktuelle Übergabedokumentation reduziert Such- und Einarbeitungsrisiken. Sie beseitigt weder den Bus-Faktor noch fehlende organisatorische Stellvertretung oder unabhängige Fachfreigabe.                                                                                                     |

### 4.3 Programmfunktionen im vorgeschlagenen Scope (vgl. Tz. 25–36)

| Anforderung                                   | Status | Repository-Nachweis und Grenze                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unveränderlichkeit und Protokollierung        | 🟡     | Hash-Kette, Object-Lock-Pfade, RFC-3161-Anker, Verify-Jobs und Restore-Drills sind implementiert und getestet. Für den Prüf-Release fehlen noch installationsbezogene Nachweise zu aktivem Object Lock, TSA-Vertrauenskette, ausgeführten Läufen und behandelten Abweichungen.                                                                                                                                                                                                                  |
| Zugriffsschutzsystem                          | 🟡     | Rollen, Standardmodus Passwort/TOTP, optionaler FIDO2-Hardware-only-Modus, RLS, Portal-/Staff-Trennung und Lockout sind beschrieben und getestet. Direkte vollständige Attestation, Deployment-AAGUID-Allowlist, FIDO MDS `strict`, fail-closed Assertion, Recovery sowie die Grenze „Modellfamilie statt individuelle Geräteinstanz“ stehen in der [Modulbeschreibung](../development/module/zugriffsschutz.md); MDS-Betrieb und Wirksamkeit im eingefrorenen Prüfsystem bleiben nachzuweisen. |
| Eingabe-/Verarbeitungs-/Ausgabekontrollen     | 🟡     | Zod-Validierung, Magic-Byte-Prüfungen, Plausibilitäten, Zustandsautomaten und Autorisierungstests bestehen verteilt. Eine vollständige, vom Berufsträger beurteilbare Querschnittsmatrix ist noch offen.                                                                                                                                                                                                                                                                                        |
| Fakturierung: Nummern, Festschreibung, Storno | 🟡     | Nummernvergabe, Festschreibung, Statusmatrix, Archivierung und E-Rechnungs-Generatoren sind beschrieben und überwiegend getestet. Die im Testkonzept genannten Action-Level-Lücken und die Release-Evidence müssen vor einer vollständigen Scope-Freigabe geschlossen sein.                                                                                                                                                                                                                     |

### 4.4 Prüfungsorganisation

| Anforderung                                  | Status | Repository-Nachweis und Grenze                                                                                                                                                                                                      |
| -------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Definiertes Testsystem mit Stammdatenbestand | 🟡     | Setup und Demo-Seed sind vorhanden. [Prüfumgebung](../assurance/pruefumgebung.md) ist eine auszufüllende Vorlage; Hardware, OS, Images, Seed-Hash, Mengengerüst und Erwartungswerte sind für den konkreten Lauf noch nicht erfasst. |
| Änderungsdokumentation                       | 🟡     | `CHANGELOG.md`, Git-Historie, Scope-Markierungen und Fachkatalog-Änderungen bilden eine Grundlage. Erst die eingefrorene Differenz zu einem benannten geprüften Release ist ein Folgeprüfungsnachweis.                              |
| Release-Evidence und Aufbewahrung            | 🔴     | Die Vorlage existiert, aber noch kein vollständig befülltes, extern zugängliches und gegen nachträgliche Änderung geschütztes Evidence-Bundle. CI-Artefakte allein sind zeitlich begrenzt und von der Forgejo-Instanz abhängig.     |
| Vollständigkeitserklärung und Auftragsinhalt | —      | Mit Prüfer und Auftraggeber zu vereinbaren; kein durch Code oder Repository ersetzbarer Nachweis.                                                                                                                                   |

## 5. Maßnahmenplan vor Prüferkontakt

1. Prüfungsauftrag, endgültigen Funktionsumfang, Release-Kanal und explizite
   Ausschlüsse mit dem Prüfer abstimmen.
2. Die Vorlage [Prüfumgebung](../assurance/pruefumgebung.md) für einen
   unveränderlich identifizierten Release vollständig befüllen und die
   erwarteten Seed-/Testfälle fachlich abnehmen.
3. Die Action-Level-Lücken der Fakturierung und weitere Scope-Lücken aus dem
   Testkonzept schließen; vollständigen Release-CI-Lauf wiederholen.
4. Eingabe-, Verarbeitungs- und Ausgabekontrollen als zusammenhängende
   Querschnittsmatrix dokumentieren und durch einen Berufsträger beurteilen.
5. Fachkatalogregeln im vorgesehenen Scope durch Berufsträger prüfen; Status,
   Inhalts-Hash, Reviewer und Datum ohne KI-Selbstfreigabe festhalten.
6. [Release-Evidence](../assurance/ps880-release-evidence.md) mit Commit,
   Digests, Artefakt-Hashes, KoSIT-/SBOM-/Security-Nachweisen, Abweichungen und
   tatsächlicher Freigabe befüllen und nach der vereinbarten Frist in einer
   unveränderlichen, für den Prüfer zugänglichen Ablage sichern.
7. Parameter, externe Datenflüsse, Mengen-/Performance-Annahmen und Known
   Limits für genau diese Installation einfrieren.

## 6. Realistische Einschätzung

Die technischen Grundlagen für Versionsidentität, automatisierte Tests,
Mandantentrennung, Festschreibung, Protokollierung und Restore-Prüfungen sind
umfangreich. Die wesentlichen offenen Punkte liegen in der vollständigen
fachlichen Freigabe, der installations- und releasebezogenen Beweisführung,
einzelnen direkten Funktionstests sowie der langfristigen Dokumentenlenkung.

Damit besteht eine gute Vorbereitung, aber noch **keine nachgewiesene
Prüfungsbereitschaft und keine Softwarebescheinigung**. Eine solche Aussage
kann erst nach Festlegung des Auftrags und Durchführung durch einen
unabhängigen Prüfer getroffen werden.
