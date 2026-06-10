# Intelligenter Posteingang: Architektur-Konzept

Arbeitsstand: 2026-06-10 (Rev. 2 nach Feedback). Status: **Konzept zur
Entscheidung** — noch keine Umsetzung. Ziel: Alles, was die Kanzlei
erreicht (Mail, Scan/UNC), läuft durch EINE Pipeline in EINE
Triage-Oberfläche und landet erst nach menschlicher Bestätigung im Archiv.

Rev.-2-Änderungen: Nextcloud-Kanal verworfen (redundant zum integrierten
Portal-Belegupload); Outlook als Add-In für persönliche Postfächer PLUS
zentrales Funktionspostfach (M365 als Regelfall); UNC mit vorgegebener
Soll-Struktur + Mapping für Bestandsstrukturen; Klassifikation mehrstufig
mit Vision-Stufe für Beleg-Scans inkl. Beleglisten-Export; explizites
VRAM-Budget (≤ 16 GB bzw. zwei Systeme).

## 1. Leitplanken

1. **Zwei Kanäle, eine Pipeline.** Eingangswege (Outlook, UNC) sind reine
   Connectoren — ab dem Staging ist alles identisch. Der Portal-Upload des
   Mandanten existiert bereits und bleibt eigenständig (Nextcloud wurde
   deshalb bewusst verworfen); er kann später als dritter Connector in
   dieselbe Triage münden.
2. **Mensch bestätigt, Maschine schlägt vor.** Schutzstufen (GoBD/GwG mit
   Object-Lock) sind irreversibel — automatische Ablage ohne Bestätigung
   wäre ein Compliance-Risiko. Die Pipeline liefert Vorschläge mit
   Konfidenz; die Ablage-Entscheidung trifft die Triage-Person, auditiert.
   Gleiches gilt für extrahierte ZAHLEN: sie sind Vorschlagswerte für ein
   Arbeitspapier, kein Buchungsersatz.
3. **Alles on-prem, GPU-bewusst.** OCR und alle LLM-Stufen laufen lokal.
   Budget: in einer Kanzlei selten mehr als **16 GB VRAM**, ggf. verteilt
   auf **zwei Systeme**. Die Pipeline ist deshalb durchgehend asynchron,
   batch-fähig und ohne Interaktiv-Latenz-Versprechen ausgelegt
   (Details Abschnitt 5).
4. **Deterministik vor KI, billig vor teuer.** Mehrstufige Klassifikation
   (Abschnitt 4): Pfad-/Stammdaten-Treffer zuerst, Text-Modelle vor
   Vision-Modellen, Vision nur für die Dokumente, die es brauchen.

## 2. Datenfluss

```
Outlook (Add-In + zentrales Postfach) ──┐
UNC/Scanner (Watcher) ──────────────────┼─▶ Connector (idempotent)
                                        │
                   ▼
            InboxItem (DB) + Rohobjekt im Staging-Bucket (SeaweedFS,
            OHNE Object-Lock — Staging ist verwerfbar)
                   │
                   ▼  BullMQ-Pipeline (mehrstufig, Abschnitt 4)
            Virenscan → Stufe 0..3 (deterministisch → Text → OCR → Vision)
                   │
                   ▼
            Triage-UI /staff/posteingang: Vorschau + Vorschlag
            (Mandant, Dokumenttyp/Belegkategorie, Schutzstufe, extrahierte
            Zahlen) → Bestätigen/Korrigieren/Ablehnen
                   │
                   ├─▶ Ablage als Document im Archiv (Schutzstufe greift
                   │   JETZT erst), Audit-Event; optional „Bescheid anlegen"
                   │   (vorausgefüllt) → Einspruchsfrist → Fristenkontrollbuch
                   └─▶ Beleglisten-Export (XLSX/CSV) je Mandant/Zeitraum
                       als Arbeitspapier-Grundlage (Abschnitt 4.4)
```

## 3. Die Kanäle im Detail

### 3.1 Outlook (M365 als Regelfall)

Zwei komplementäre Wege — beide münden in dieselbe Inbox-API:

