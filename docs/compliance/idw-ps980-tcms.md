# TCMS nach IDW PS 980: Einordnung, Fähigkeiten-Mapping und Teilbereich Organschaft

Arbeitsstand: 2026-06-10. Bezugsrahmen ist der IDW PS 980 n.F. (09.2022);
alle Tz.-Angaben verweisen auf diesen Standard. Fachliche Grundlage des
Organschafts-Teils: Koxha, Steuerartenübergreifende Risikosteuerung der
Organschaft, DStR (im Erscheinen).

## 1. Einordnung: Was geprüft wird — und was TaxTronik dabei ist

Eine CMS-Prüfung nach PS 980 ist eine Systemprüfung: Geprüft wird die von
den gesetzlichen Vertretern aufgestellte **CMS-Beschreibung** (vgl. Tz. 15)
— nicht die Software und nicht die tatsächliche Einhaltung einzelner Regeln
(vgl. Tz. 21). Die Verantwortung für das CMS, seine Beschreibung und die
Abgrenzung prüfbarer **Teilbereiche** liegt bei den gesetzlichen Vertretern
(vgl. Tz. 13d), 16). Geprüft wird wahlweise die Angemessenheit zu einem
Stichtag oder zusätzlich die Wirksamkeit über einen Zeitraum, der
regelmäßig mindestens ein halbes Geschäftsjahr abdeckt (vgl. Tz. 17–19,
61); eine projektbegleitende Angemessenheitsprüfung während des Aufbaus
ist zulässig (vgl. Tz. 20).

Daraus folgt die Rollenverteilung: **TaxTronik ist nicht das CMS** — es ist
das Werkzeug, mit dem eine Kanzlei (für sich oder als Dienstleister ihrer
Mandanten) Regelungen eines Steuer-CMS implementiert, betreibt und vor
allem **nachweist**. Der Wert für eine PS-980-Prüfung liegt in der
Evidenz: personenunabhängig dokumentierte Abläufe (vgl. Tz. 16),
manipulationssichere Protokolle und reproduzierbare Kontrollnachweise über
den gesamten Wirksamkeitszeitraum.

## 2. Mapping: Grundelemente (vgl. Tz. 27) ↔ TaxTronik-Bausteine

| Grundelement | Was der Standard erwartet (sinngemäß) | TaxTronik heute |
|---|---|---|
| Compliance-Kultur | Grundhaltung des Managements, Verankerung der Regelbeachtung | Organisatorisch, nicht Software. Unterstützend: erzwungene Vier-Augen-Prinzipien (Urlaubsentscheidung, Katalog-Review), Festschreibungs- und GwG-Schranken, die sich auch von Admins nicht umgehen lassen |
| Compliance-Ziele | Festlegung der Regelungsbereiche und einzuhaltenden Regeln | Modul-/Mandantenkonfiguration je Tenant; Risiko-/Normenkatalog der Signal-Engine mit auditiertem Freigabe-Workflow |
| Compliance-Risiken | Systematische Identifikation und Bewertung, inkl. Interdependenzen | Subsumtions-Workspace (deterministisch + semantisch + LLM, on-prem), Governance-Matrix je Markierung; **Lücke:** kein strukturiertes Risikoinventar mit Brutto-/Netto-Logik je Mandantenstruktur (→ Abschnitt 3) |
| Compliance-Programm | Regelungen zur Risikobegrenzung inkl. Konsequenzen bei Verstößen, dokumentiert | Workflows/Vorlagen, Anforderungen mit Fristen, Steuertermin-Engine, GoBD-Festschreibung, DB-erzwungene Schranken; Verfahrensdokumentation auf Knopfdruck aus dem IST-Zustand |
| Compliance-Organisation | Klare Rollen/Verantwortlichkeiten, Ressourcen, dokumentiert | Rollen + granulare Einzelrechte (iter87, auditiert), Mandanten-Zuständigkeiten (Berufsträger/Hauptbearbeiter), Zugriffsmodelle OPEN/RESTRICTED, Vertretungsansicht bei Abwesenheit |
| Compliance-Kommunikation | Information/Schulung der Betroffenen, Berichtswege für Risiken und Verstöße | Gezielte interne Benachrichtigungen (Entscheidungsträger-Adressierung), Eskalationen (GwG-Fristen, Überfälligkeiten), Portal-Kommunikation; Anwenderdoku versioniert mit der Software |
| Compliance-Überwachung und Verbesserung | Überwachung auf Basis ausreichender Dokumentation, Mängelberichtswege | Audit-Hash-Chain (RFC-3161-verankert) als manipulationssicheres Protokoll, Chain-Verifikation im Admin-Panel + CI, monatlicher Restore-Drill als Wirksamkeitsnachweis, Testberichte je CI-Lauf |

Querschnittsbefund: Die Stärken liegen in **Programm, Organisation und
Überwachung** — dort, wo Software Regelungen erzwingen und Nachweise
erzeugen kann. Kultur und Ziele bleiben naturgemäß beim Mandanten bzw. der
Kanzleileitung; die CMS-Beschreibung kann auf TaxTronik-Funktionen
verweisen, muss sie aber selbst einordnen.

## 3. Teilbereich Organschaft als erster Kontrollkreis

PS 980 erlaubt ausdrücklich die Prüfung abgegrenzter Teilbereiche (vgl.
Tz. 13d), A7). Die Organschaft eignet sich als erster Teilbereich eines
Steuer-CMS, weil ihre Fehlerquellen statusbezogen, steuerartenübergreifend
verkettet und überwiegend regelhaft kontrollierbar sind — die methodische
Grundlage liefert das vierdimensionale Risikomodell nebst fünfstufigem
Prüfraster von Koxha (DStR, im Erscheinen).

