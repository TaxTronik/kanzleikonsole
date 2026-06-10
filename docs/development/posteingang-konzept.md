# Intelligenter Posteingang: Architektur-Konzept

Arbeitsstand: 2026-06-10. Status: **Konzept zur Entscheidung** — noch keine
Umsetzung. Ziel: Alles, was die Kanzlei erreicht (Mail, Upload, Scan), läuft
durch EINE Pipeline in EINE Triage-Oberfläche und landet erst nach
menschlicher Bestätigung im Archiv.

## 1. Leitplanken

1. **Drei Kanäle, eine Pipeline.** Die Eingangswege (Outlook, Nextcloud,
   UNC) sind reine Connectoren — ab dem Staging ist alles identisch.
   Ein vierter Kanal später (z. B. Portal-Upload des Mandanten, der heute
   schon existiert) ist dann nur ein weiterer Connector.
2. **Mensch bestätigt, Maschine schlägt vor.** Schutzstufen (GoBD/GwG mit
   Object-Lock) sind irreversibel — die automatische Ablage OHNE
   Bestätigung wäre ein Compliance-Risiko (falsch klassifiziert = 10 Jahre
   unlöschbar falsch). Die Pipeline liefert Vorschläge mit Konfidenz; die
   Ablage-Entscheidung trifft die Triage-Person, auditiert.
3. **Alles on-prem.** OCR und Klassifikation laufen lokal (Tesseract/
   ocrmypdf-Container + der vorhandene llama-server des Risk-Layers).
   Kein Byte verlässt die Kanzlei — das ist der USP gegenüber
   Cloud-Posteingängen.
4. **Deterministik vor KI.** Mandanten-Zuordnung zuerst über harte Treffer
   (Steuernummer, Mandantennummer im Ordnerpfad, Absender-Mailadresse =
   Portal-Kontakt, IBAN, Namens-Exaktmatch). Das LLM verfeinert nur, was
   deterministisch unklar bleibt, und liefert nie allein eine Zuordnung
   mit hoher Konfidenz.

## 2. Datenfluss

```
Outlook ──┐
Nextcloud ┼─▶ Connector (Worker-Job je Kanal, idempotent)
UNC ──────┘        │
                   ▼
            InboxItem (DB) + Rohobjekt im Staging-Bucket (SeaweedFS,
            OHNE Object-Lock — Staging ist verwerfbar)
                   │
                   ▼  BullMQ-Pipeline
            1. Virenscan (ClamAV, vorhanden)
            2. Textextraktion: PDF → unpdf (vorhanden); Scan/Bild →
               OCR-Container (ocrmypdf/Tesseract, deutsch); Office → mammoth
            3. Klassifikation + Extraktion (on-prem LLM): Dokumenttyp
               (vorhandene classificationKeys), Absender, Steuernummer,
               Datumsfelder, Bescheid-Indikator
            4. Mandanten-Matching: deterministisch → LLM-Fallback;
               Ergebnis = Vorschlagsliste mit Konfidenz
                   │
                   ▼
            Triage-UI /staff/posteingang: Vorschau + Vorschlag
            (Mandant, Dokumenttyp, Schutzstufe) → Bestätigen/Korrigieren/
            Ablehnen
                   │
                   ▼
            Ablage als Document im Archiv (Schutzstufe greift JETZT erst),
            Audit-Event; optional direkt „Bescheid anlegen" (vorausgefüllt)
            → Bescheid-Postfach → Einspruchsfrist → Fristenkontrollbuch
```

Der letzte Pfeil ist der eigentliche Hebel: Ein gescannter Steuerbescheid
wird zu einem vorausgefüllten Bescheid-Eintrag — und dessen
Einspruchsfrist taucht automatisch im Fristenkontrollbuch auf.

## 3. Die drei Kanäle im Detail

### 3.1 E-Mail (Microsoft Outlook)