**a) Outlook-Add-In für persönliche Postfächer (user-initiated push).**
Ein Office-Add-In (Office.js, Taskpane/Button „An TaxTronik übergeben"):
Der Mitarbeiter entscheidet PRO MAIL, was in die Kanzleisoftware geht —
es gibt kein Hintergrund-Auslesen persönlicher Postfächer (datenschutz-
und mitbestimmungsfreundlich by design). Das Add-In überträgt die
vollständige Mail (EML) + Anhänge an `/api/inbox/mail`, mit Vorbelegung
(Mandanten-Vorschlag aus Absender ↔ Portal-Kontakt) direkt im Taskpane.

- Verteilung: zentral über das M365 Admin Center (Centralized Deployment),
  ein Manifest für die ganze Kanzlei.
- Authentifizierung: einmalige Kopplung Add-In ↔ TaxTronik-Konto über
  einen Pairing-Code (erzeugt im Staff-Profil), danach personengebundenes
  API-Token im Add-In-Roaming-Storage. (Alternative SSO/Entra-ID ist eine
  spätere Ausbaustufe — Pairing funktioniert auch ohne App-Registrierung.)
- Das übertragende Konto wird am InboxItem vermerkt (Audit: wer hat
  eingeliefert).

**b) Zentrales Funktionspostfach (automatischer Connector).**
`eingang@kanzlei…` wird serverseitig abgeholt: bei M365 über **Graph API**
(Application Permission, per Application Access Policy strikt auf dieses
eine Postfach beschränkt, Delta-Query-Polling); IMAP bleibt als Fallback
für Nicht-M365-Umgebungen. Verarbeitete Mails wandern in einen
`Verarbeitet`-Ordner, nie löschen.

**GoBD:** Die E-Mail selbst kann Geschäftsbrief sein → EML als Original
plus Anhänge als Einzelobjekte; die Triage entscheidet, was abgelegt wird.

### 3.2 UNC-Pfad (Scanner / kanzleiinterne Struktur)

Praxisbefund: Bestandsstrukturen sind heterogen — getrennte Ordner für
Hauptmandate vs. „einfache" Mandate (z. B. ESt), daneben Hauptordner mit
Gruppen-Unterordnern (Gruppe 1 → Firma 1, Firma 2, …). Ein Connector kann
solche gewachsenen Strukturen nicht zuverlässig erraten. Deshalb
**beides**:

**a) Vorgegebene Soll-Struktur (Empfehlung für den Eingang).**
Der EINGANG bekommt eine schlanke, vorgeschriebene Struktur — unabhängig
davon, wie die Kanzlei ihre Bestandsablage organisiert:

```
\\server\taxtronik-eingang\
  _allgemein\               → keine Vorzuordnung, Triage entscheidet
  <Mandantennummer>\        → direkte Mandanten-Zuordnung
  <Mandantennummer>\belege\ → Mandant + Vorklassifikation „Beleg"
                              (aktiviert die Beleg-Pipeline, 4.3)
```

Begründung: Der Eingangsordner ist ein FLIESSBAND, kein Archiv — die
Datei verlässt ihn nach Verarbeitung wieder (`verarbeitet/`-Unterordner).
Die gewachsene Bestandsstruktur bleibt unangetastet; niemand muss seine
Ablage umbauen, nur der Scanner-/Einwurfpfad ist neu.

**b) Mapping-Tabelle für Bestandsstrukturen (Admin-Konfiguration).**
Wer zusätzlich aus bestehenden Strukturen einliefern will, pflegt
Pfadregeln (longest-prefix-Match) in einer Admin-Tabelle:

| Pfadmuster | Bedeutung |
|---|---|
| `Hauptmandate/Gruppe 1/Firma 2/**` | Mandant 10017 |
| `ESt-Mandate/**` | keine Mandanten-Zuordnung, Kategorie „ESt einfach" |
| `Scan/Allgemein/**` | wie `_allgemein` |

Unzugeordnetes landet als „unzugeordnet" in der Triage — nichts geht
verloren, nichts wird geraten.

**Technik:** Watcher-Sidecar mit CIFS-Mount (dedizierter Service-Account,
lesen + verschieben), Polling statt inotify (über SMB unzuverlässig),
Stabilitäts-Check vor dem Einlesen (Größe über zwei Polls konstant, damit
halbe Scans nicht eingelesen werden), Verschieben nach `verarbeitet/`.

### 3.3 Verworfen: Nextcloud

Bewusst gestrichen — der integrierte Portal-Belegupload deckt den
Mandanten-Upload bereits ab; ein zweiter Upload-Weg wäre redundant und
verwässert die Konvention „Mandanten liefern über das Portal".