### 3.1 Übersetzung des Modells in Software (Konzept iter88)

Kerngedanke der Vorlage: Tatbestandsmerkmale werden zu Prüfpunkten,
Fehlerquellen zu Risikosignalen, Governance-Typen zu Prüfzyklen, inhärente
Restrisiken zu dokumentierten Aufklärungspflichten. Das bildet TaxTronik
so ab:

**Datenmodell**

- `OrganschaftGroup` (Organkreis je Tenant): Organträger → Mandant,
  Organgesellschaften → Mandanten (n:m mit Rollen), je Steuerart
  (KSt/GewSt/USt) ein eigener Status; Stammdaten GAV (Abschlussdatum,
  Mindestlaufzeit-Ende), Stimmrechtsquote, Wirtschaftsjahr.
- `OrganschaftRiskItem` (Risikoinventar je Organkreis): Fehlerquelle aus
  dem Katalog (14 Startpositionen gemäß Vorlage), Dimensionen Phase
  (L/K/I), Kaskadenreichweite (1–3), Schadensintensität (1–3),
  Governance-Typ (FP/FF/IN); Brutto- und Netto-Risikoklasse werden
  **berechnet, nie gespeichert-überschrieben** (reine Funktion, testbar:
  Brutto = Schaden × Reichweite; FP senkt, IN hebt eine Stufe).
- `OrganschaftControl` (Kontrollpunkt): je Risikoposition der passende
  Kontrollzyklus — FP → periodische Wiedervorlage mit Prüfprotokoll
  (z. B. jährlicher GAV-Durchführungs-Check zum Jahresabschluss),
  FF → laufendes Trigger-Monitoring, IN → gegengezeichnete
  Risikoaufklärung als GoBD-archiviertes Dokument.
- `OrganschaftAssessment` (Prüfraster-Lauf): die fünf Stufen (Zugang →
  Vorteilhaftigkeit → Risiko → Governance → Empfehlung) als geführter
  Ablauf mit Pflichtdokumentation und Ampel-Ergebnis; jeder Lauf und jede
  Entscheidung in der Audit-Hash-Chain.

**Trigger statt Stichtag.** Die kritischen USt-Fehlerquellen verlangen
anlassbezogene Überwachung. TaxTronik kennt die Auslöser bereits oder kann
sie melden: Geschäftsführerwechsel (Mandanten-Stammdatenänderung →
Re-Check organisatorische Eingliederung), Strukturmaßnahmen (neues
Assessment Pflicht), Insolvenzanzeichen (manueller Trigger + Checkliste).
Trigger erzeugen gezielte Benachrichtigungen an die fachlich Zuständigen
(Berufsträger des Organträger-Mandats) und setzen den betroffenen
Kontrollpunkt auf „prüfen".

**Nachweisführung.** Jede Kontrolle erzeugt einen Audit-Eintrag mit
Ergebnis; Prüfprotokolle und Risikoaufklärungen liegen als GoBD-archivierte
Dokumente am Mandanten. Damit entsteht genau die personenunabhängige,
zeitraumbezogene Dokumentation, die eine Wirksamkeitsprüfung des
Teilbereichs voraussetzt (vgl. Tz. 16, 25, 61).

### 3.2 Was bewusst NICHT Software wird

Die Subsumtion im Einzelfall (greift eine Fehlerquelle bei dieser
Struktur?), die Bewertungs-Kalibrierung der Dimensionen und die
Empfehlung an den Mandanten bleiben fachliche Entscheidungen des Beraters
— TaxTronik strukturiert, erinnert, dokumentiert und eskaliert, ersetzt
aber keine Würdigung. Die Risikoklassen-Defaults des Katalogs sind je
Organkreis überschreibbar (mit Begründung, auditiert).

## 4. Maßnahmenplan

| # | Maßnahme | Status |
|---|---|---|
| P1 | Dieses Einordnungs-/Mapping-Dokument | ✅ |
| P2 | iter88: Datenmodell + Risikoinventar + Netto-Berechnung (reine Funktion + Wahrheitstabellen-Test) | offen |
| P3 | iter88: Kontrollzyklen (FP-Wiedervorlagen, FF-Trigger, IN-Aufklärungsdokument) + Benachrichtigungen | offen |
| P4 | iter88: Fünfstufiges Assessment als geführter Ablauf mit Audit-Chain-Anbindung | offen |
| P5 | Modulbeschreibung + Anwenderdoku-Kapitel, Traceability-Tabelle | offen |
| P6 | Muster-Baustein „CMS-Beschreibung Teilbereich Organschaft" (Textgerüst, das die Kanzlei je Mandant befüllt — Verantwortung bleibt gem. Tz. 16 bei den gesetzlichen Vertretern) | offen |

## 5. Realistische Einschätzung

Für eine Angemessenheitsprüfung des Teilbereichs Organschaft (vgl. Tz. 19)
liefert TaxTronik nach iter88 die Implementierungs- und Dokumentationsbasis;
projektbegleitend ist das schon während des Aufbaus prüfbar (vgl. Tz. 20).
Eine Wirksamkeitsprüfung setzt gelebte Kontrollen über mindestens ein
halbes Geschäftsjahr voraus (vgl. Tz. 61) — der Nachweiszeitraum beginnt
also erst mit produktiver Nutzung der Kontrollzyklen. Unverändert gilt:
Die CMS-Beschreibung und die Teilbereichs-Abgrenzung verantworten die
gesetzlichen Vertreter; TaxTronik liefert Struktur und Evidenz, nicht das
Urteil.