**Grundsatzentscheidung: Funktionspostfach statt persönlicher Postfächer.**
Ein dediziertes Postfach (z. B. `eingang@kanzlei...`), in das Mitarbeiter
relevante Mails weiterleiten/verschieben. Persönliche Postfächer
automatisch auszulesen wäre datenschutz- und mitbestimmungsrechtlich heikel
und bringt zu viel Rauschen.

Zwei technische Pfade, abhängig von der Umgebung:

| Umgebung | Anbindung | Bewertung |
|---|---|---|
| Microsoft 365 / Exchange Online | **Graph API** (Application Permission, per Application Access Policy auf NUR das Funktionspostfach beschränkt; Delta-Query-Polling) | Sauberster Weg; braucht App-Registrierung im Tenant |
| On-Prem Exchange / andere | **IMAP** (Polling mit UID-Tracking) | Universell, kein OAuth; deckt auch Nicht-Microsoft ab |

Der Connector sollte beide Pfade beherrschen (Konfiguration je Tenant) —
IMAP als kleinster gemeinsamer Nenner zuerst, Graph als Ausbaustufe.

**GoBD-Punkt:** Die E-Mail selbst kann Handels-/Geschäftsbrief sein. Der
Connector archiviert deshalb die **vollständige EML als Original** plus
die Anhänge als Einzelobjekte; in der Triage wird entschieden, was davon
abgelegt wird (EML und/oder Anhänge). Verarbeitete Mails werden im
Postfach in einen `Verarbeitet`-Ordner verschoben, nie gelöscht.

### 3.2 Nextcloud / Belegablage

Eingangsordner-Konvention, z. B. `Belegeingang/<Mandantennummer>/…` —
**der Pfad liefert die Mandanten-Zuordnung deterministisch**, die Pipeline
muss nur noch Dokumenttyp/Inhalt bestimmen.

Anbindung: **WebDAV-Polling mit ETag-Vergleich** (robust, versionsneutral,
keine Nextcloud-Apps nötig). Optional später: Nextcloud Flow → Webhook →
n8n → TaxTronik (die signierte n8n-Inbound-Strecke mit HMAC + Replay-Schutz
existiert bereits) für Push statt Polling.

Verarbeitete Dateien werden serverseitig in einen `Verarbeitet`-Unterordner
verschoben (Sichtbarkeit für die Einleger), Fehlerfälle in `Fehler/`.

### 3.3 UNC-Pfad (kanzleiinterne Struktur / Scanner)

Der klassische Scan-to-Folder-Weg: Multifunktionsgeräte legen in
`\\server\scan\…` ab. Container können SMB nicht „einfach sehen" — der
Connector läuft als **Watcher-Sidecar mit CIFS-Mount** (Credentials eines
dedizierten Service-Accounts, lesend + verschieben).

- **Polling statt Datei-Events** — inotify über SMB ist unzuverlässig.
- **Stabilitäts-Check vor dem Einlesen** (Größe über zwei Polls konstant),
  damit halb geschriebene Scans nicht halbiert eingelesen werden.
- Auch hier trägt eine Ordnerkonvention (`scan/<Mandantennummer>/` oder
  `scan/allgemein/`) die deterministische Vorzuordnung.
- Verschieben nach `verarbeitet/`, niemals löschen.

## 4. Datenmodell (Skizze)

```
InboxItem {
  tenantId, id
  source        EMAIL | NEXTCLOUD | UNC          (+ später PORTAL)
  sourceRef     // Message-Id / WebDAV-Pfad+ETag / Dateipfad — Idempotenzanker
  sha256        // Inhalts-Dedup über Kanäle hinweg
  receivedAt, originalName, mimeType, sizeBytes
  stagingKey    // SeaweedFS-Staging
  status        EINGEGANGEN → GEPRUEFT_VIRUS → ANALYSIERT → TRIAGE |
                ABGELEGT | ABGELEHNT | QUARANTAENE
  analysis      Json  // Extraktion: Typ-Vorschlag, Mandanten-Kandidaten
                      // mit Konfidenz + BEGRÜNDUNG (welcher Treffer), Daten
  resolvedDocumentId?  // nach Ablage
  triagedBy?, triagedAt?
}
```