## 4. Mehrstufige Klassifikation

Jede Stufe ist ein eigener Pipeline-Schritt; ein Item durchläuft nur die
Stufen, die es braucht. Billig vor teuer:

### Stufe 0 — deterministisch (kostenlos)
Pfad-Mapping (3.2), Dateiname, Absender ↔ Portal-Kontakt, sha256-Dedup,
MIME-Typ. Liefert: Mandanten-(Vor-)Zuordnung, ggf. Kategorie.

### Stufe 1 — Text geboren (billig)
PDFs mit Textebene (unpdf, vorhanden) und Office-Dateien (mammoth):
extrahierter Text → kleines **Text-LLM** (vorhandener llama-server)
klassifiziert Dokumenttyp (vorhandene classificationKeys), Absender,
Steuernummer, Datumsfelder, Bescheid-Indikator.

### Stufe 2 — OCR (mittel)
Scans ohne Textebene: **ocrmypdf/Tesseract-Container** (CPU, kein VRAM!)
erzeugt durchsuchbare PDFs → zurück in Stufe 1. Für saubere
Maschinen-Scans (Briefe, Bescheide) reicht das vollständig — die teure
Vision-Stufe bleibt diesen Dokumenten erspart.

### Stufe 3 — Vision (teuer, gezielt)
Für **Beleg-Scans und Fotos**, bei denen Layout/Struktur zählt
(Kassenbons, Eingangsrechnungen, Handschriftliches, abfotografierte
Belege) und für Items, bei denen Stufe 1/2 mit niedriger Konfidenz endet:
ein **Vision-LLM** (quantisiert, 7–8B-Klasse — passt einzeln in das
VRAM-Budget) liefert:

1. **Grob-Sortierung** in Belegkategorien (Eingangsrechnung,
   Ausgangsrechnung, Kassenbon, Bank, Vertrag, Bescheid, Sonstiges) —
   das „Vorsortieren in Ordner" passiert als Kategorisierung in TaxTronik,
   nicht als physisches Verschieben.
2. **Strukturierte Zahlen-Extraktion** je Beleg: Belegdatum, Aussteller,
   Brutto, Netto, USt-Satz/-Betrag, Belegnummer — jeweils mit Konfidenz.

### 4.4 Belegliste als Arbeitspapier

Aus den Stufe-3-Ergebnissen entsteht je Mandant/Zeitraum eine
**Belegliste** (Tabelle in der UI + **XLSX/CSV-Export**): eine Zeile pro
Beleg mit Kategorie, extrahierten Zahlen, Konfidenz und Link zum Dokument.
Zweck: Grundlage für Berechnungen/Arbeitspapiere (z. B. EÜR-Vorbereitung,
Belegsummen je Kategorie) — ausdrücklich als **Vorschlagswerte**
gekennzeichnet; niedrige Konfidenz wird markiert, die Prüfung bleibt beim
Bearbeiter. Korrekturen in der Triage fließen in die Liste zurück (und
liefern langfristig Trainings-/Evaluationsmaterial für Prompt-Tuning).

## 5. GPU-/VRAM-Budget

Annahme: **≤ 16 GB VRAM**, ein oder zwei Systeme. Konsequenzen:

- **Modellwahl:** quantisierte 7–8B-Modelle (Text UND Vision) à ~5–10 GB —
  es passt immer nur EIN Modell komfortabel in 16 GB.
- **Topologie A (ein System):** Text- und Vision-Modell teilen sich die
  GPU über **Model-Swapping** — der Risk-Layer startet seinen llama-server
  heute schon on-demand; die Posteingang-Pipeline nutzt denselben
  Mechanismus mit Lade-Scheduling (Queue serialisiert; Batch lädt das
  Vision-Modell EINMAL und arbeitet den Stapel ab, statt pro Beleg zu
  swappen). Nachts laufende Batches kollidieren nicht mit der
  interaktiven Subsumtion am Tag.
- **Topologie B (zwei Systeme):** Risk-Layer-LLM auf System 1,
  Vision-Pipeline auf System 2 — Konfiguration über getrennte Endpunkte
  (`LLM_URL` vs. `VISION_LLM_URL`), kein Swapping nötig.