Idempotenz dreifach: `(source, sourceRef)` unique, `sha256`-Dedup
(gleiche Datei über zwei Kanäle → Hinweis statt Duplikat), Status-Maschine
nur vorwärts. Staging-Objekte abgelehnter/abgelegter Items werden nach
Frist (z. B. 30 Tage) geräumt — das Original liegt dann im Archiv oder
wurde bewusst verworfen (beides auditiert).

## 5. Sicherheit, Datenschutz, Berechtigungen

- **Triage als Einzelrecht** (`INBOX_TRIAGE`, Muster iter87): Die
  Triage-Person sieht Inhalte VOR der Mandanten-Zuordnung — also potenziell
  auch Post zu RESTRICTED-/vertraulichen Mandanten. Das ist organisatorisch
  die „Poststelle"-Rolle; technisch wird sie über das Einzelrecht
  abgegrenzt, und die Ablage auf einen RESTRICTED-Mandanten prüft beim
  Bestätigen die Zugriffsrechte des Ziels (nicht der Triage-Person).
- Audit-Events: `inbox.received`, `inbox.quarantined`, `inbox.filed`
  (mit Ziel-Dokument), `inbox.rejected` — Eingang bis Ablage lückenlos.
- LLM-Aufrufe wie im Risk-Layer: netzintern, on-demand-Start, kein
  externer Port; Prompts enthalten nur den extrahierten Text.
- DSFA-Ergänzung nötig (neue Verarbeitung personenbezogener Daten in
  Mails); VVT-Eintrag.

## 6. Ausbaustufen (Vorschlag)

| Stufe | Inhalt | Wert |
|---|---|---|
| 1 | `InboxItem` + Staging + **UNC- und Nextcloud-Connector** + Triage-UI; Zuordnung NUR deterministisch (Ordnerkonvention, Dateiname); Virenscan | Scan-to-Archiv ohne Umweg, sofort nutzbar |
| 2 | OCR-Container + Text-Extraktion + **LLM-Klassifikation/Extraktion** (Typ, Absender, Mandanten-Kandidaten) | „Intelligent": Vorschläge statt Handarbeit |
| 3 | **Mail-Connector** (IMAP zuerst, Graph als Option) inkl. EML-Original-Archivierung | Der größte Kanal, aber auch der heikelste |
| 4 | **Bescheid-Autoerkennung** → vorausgefüllter Bescheid-Eintrag → Einspruchsfrist → Fristenkontrollbuch | Schließt den Kreis zum Fristenbuch |

Stufe 1 ist bewusst „dumm aber nützlich" — die Pipeline-Architektur steht
damit komplett, und jede weitere Stufe ist nur ein zusätzlicher Schritt in
der bestehenden Kette.

## 7. Offene Entscheidungen (vor Stufe 1 bzw. 3)

1. **Outlook-Umgebung:** Microsoft 365 oder On-Prem Exchange? Ist ein
   Funktionspostfach organisatorisch gewollt (statt persönlicher
   Postfächer)? → bestimmt IMAP vs. Graph und den Stufe-3-Aufwand.
2. **Nextcloud:** Version/Hosting, gewünschte Ordnerkonvention
   (`<Mandantennummer>` als Schlüssel?), Service-Account.
3. **UNC:** Wer hostet den Share, Service-Account fürs CIFS-Mount,
   bestehende Scanner-Ordnerstruktur (übernehmen oder neu definieren?).
4. **OCR-Container:** ocrmypdf (PDF-zentriert, erzeugt durchsuchbare PDFs —
   mein Favorit, weil das Ergebnis direkt archivierbar ist) vs. reines
   Tesseract.
5. **Triage-Besetzung:** Wer bekommt `INBOX_TRIAGE` — Sekretariat/
   Poststelle oder alle?