- **Architektur-Regel daraus:** Alle LLM-Stufen sind Queue-Jobs ohne
  Latenzversprechen; die Triage-UI zeigt „Analyse läuft" und funktioniert
  auch mit unfertiger Analyse (deterministische Vorschläge sind sofort da).
  OCR (Stufe 2) ist bewusst CPU-only und entlastet die GPU.

## 6. Datenmodell (Skizze)

```
InboxItem {
  tenantId, id
  source        EMAIL_ADDIN | EMAIL_CENTRAL | UNC      (+ später PORTAL)
  sourceRef     // Message-Id / Pfad — Idempotenzanker (unique mit source)
  submittedBy?  // Add-In: einlieferndes Staff-Konto
  sha256, receivedAt, originalName, mimeType, sizeBytes, stagingKey
  status        EINGEGANGEN → VIRENGEPRUEFT → ANALYSIERT(stufe) → TRIAGE |
                ABGELEGT | ABGELEHNT | QUARANTAENE
  analysis      Json  // je Stufe: Vorschläge + Konfidenz + BEGRÜNDUNG
  belegDaten    Json? // Stufe-3-Extraktion (Zahlen je Beleg)
  resolvedDocumentId?, triagedBy?, triagedAt?
}
UncMappingRule { tenantId, pfadMuster, clientId?, kategorie?, prio }
```

Idempotenz dreifach: `(source, sourceRef)` unique, sha256-Dedup über
Kanäle, Status-Maschine nur vorwärts. Staging-Räumung nach Frist
(abgelehnt/abgelegt), beides auditiert.

## 7. Sicherheit, Datenschutz, Berechtigungen

- **Triage als Einzelrecht** (`INBOX_TRIAGE`, Muster iter87) — die
  „Poststelle"-Rolle sieht Inhalte vor der Zuordnung; Ablage auf
  RESTRICTED-Mandanten prüft die Rechte am ZIEL.
- Add-In-Token: personengebunden, widerrufbar (Profil), nur für die
  Inbox-API gültig (kein allgemeiner API-Zugriff).
- Audit: `inbox.received`, `inbox.quarantined`, `inbox.filed`,
  `inbox.rejected`, `inbox.beleg_export` — Eingang bis Ablage lückenlos.
- LLM/Vision netzintern wie der Risk-Layer; Prompts enthalten nur
  extrahierten Text bzw. das Bild, keine Tenant-übergreifenden Daten.
- DSFA-Ergänzung + VVT-Eintrag (neue Verarbeitung, insb. Mail-Inhalte).

## 8. Ausbaustufen (revidiert)

| Stufe | Inhalt | Wert |
|---|---|---|
| 1 | InboxItem + Staging + **UNC-Connector** (Soll-Struktur + Mapping-Tabelle) + Triage-UI; nur Stufe-0-Zuordnung; Virenscan | Scan-to-Archiv, sofort nutzbar |
| 2 | OCR-Container (CPU) + **Text-LLM-Klassifikation** (Stufe 1+2) | Vorschläge statt Handarbeit für Briefe/Bescheide |
| 3 | **Vision-Beleg-Pipeline** + Belegliste + XLSX-Export (Stufe 3, Batch/GPU-Scheduling) | Das „riesen Thema": Belege sortiert + Zahlen als Arbeitspapier |
| 4 | **Outlook**: zentrales Postfach (Graph) + **Add-In** (Pairing, persönliche Postfächer) | Der größte Kanal, M365-Regelfall |
| 5 | Bescheid-Autoerkennung → vorausgefüllter Bescheid → Einspruchsfrist → **Fristenkontrollbuch** | Schließt den Kreis |

## 9. Offene Entscheidungen

1. **GPU-Ausstattung konkret:** Welche Karte(n), ein oder zwei Systeme?
   (bestimmt Topologie A/B und die Modellwahl für Stufe 3)
2. **Soll-Struktur UNC:** Ist `\taxtronik-eingang\<Mandantennummer>\…`
   als Eingangs-Konvention tragfähig — und wer hostet den Share
   (Service-Account fürs CIFS-Mount)?
3. **Belegliste:** Welche Spalten braucht das Arbeitspapier konkret
   (z. B. zusätzlich Zahlungsweg, Skonto)? XLSX, CSV oder beides?
4. **Add-In-Verteilung:** Centralized Deployment im M365 Admin Center ok?
   Pairing-Code-Modell akzeptabel oder direkt Entra-ID-SSO?
5. **Triage-Besetzung:** Wer bekommt `INBOX_TRIAGE`?
