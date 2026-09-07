# taxtronik — Funktionsumfang

Stand: 2026-09-03. Die mit ⚙ markierten Module sind pro Kanzlei in den
Einstellungen ein- bzw. ausschaltbar (Boolean-Toggle unter Admin →
Einstellungen → Module). Rechnungen und Vollmachten sind keine Toggles,
sondern Modus-Schalter (`invoiceMode` / `poaMode`) mit `OFF`-Option —
sie tragen der Einheitlichkeit halber ebenfalls ein ⚙.

Die Liste beschreibt den **vorhandenen Funktionsumfang**. Die zugrunde liegende
steuerliche, rechtliche und kanzleifachliche Logik wird ergänzend im
[Fachkatalog](docs/fachkatalog/README.md) als atomare, prüfbare Regeln geführt.
Dort sind fachlicher Prüfstatus, tatsächlicher Umsetzungsstand, bekannte Grenzen
sowie Code- und Testnachweise getrennt ausgewiesen.

## Überblick

**Mandanten & Akte** — Mandanten-CRM · Onboarding-Wizard · GwG-Compliance ·
Anforderungen · Dokumente (Datei-Manager) · Kanzleikalender ⚙ · Bescheide &
Steuererklärungen ⚙ · Telefonzettel ⚙ · Wiedervorlagen ⚙ · Pendelordner ⚙ ·
Anlieferungen ⚙ · Fristenkontrollbuch

**Beratung & Auswertung** — BWA, Hochrechnung & Planung ⚙ ·
Subsumtions-Workspace / TCMS ⚙ · Wissensdatenbank ⚙

**Abrechnung & Vertretung** — Rechnungen ⚙ · Vollmachten ⚙ · Zeiterfassung ⚙

**Prozesse & Vorlagen** — Workflow-Vorlagen ⚙ · Form-Builder ⚙ ·
Anforderungs-Vorlagen · Custom-Felder

**Mitarbeiter & Kanzlei** — Dashboard-Widget-Builder · RSS-Reader ⚙ ·
Abwesenheiten · Benutzer-Verwaltung (inkl. Einzelrechte) ·
Tätigkeitsbereiche/Skills · Kanzlei-Einstellungen

**Mandanten-Portal** — Login · Anforderungen · Formulare · Dokumente ·
Stammdaten-Self-Service · Steuererklärungen · Termine · Auswertungen ·
Rechnungen · Anlieferungen · GwG-Onboarding · Mandantenpost ⚙

**Querschnitt** — Globale Suche · Benachrichtigungen · DSGVO · Compliance &
Audit · Backups & DR · Update-Mechanik & Lizenz · ELSTER-Anbindung
(Vorstufe) · UI (Dark/Modern) · Sicherheit · Architektur

---

## Ausbaupakete im deaktivierten Pilotstand ⚙

Vierzehn zusätzliche Module sind einzeln freischaltbar. Sie umfassen interne
Wiki-Hilfe, Jahresendkampagnen, persönliche Bescheidentscheidungen, IMAP/M365-
Eingangskorb, Personalaufnahme mit getrennten Zugängen, Bewirtungs-/Eigenbelege,
mandantenbezogene Verfahrensdokumentation, Feedback, Beteiligungsstrukturen,
explizite Workflow-Abhängigkeiten, geführtes Offboarding, VDB-Vorbereitung,
lokales EU-Sanktionsscreening mit manueller PEP-Dokumentation und StBVV-Vorschläge.

Die neuen Fachregeln sind ungeprüft. DATEV-LuG- und VDB-Dateierzeugung ist bis
zur nachgewiesenen Spezifikation und echten Importprobe gesperrt. Kein Modul
bestätigt automatisch steuerliche Anerkennung, GoBD-Konformität, wirtschaftliche
Berechtigung, externe Übermittlung oder Fristerledigung. Details und Abnahmen
stehen in der [Ausbauintegration](docs/development/expansion-integration.md).

## Mandanten-CRM

- Mandanten anlegen, Listenansicht mit Volltext-Suche über Name, DATEV-Nr.,
  **Addison-Nr.** und USt-ID
- Sortierung nach Name / DATEV-Nr. / Addison-Nr. / Angelegt
  (auf-/absteigend) mit offset-basierter Pagination
- „Nur meine Mandanten"-Filter — zeigt nur Mandanten, denen man in
  einer beliebigen Rolle zugeordnet ist (Berufsträger, Hauptbearbeiter,
  Vertreter, Fachlich)
- **Onboarding-Status-Spalte + Filter** — pro Mandant Badge
  Offen / Läuft / Abgeschlossen, abgeleitet aus `allowActive` +
  Contact-/GwG-/PoA-/Request-Counts; Filter SQL-seitig paginations-konsistent;
  Klick aufs Badge springt direkt in den Wizard zurück
- **A/B/C-Mandant-Priorität** — farbiges Circle-Badge (A rot, B amber, C grau)
  vor dem Namen, im Edit-Formular pflegbar, in der Liste sichtbar
- Getrennte allgemeine und steuerliche Stammdaten
  - **Verwaltung** (frei änderbar): DATEV-Nr, Addison-Nr, Rechnungs-E-Mail,
    Priorität A/B/C, **interne Akten-Notiz** (Markdown, nur Kanzlei sieht es),
    **Vertraulich-Flag** (Admin/Partner-only; schirmt den Mandanten auch im
    offenen Zugriffsmodell auf Zugeordnete ab)
  - **GwG-relevant** (Name, Rechtsform, Adresse) — Änderungen lösen die
    bestehende Wiederholungsprüfung aus; reine USt-ID-Änderungen nicht
  - **Steuerliche Stammdaten**: eine USt-ID und mehrere Steuerverbindungen mit
    Zweck, Steuernummer, Bundesland, Finanzamt und optionaler Finanzamtsnummer;
    aktive ELSTER-Standardverbindung und Archivierung
  - Landesformat aller 16 Bundesländer und 13-stelliges ELSTER-Format werden
    normalisiert; führende Nullen bleiben erhalten. Keine Bestätigung einer
    vergebenen Nummer und keine automatische Finanzamtzuständigkeit
  - Mandanten schlagen Steueränderungen im Portal vor; die Kanzlei übernimmt
    sie nach Prüfung, zwischenzeitliche Änderungen werden als Konflikt gezeigt
- Bearbeiter-Zuordnung mit zwei Rollen
  - Verantwortlicher Berufsträger (§ 32 StBerG, Single-Select)
  - Bearbeiter (Mehrfachauswahl) — wirkt als „Meine Mandanten"-Filter
- **Ansprechpartner-Verwaltung** pro Mandant
  - Name, Rolle (z. B. „Geschäftsführer"), E-Mail, Telefon
  - Optional Portal-Zugang via Magic-Link
  - Inline-Edit pro Kontakt, Mailto-/Tel-Links direkt nutzbar
  - Prominent oberhalb der Stammdaten-Cards platziert
- **Custom-Felder** — Kanzlei definiert eigene Felder am Mandanten
  (8 Typen: Text/Textarea/Zahl/Geldbetrag/Datum/Auswahl/Häkchen/URL)
  pro Mandantentyp (NATPERS/JURPERS/PERSGES) einschränkbar
- **Mandanten-Self-Service-Stammdaten**: Mandant schlägt Änderungen im
  Portal vor, Kanzlei genehmigt unter `/clients/:id/change-requests`;
  GwG-relevante Änderungen lösen automatisch Re-Verifikation aus
- Mandanten-Detail-Cockpit mit Block-Grid: Stammdaten, GwG-Status,
  anstehende Steuertermine, aktive Workflows, **Wiedervorlagen**,
  **Pendelordner**, Telefonzettel, **anstehende Termine** + offene
  Terminanfragen
- **Wiedervorlagen-Block** — offene + erledigte Sektion mit Check-Toggle
  (Details → Abschnitt „Wiedervorlagen")
- **Pendelordner-Block** (Details → Abschnitt „Pendelordner") und
  **Anlieferungen-Block** (Details → Abschnitt „Anlieferungen")
- **Inline-Telefonzettel-Anlage** auf der Mandantenseite mit Anrufer-
  Autocomplete aus den Ansprechpartnern (übernimmt Telefonnummer)
- **Anstehende-Termine-Block** — nächste 5 `Appointment`-Einträge des
  Mandanten mit Owner + Ort; Badge zeigt Anzahl offener Terminanfragen
- **Onboarding-Resume-Banner** — bei nicht-abgeschlossenem Onboarding
  ein amber Hinweis oben mit „Fortsetzen →"-Knopf zum nächsten passenden
  Wizard-Schritt
- Aktivitätsstrom (`/clients/:id/timeline`) mit Events aus 9 Tabellen
  (Documents, Requests, Responses, PhoneNotes, Invoices, GwG, Vollmachten,
  Bescheide, erledigte Steuertermine)
- Horizontale Tab-Navigation zu Sub-Bereichen (BWA, GwG, Bescheide,
  Workflows, Formulare, Stammdaten-Änderungen, Stunden, Steuertermine)
- DATEV-Belege-Export als ZIP (alle GoBD-Belege + index.csv + manifest.txt)
- CSV-Export der Mandantenliste inkl. DATEV + Addison

## Onboarding-Wizard

Geführter Multi-Step-Wizard für den kompletten Erstkontakt eines neuen
Mandanten.

- Einstieg über „Onboarding starten"-Button in der Mandantenliste oder
  Empty-State; alternativ „Schnell anlegen" für reine Stammdaten-Anlage
- **6 Schritte** mit Pille-Stepper (current/done/pending visualisiert):
  1. **Stammdaten** (Pflicht) — Name + Kind + DATEV/Addison +
     Adresse → erzeugt Client, weiter zu Schritt 2
  2. **Ansprechpartner + Portal-Zugang** (optional) — `ClientContact`
     anlegen mit Default-Checkbox „Magic-Link jetzt versenden"
  3. **GwG-Onboarding** (Pflicht) — gleichwertige Einstiege „Mandant per Link
     einladen“ und „In der Kanzlei erfassen“. Kanzleierfassung öffnet den Entwurf
     und widerruft offene Links kontrolliert; Kontakte und Freigabegates bleiben
  4. **Vollmacht** (optional, modul-gated über `poaMode !== 'OFF'`) —
     verlinkt zur bestehenden `/staff/poa/new` mit Pre-Selektion
  5. **Erste Anforderung** (optional) — verlinkt zu
     `/staff/clients/:id/requests/new` mit `?from=onboarding`
  6. **Fertig** — Übersicht aller angelegten Daten + GwG-Pflichthinweis +
     „Onboarding abschließen"-Button (`client.onboarding.complete`-Audit)
- Fortschritt wird zur Laufzeit aus den existierenden Sub-Resourcen
  abgeleitet (kein eigenes Stage-Feld in der DB) — bestehende
  Pre-Wizard-Mandanten zeigen automatisch korrekten Status
- **Modul-adaptiv**: Vollmachts-Schritt wird ausgeblendet, wenn das
  Vollmachten-Modul `OFF` ist
- **Skip-Buttons** auf allen optionalen Schritten; Pflichtschritte
  blockieren nicht — Berater darf bewusst „später" wählen, aber bekommt
  im Done-Step einen ⚠ Hinweis

## GwG-Compliance

- Prüfung pro Mandant: Risikoanalyse (regelbasierter Score),
  Identifizierungsdokumente, wirtschaftlich Berechtigte
- Status-Maschine: DRAFT → IN_REVIEW → VERIFIED / REJECTED → EXPIRED
- Mandant kann Anforderungen/Rechnungen/Dokumente erst nach VERIFIED erhalten
  (DB-Trigger + App-Guard)
- Periodische Wiederholung: Hochrisiko jährlich, sonst alle 3 Jahre
- Worker prüft täglich auf ablaufende Checks, 3-Stufen-Eskalation:
  Bearbeiter @ 90 Tage → +Berufsträger @ 30 Tage → alle Admins
  - Mandant deaktivieren bei Ablauf
- Personalausweis-Ablauf-Check (60 Tage vor Expiry: Notification an
  Bearbeiter + Auto-Anforderung an Mandant, idempotent)
- Re-Verifikation nur bei GwG-relevanten Stammdaten-Änderungen (sowohl bei
  Staff-Edit als auch bei genehmigten Self-Service-Änderungen); reine
  Steuernummer- und USt-ID-Änderungen lösen keine erneute GwG-Prüfung aus
- **Lokale Ausweishilfe** für deutsche Personalausweise in Kanzlei und Wizard:
  JPG/PNG/PDF, Seitenauswahl, Drehung, Ausschnitt und bewusst ausgewählte
  OCR-Vorschläge. Tesseract, Sprachmodelle und PDF-Runtime sind selbst gehostet;
  keine externen OCR-Aufrufe und keine Speicherung von OCR-Rohtext
- Originale bleiben unverändert; zwei Seiten dürfen aus derselben PDF stammen.
  Quellversion und Personenbindung werden serverseitig geprüft. Manuelle
  Erfassung bleibt bei Erkennungsfehlern und unlesbaren PDFs möglich
- Speichern bestätigt keine Identität. „Ausweis geprüft“ ist eine gesonderte
  Mitarbeiteraktion; GwG-Freigabe verlangt zusätzlich einen aktiven,
  qualifizierten und ausdrücklich dem Mandanten zugeordneten Berufsträger
- **GwG-Kontrollliste** (`/staff/gwg`): Suche, Prüf-/Nachweis-/Ablauffilter und
  bewusst verknüpfte Personen über sichtbare Mandate. Unternehmenszuordnungen
  behalten eigene Angaben, Ausweise und Prüfstände; keine automatische Zusammenführung
- **XLSX-Export** mit „Personenübersicht“ und „Nachweisdetails“, gemeinsamen
  exportlokalen Personenkennungen, vollständigen Ausweisnummern als Text und
  getrennten Angaben zu Identitätsprüfung und GwG-Freigabe. Über 10.000
  Detailzeilen ist eine Eingrenzung erforderlich; verborgene Mandate erscheinen
  auch nicht in Zählern oder Verbindungswegen
- **GwG-Onboarding-Einladung** — Mandant erfasst Daten und Nachweise, ohne
  Portal-Account
  - Magic-Link mit 14-Tage-Token, hash-gespeichert (analog PoA-Sign)
  - 4-Schritt-Wizard: Stammdaten → wirtschaftlich Berechtigte →
    Personalausweis-Vorder/Rückseite je Person → optionale Zusatz-Dokumente
  - Datei-Upload direkt im Wizard (JPG/PNG/PDF, ClamAV-Scan, Object-Lock);
    versehentlich ausgewählte Dateien können vor dem Absenden verworfen werden
    und werden dann weder fachlich gespeichert noch archiviert
  - Beim Submit: Mandant-Stammdaten werden aktualisiert (mit GwG-relevant-
    Audit); ein bearbeitbarer DRAFT wird gespeichert, ohne Prüfbestätigung
  - Wirtschaftlich Berechtigte + Ausweis-Dokumente werden als
    `gwg_beneficial_owner` + `gwg_id_document` (Vorder + Rückseite) angelegt
  - Ablage nach Person unter `GwG/<Name der Person>`; optionale allgemeine
    Zusatzdokumente bleiben im GwG-Hauptordner
  - Die Herzlich-willkommen-Mail wird nur beim ersten abgeschlossenen
    Mandanten-Onboarding versandt, nicht bei späteren GwG-Wiederholungen
  - Audit-Trail mit IP + User-Agent
  - Kanzlei besorgt nur HR-Auszug + Transparenzregister-Auszug selbst
- **Pflichtvernichtung nach § 8 Abs. 4 GwG** — Review-Queue unter
  `/staff/admin/gwg-retention` (ADMIN/PARTNER, kein stilles Auto-Delete):
  - Prüfung ab Jahresende des Mandatsendes + 5 Jahre (`client.mandateEndedAt`);
    andere Gesetze können länger verpflichten, spätestens nach 10 Jahren ist
    zu vernichten
  - Bei nie zustande gekommenen Geschäftsbeziehungen beginnt die Frist mit dem
    Feststellungsjahr; auch offen gebliebene `DRAFT`-/`IN_REVIEW`-Erstprüfungen
    werden erfasst. Reguläre Fünfjahres- und absolute Zehnjahresgrenze beginnen
    beide am fachlich maßgeblichen Zeitpunkt (Beziehungsende bzw. Feststellung),
    nicht am bloßen Alter eines Belegs einer laufenden Beziehung.
  - Ab fünf Jahren erscheint der Eintrag regulär in der manuellen Review-Queue.
    Ist er dort beim Erreichen von zehn Jahren noch offen, eskalieren Grund und
    angezeigte Frist auf **absolute 10-Jahres-Grenze**; auch dann erfolgt keine
    automatische Vernichtung.
  - **Datei-Belege**: bestätigte Vernichtung löscht die Object-Store-Bytes und
    `document_version`-Zeilen; der `document`-Skelettdatensatz bleibt mit
    Lösch-/Vernichtungsvermerk erhalten. Der Vorgang wird als
    `gwg.evidence.destroy` auditiert (GwG-Belege liegen dafür im eigenen
    `gwg`-Bucket mit Object-Lock GOVERNANCE statt COMPLIANCE)
  - **DB-Aufzeichnungen**: zweite Stufe vernichtet das `gwg_check`-Aggregat
    (wirtschaftlich Berechtigte gelöscht, Ausweis-Details genullt,
    Risiko-Antworten entfernt); ein Skelett-Datensatz mit
    `destroyedAt`-Vernichtungsvermerk bleibt als Nachweis, auditiert
    `gwg.check.destroy`; erst zulässig, wenn keine Datei-Belege mehr
    existieren
  - Täglich idempotente **`GWG_DELETION_DUE`-Notification** an alle
    ADMIN/PARTNER, sobald Einträge löschreif sind (Worker
    `gwg-expiry-check`)
  - Compliance-Hintergrund in `docs/compliance/gwg.md`

## Anforderungen (Requests)

- Anforderungen an Mandanten, Status, Priorität, Fälligkeit
- Mandant antwortet via Portal mit Text + Dokument-Upload
- **Anforderungs-Vorlagen** unter `/staff/admin/request-templates`
  - Wiederkehrende Anforderungen (FiBu-Belege, Lohnunterlagen,
    Jahresabschluss-Belege, USt-Belege …) einmal definieren
  - Pro Vorlage: Name, Kategorie, Default-Titel, Beschreibung, Priorität,
    Fälligkeit in Tagen ab Erstellung
  - Optional **verknüpftes Formular** — beim Anlegen aus der Vorlage wird
    automatisch eine `FormSubmission` für den Mandanten angelegt
  - Im New-Request-Formular nach Kategorie gruppiertes optgroup-Dropdown
    füllt alle Felder vor — bleibt editierbar
- Bulk-Aktionen: mehrere Anforderungen gleichzeitig schließen
- Einzelne beantwortete oder geschlossene Anforderungen lassen sich durch
  Mitarbeiter auditierbar wieder öffnen; ein noch nicht abgesendetes
  verknüpftes Formular wird dadurch wieder mandantenseitig bearbeitbar
- Beim Schließen/Beantworten wird der Mandantenkanal einschließlich eines
  verknüpften Formulars gesperrt; kanzleiinterne Kommentare bleiben auch danach
  möglich
- Tab-Filter (Offen / In Bearbeitung / Beantwortet / Geschlossen)
- Volltext-Suche über Titel + Mandantenname + DATEV-Nr. + Addison-Nr.
- Sortierung: Angelegt / Fällig / Mandant / DATEV-Nr. / Addison-Nr.
- „Nur meine Mandanten"-Filter (analog Mandantenliste)
- Offset-basierte Pagination mit „Seite X von Y"
- CSV-Export
- Auto-Anforderungen aus Steuerterminen (siehe Kanzleikalender)
- Portal-Detailansicht zeigt verknüpftes Formular als prominenten Block —
  „Formular öffnen" als Primärbutton, nach Absenden grüne Bestätigung

## Dokumente

### Datei-Manager (Explorer-Stil)

- **Browser mit Breadcrumb-Navigation**: Mandantentyp (Natürliche Person /
  Juristische Person / Personengesellschaft) → Mandant → frei anlegbare
  Ordner → Dateien. Zusätzlich ein **kanzlei-interner** Bereich für
  mandantenlose Dokumente.
- **Echte Ordnerstruktur** pro Mandant (Baum, beliebig tief): anlegen,
  umbenennen, verschieben (zyklensicher), löschen (Inhalt rückt eine Ebene
  hoch — es wird nie ein Dokument mitgelöscht).
- **Drag & Drop**: Dateien/Ordner per Maus in Ziel-Ordner ziehen;
  „Wurzel"-Dropzone zum Herauslösen; OS-Datei-Drop in den Browser =
  Upload in den aktuellen Ordner.
- **Mehrfachauswahl** (Checkbox/Strg) für Dateien und Ordner +
  **Rechtsklick-Kontextmenü**: Verschieben, Typ ändern, Freigeben,
  Löschen/Wiederherstellen, Download.
- Klick auf den Dateinamen öffnet die **Inline-Vorschau** (PDF, Bild, Markdown,
  XLSX), Download separat. DOCX und andere Office-Formate laufen bewusst nur
  über den Download-Pfad: inline gerendert würden sie fremde aktive Inhalte in
  den authentifizierten App-DOM übernehmen.

### Datei-Typen & Schutzstufen

- Jedes Dokument hat einen **Typ**; der Typ trägt die **Schutzstufe**, die
  Bucket + Object-Lock + Aufbewahrung steuert — genau drei, fix:
  _kein Lock_ · _GwG · grundsätzlich 5 Jahre_ · _GoBD · typabhängig 6/8/10 Jahre_.
- 7 gesetzlich fixierte Kern-Typen (read-only). Die Kanzlei kann unter
  **Admin → Datei-Typen** eigene Typen ergänzen (z. B. „Arbeitspapiere")
  und einer Stufe zuweisen (bei Anlage fix).
- **Retagging** compliance-bewusst: Höherstufung aus „ohne Lock" kopiert die Datei
  serverseitig in den korrekten Object-Lock-Bucket um (Re-Store, neu
  virengeprüft); gleiche Stufe = Metadaten; Herabstufung gesperrt
  (angewandte Aufbewahrung ist nicht entfernbar). GWG→GOBD bleibt wegen der
  eigenständigen GwG-Vernichtungsfrist gesperrt. Auch als Sammel-Aktion.

### Mandanten-Freigabe (Opt-in)

- Staff-Uploads sind **privat**, bis sie bewusst freigegeben werden;
  vom Mandanten selbst hochgeladene Dateien (Portal-Upload,
  Anforderungs-Antwort) sind automatisch geteilt.
- Portal-Lesepfade (Liste, Vorschau, Download) filtern hart auf
  „freigegeben" — kein Abruf nicht-geteilter Dokumente per ID.
- geteilt/privat-Badge + Einzel- und Sammel-Toggle in Browser und
  Mandantenansicht; jede Freigabe/Rücknahme auditiert.

### Speicher, Versionierung, Nachweis

- ClamAV-Virus-Scan synchron beim Upload; SeaweedFS-Object-Storage,
  Object-Lock (GoBD typabhängig 6/8/10 J. COMPLIANCE / GwG zunächst 5 J.
  GOVERNANCE mit fachlicher Löschprüfung), Store nie
  öffentlich (App proxied Up-/Downloads).
- Upload-Limit 25 MiB pro Datei (`MAX_UPLOAD_BYTES`, nginx `client_max_body_size
26M` mit Overhead-Reserve). Das mitgelieferte `infra/clamav/clamd.conf` setzt
  `StreamMaxLength 110M` und liegt damit bewusst über dem Cap — das Stock-Image
  begrenzt INSTREAM auf 25M, wodurch Uploads am oberen Rand am Protokoll-
  Overhead scheiterten.
- Auf der Mandanten-Detailseite lädt der Datei-Manager die neuesten
  1000 Dokumente (bei Erreichen des Caps Truncation-Hinweis mit
  Gesamtzahl); der Anforderungs-Block zeigt die neuesten 50 mit Link zur
  vollen Übersicht.
- Versionierung pro Dokument; SHA-256-Hash + Audit-Log pro
  Upload/Download/Verschieben/Typ-Änderung/Freigabe.
- **Soft-Delete**: „Löschen" blendet nur aus (Bytes bleiben unter
  Object-Lock, gesetzliche Aufbewahrung), Audit, jederzeit
  wiederherstellbar; eigene „Gelöscht"-Ansicht.
- **Empfangsbestätigung pro Dokument** — `acknowledgedAt` +
  `acknowledgedByStaff`-Toggle; dokumentiert Vollständigkeits-Beweis
  („Belege sind angekommen").
- **Sammel-Download**: eine Datei direkt, mehrere oder ganze Ordner
  rekursiv als ZIP mit erhaltener Ordnerstruktur.
- DATEV-Belege-Export als ZIP (alle GoBD-Belege + index.csv + manifest.txt).

## Kanzleikalender ⚙

Vereint Steuertermine und freie Termine (Mandantenmeetings, intern, privat)
unter `/staff/calendar`. Der frühere Nav-Eintrag „Steuertermine" wurde
hierin umbenannt. Technisch hängen hier zwei getrennte Modul-Schalter
dran: der Steuertermin-Teil am Modul `taxNotices` (gemeinsam mit den
Bescheiden), der Termin-Teil (Appointments + Portal-Terminanfragen) am
Modul `appointments`.

### Steuertermin-Engine

- Konfiguration pro Mandant unter `/staff/clients/:id/tax-schedule`:
  USt-VA (mtl./quart./jährl.), LSt-Anmeldung (mtl./quart./jährl.),
  ESt/KSt/GewSt-VZ + Erklärungen; ohne GwG-Freigabe (`allowActive`)
  werden keine Termine materialisiert (Hinweis-Banner)
- Mit Dauerfristverlängerung (nur USt-Voranmeldung, § 18 Abs. 6 UStG,
  §§ 46-48 UStDV) → +1 Monat. Für die Lohnsteuer-Anmeldung (§ 41a EStG) gibt
  es KEINE Dauerfrist — die Checkbox wird dort nicht angeboten
- **Beratene Erklärungsfrist § 149 (3) AO** als `advised`-Option pro
  Schedule-Config (letzter Tag des Monats Februar des zweiten Folgejahres
  statt 31.07. des Folgejahres). Über die Steuertermin-Konfig-UI pro
  Erklärungsart aktivierbar (Spalte „Beraten"); nur für Erklärungen
  (USt-Jahres-, ESt-/KSt-/GewSt-Erklärung), nicht für Anmeldungen/
  Vorauszahlungen. Beim Umschalten werden offene Termine neu materialisiert
- Technische Werktagsverschiebung für von der Engine berechnete Fristenden:
  Wochenenden sowie bundesweite und anhand der Tenant-Steuerregion
  konfigurierte Landesfeiertage werden berücksichtigt. Dieser allgemeine
  Steuerterminpfad prüft die Anwendbarkeit des § 108 Abs. 3 bis 6 AO und den
  rechtlich maßgeblichen Feiertagsort nicht vorgelagert; sein Ergebnis bleibt
  ein Kontrollvorschlag. Der beweisorientierte Bescheidpfad kann dagegen
  Fristklassifikation, Empfängerort und Behördensitz getrennt erfassen und
  fällt bei unvollständigem, historischem oder ausländischem Kalenderkontext
  auf manuelle Prüfung zurück. Kommunale Feiertage werden dort nur aus den für
  den Vorgang eingegebenen Daten berücksichtigt, nicht aus einer amtlich
  versionierten Quelle
- **Tagesgenaue Überfälligkeit (§ 108 (1) AO)**: ein heute fälliger Termin
  ist noch nicht überfällig — OVERDUE wird erst nach Ende des
  Fälligkeitstags gesetzt
- **Zweistufige Auto-Anforderung an Mandanten** (pro Mandant × Terminart
  konfigurierbar: An/Aus, Versand N Tage vor Fälligkeit, Vorwarnung M Tage
  davor): Stufe 1 beansprucht die Vorwarnung atomar und warnt alle aktiven
  HAUPTBEARBEITER des Mandanten intern vor (`TAX_DEADLINE_REQUEST_PENDING`,
  bei vollständig fehlender Hauptbearbeitung Fallback auf alle aktiven
  ADMIN/PARTNER). Ohne aktiven Empfänger wird der
  Warnzeitpunkt nicht als erledigt gestempelt — Opt-out-Modell,
  auf der Gruppen-Seite lässt sich die Anlage einzeln oder als Bulk stoppen
  (aufhebbar; z. B. Unterlagen bereits in Papierform geliefert). Stufe 2 legt
  frühestens einen Tageslauf nach der Vorwarnung die Portal-Anforderung
  unter einem Compare-and-set-Claim mit den gelesenen Konfigurationsabständen
  atomar an, verknüpft sie mit dem Termin und merkt die getrennte
  Benachrichtigung als `QUEUED` vor. Nach dem Commit verarbeitet der Worker
  denselben Request über eine eigene datenminimierte Mailvorlage. Mandantenname,
  Steuerart, Zeitraum, Fälligkeit, Request-Titel und -Beschreibung bleiben im
  geschützten Portal und werden weder als Mail-Template-Variablen noch als
  Betreff-Suffix angeboten. Fachliche Mandantenhinweise gehen
  nur an aktive Kontakte mit Benachrichtigungsfreigabe und einem gespeicherten
  erfolgreichen Portal-Login; bloß eingeladene, noch nie erfolgreich
  angemeldete Kontakte werden nicht verwendet. Eine Änderung der
  Kontakt-E-Mail setzt diesen Login-Nachweis zurück. Versand erfolgt nur,
  solange der Request `OPEN` oder `IN_PROGRESS` ist; fachlich terminale
  Requests werden ohne Versand als `ORPHANED` aus der technischen Pipeline
  gelöst. Das optionale n8n-Ereignis wird je logischem Request genau einmal,
  nicht pro Kontakt und auch bei vollständig fehlendem Mailkontakt ausgelöst;
  der Mailstatus bleibt dann `NO_RECIPIENT`. Nur ein durch eine ausdrückliche negative
  SMTP-Providerantwort eindeutig belegter Totalfehler wird höchstens dreimal
  versucht; Transport-, Socket- oder Timeout-Exceptions, Teilannahme,
  fehlender Empfänger, inkonsistente Verknüpfung oder sonst unklarer Ausgang
  werden ohne Blind-Retry intern eskaliert.
  Persistiert werden unter anderem Versuchszahl, nächster Versuch, Fehler und
  Eskalationszeit. `PROVIDER_ACCEPTED` bedeutet nur technische Annahme aller
  Einzelversuche — weder Zustellung noch Zugang oder Kenntnisnahme. Ein Fehler
  rollt die Portal-Anforderung nicht zurück. Ein persistierter, noch nicht
  eskalierter `UNKNOWN`-Versandclaim sperrt Unlink und DSGVO-Purge bis zum
  gespeicherten Versandabschluss oder zur Timeout-Eskalation. Reguläre Unlinks
  übernehmen Versuch, Annahme, Fehler und Eskalation geschützt nach
  `ORPHANED`; die Versandmetadaten sind danach unveränderlich. Nur der explizite
  transaktionslokal freigegebene Purge darf den vollständigen technischen
  Tupel auf `NOT_REQUIRED`/leer neutralisieren. Wird ein Steuertermin mit
  terminaler Anforderung regulär gelöscht, archiviert die Datenbank höchstens
  pseudonyme technische Versandmerkmale; Fehlertext wird nur als SHA-256-Wert
  gebunden. Der Anwendung fehlen Leserechte, und der Retention-Worker löscht
  den Hilfsnachweis tenantgebunden spätestens nach einem Jahr. Die Vorgänge werden
  als `tax_deadline.auto_request` beziehungsweise
  `tax_deadline.request_suppressed`/`_unsuppressed` auditiert. Nach Ende
  des Fälligkeitstags wird nie mehr automatisch angefordert
- **Gemeinsamer Materialisierer-Kern** in `@taxtronik/tax`
  (`materializeTenantTaxDeadlines`): Web-App und Worker nutzen exakt
  dieselbe Logik (per Dependency-Injection, transaktional) — keine
  Web/Worker-Drift
- Worker materialisiert täglich Termine 90 Tage voraus; die tenant-weite
  Neuberechnung aus der UI läuft als Hintergrund-Job (Button quittiert
  mit „Berechnung angestoßen", kein Timeout bei vielen Mandanten)
- Niemals retroaktiv (Mandanten werden unterjährig übernommen)
- Tax-Schedule-Config-Deaktivierung räumt offene Termine mit auf
- Unit-Tests für Engine + Materialisierer im eigenständigen
  `@taxtronik/tax`-Package

### Termine (Appointment-Modell)

- `Appointment` mit `ownerStaffId` (für wen) + `createdByStaff`
  (wer angelegt) — Sekretärin kann für Berufsträger anlegen
- Drei Kinds: **CLIENT_MEETING** (Mandantentermin), **INTERNAL**
  (Teambesprechung/Schulung), **PRIVATE** (privater Block)
- Status PLANNED → CONFIRMED → CANCELLED / DONE
- Optionaler Mandantenbezug + Ortsangabe (Büro / Video / Telefon)
- Modal „Neuer Termin" mit Mandanten- + Owner-Auswahl
- DB-Constraint `ends_at > starts_at`

### Monats-Ansicht

- Kalenderraster mit Steuertermin-Pillen (Brand-Farbe, „X/Y offen"-Counter,
  Klick zeigt alle Mandanten dahinter) **und** Termin-Pillen (Emerald-Farbe
  mit Uhrzeit + Titel)
- Filter „Alle Mandanten / Meine Mandanten" (über `/staff/tax-deadlines`-
  Fallback-View)
- Heute-Knopf + Monats-Navigation
- „Nur Steuertermine"-Link führt zur klassischen Listenansicht

### Terminanfragen vom Mandanten

- Über `/portal/appointments` schlägt der Mandant 1–3 Wunschtermine vor
  - Anliegen + optional Wunsch-Bearbeiter
  - Im Zugriffsmodus `OPEN` stehen alle aktiven Mitarbeiter zur Wahl; bei
    `RESTRICTED` oder vertraulichen Mandanten nur Admin/Partner und für den
    Mandanten zuständige Mitarbeiter. Manipulierte fremde/inaktive IDs werden
    serverseitig abgewiesen.
- Kanzlei sieht offene Anfragen oben im Kalender als eigene Sektion
- Inline-Entscheidung: Slot auswählen + Owner zuweisen → Annehmen erzeugt
  `Appointment` mit `fromRequestId`; alternativ Ablehnen mit optionalem Grund
- Notification an Owner bei Annahme; an präferierten Bearbeiter oder alle
  verantwortlichen Berufsträger/Hauptbearbeiter bei neuer Anfrage
- Audit-Trail über `appointment_request.create/.accept/.reject/.cancel`

## Bescheide & Steuererklärungen ⚙

Unified-Seite `/clients/:id/notices` zeigt Steuererklärungen und Bescheide
nebeneinander auf einer Seite.

### Steuererklärungen / Vor-Bescheide (Iter. 24)

- Erfassung dessen, was die Kanzlei via DATEV/Addison übermittelt hat
  (Steuerart + Zeitraum + erwartete Beträge)
- Vier Geldwert-Felder: festgesetzte Steuer (Soll), bisherige VZ,
  erwartete Erstattung, erwartete Nachzahlung
- Optional Berechnungs-PDF aus DATEV/Addison als Anhang
  (klassifiziert als GOBD_TAX mit Object-Lock)
- Hinweistext an den Mandanten + interne Notiz
- **Portal-Freigabe** pro Eintrag opt-in — sichtbar unter `/portal/steuer`
- Auge-Icon togglet Privat ↔ Sichtbar

### Bescheid-Postfach

- Erfassung von Steuerbescheiden vom FA (USt-VA, USt-Jahr, ESt, KSt,
  GewSt-Mess, GewSt, LSt-Anm., Feststellung, Zerlegung, Sonstige)
- **Auto-Match** beim Erfassen: `(client, kind, period)` matcht
  automatisch auf eine bestehende Erklärung, übernimmt deren erwarteten
  Wert als `expectedAmount` und setzt `filing_id`
- Soll/Ist-Vergleich: festgesetzt vs. erwartet, farbcodierte Differenz
- Einspruchsfrist als beweisorientierter Kontrollvorschlag nach
  Übermittlungsweg: Bei Post und unmittelbarer elektronischer Übermittlung muss
  das Ausgangsdatum als tatsächlicher Aufgabe- beziehungsweise Absendetag
  klassifiziert und mindestens substantiiert sein. Fehlt es, darf das
  Bescheiddatum nur einen getrennten internen Risikotermin erzeugen;
  Bekanntgabetag und Rechtsfrist bleiben leer. Die Maske trennt behaupteten,
  substantiierten und als fachlich festgestellt eingegebenen Nachweis,
  Nichtzugang, früheren tatsächlichen und späteren Zugang, Empfänger- und
  Behördenort sowie eine dreistufige Belehrungsprüfung. Ein früher erfasster
  Zugang verkürzt die Fiktion nicht. Bei nur behauptetem späterem Zugang zeigt
  die UI getrennt das Szenario aus der gesetzlichen Fiktion und das Szenario
  aus dem behaupteten Zugang; beide bleiben manuell zu prüfen. Unklare
  Nachweise, Belehrung oder Feiertagskontexte liefern `MANUAL_REVIEW`. Eine unabhängige
  Berufsträger-/Vier-Augen-Freigabe und beleggebundene Evidenz sind noch nicht
  implementiert
- Beim Datenabruf wählt die Kernlogik anhand des Erlassdatums zwischen
  Altrecht bis 2025, dem konservativ nur mit dokumentierter aktiver
  Einwilligung berechenbaren Jahr 2026 und dem Regelfall ab 2027. Ab 2027
  müssen Voraussetzungen und Postantrag getrennt bewertet sein. Die
  Engine vergleicht den Zugangstag eines als wirksam erfassten Postantrags mit
  der Bereitstellung: Zugang bis einschließlich Bereitstellungstag blockiert
  den Automatismus; ein erst später zugegangener Antrag blockiert diese bereits
  frühere Bereitstellung nicht allein deshalb. Die
  Bereitstellung benötigt einen Nachweisstatus; Empfängerort und Behördensitz
  werden separat geprüft. Fehlerhafte oder verspätete Same-Day-
  Benachrichtigung verändert den Fiktionstag nicht, wird aber als manueller
  Wiedereinsetzungs-Prüfhinweis gespeichert. Die UI kennt noch keinen eigenen
  Status „Benachrichtigung nicht zugegangen“, und der Hinweis ist kein
  vollständiger §-110-Workflow. Warnung bei < 7 Tagen Restdauer
- **Einspruchsfristen-Reminder**: Worker `reminders-daily` schickt
  14 / 7 / 1 Tage vor `appealDeadline` nur dann Notifications, wenn der
  Vorschlag `CALCULATED` ist und keinen manuellen Prüfbedarf trägt. Empfänger
  ist der weiterhin aktive und aktuell mandatsberechtigte dokumentierte
  Prüfer; sonst alle aktiven Hauptbearbeiter, danach aktive Admins/Partner als
  Fallback. Fehlt ein berechtigtes Ziel, entsteht insbesondere keine globale
  Notification. Fristqualifikation und Zugriff werden im Insert-Tx erneut
  geprüft; Deduplizierung erfolgt per Day-Bucket und Resource/Kind
- **Status-Maschine mit bedienbaren Übergängen** (Quick-Action-Auswahl in
  der Tabelle, `updateNoticeStatusAction`, auditiert `tax_notice.status`),
  entlang des Einspruchs-Lebenszyklus § 347 ff. AO:
  - NEU → GEPRÜFT (Normalfall) oder direkt EINSPRUCH
  - GEPRÜFT → EINSPRUCH / BESTANDSKRÄFTIG; zurück auf NEU (Fehlklick)
  - EINSPRUCH → ABGEHOLFEN / TEILABHILFE /
    TEIL-EINSPRUCHSENTSCHEIDUNG / ZURÜCKGEWIESEN
  - ABGEHOLFEN → BESTANDSKRÄFTIG
  - TEILABHILFE → ABGEHOLFEN / TEIL-EINSPRUCHSENTSCHEIDUNG /
    ZURÜCKGEWIESEN; allein keine Klagefrist
  - TEIL-EINSPRUCHSENTSCHEIDUNG → ABGEHOLFEN / ZURÜCKGEWIESEN / KLAGE
  - ZURÜCKGEWIESEN → KLAGE / BESTANDSKRÄFTIG
  - KLAGE → BESTANDSKRÄFTIG (final)
  - Side-Effects: GEPRÜFT stempelt `reviewedAt/-By`, EINSPRUCH
    `appealFiledAt`; TEILABHILFE speichert den tatsächlichen Bekanntgabetag
    des Teilabhilfebescheids und die dokumentierende Person, ohne den Einspruch
    zu erledigen. Einspruchsentscheidung speichert ihren eigenen Nachweis; technisch
    wird nur bei `TEILEINSPRUCHSENTSCHEIDUNG` und `ZURUECKGEWIESEN` eine
    Klagefrist geführt; KLAGE bindet Einreichungszeitpunkt und Bearbeiter als
    Erledigungsnachweis. BESTANDSKRÄFTIG ist in der Server-Action auf Admin
    oder Partner beschränkt und verlangt Ereignistag, Person sowie eine
    Begründung von mindestens zehn Zeichen. Aus GEPRÜFT sind zusätzlich eine
    vollständig berechnete Einspruchsfrist ohne manuellen Prüfbedarf, deren
    Ablauf und das Fehlen eines dokumentierten Einspruchs Pflicht; aus
    ZURÜCKGEWIESEN muss die dokumentierte Klagefrist abgelaufen sein. Der
    jeweilige Fristtag ist gesperrt; frühestens der Folgetag ist zulässig. Die
    Rollenprüfung belegt keine Berufsträgerqualifikation
  - Bekannte fachliche Modellgrenze: Trotz getrennter Teilabhilfe und
    Teil-Einspruchsentscheidung bleibt `TaxNotice.status` linear. Eine
    Klagefrist für den entschiedenen Teil und der gleichzeitig fortdauernde
    Einspruch über den Rest lassen sich nicht als parallele, gegenständlich
    abgegrenzte Verfahrenszweige abbilden
- PDF des Bescheids wird verlinkt (über Document-Modul)
- Verknüpfungs-Indikator zeigt in der Tabelle „↪ aus Erklärung"
  - „Portal"-Badge, wenn der Mandant die Erklärung sieht

### Mandanten-Portal-Sicht

- `/portal/steuer` listet alle freigegebenen Erklärungen mit Saldo,
  Disclaimer „nicht rechtsverbindlich"
- Wenn der zugehörige Bescheid eingegangen + ab Status GEPRÜFT freigegeben:
  grüner Bestätigungs-Block mit Ist-Beträgen, Abweichung zur Erklärung,
  basisabhängig bezeichnetem Ausgangsdatum und Download des Bescheid-PDF. Der
  Einspruchsfrist-Kontrollvorschlag erscheint nur bei `CALCULATED` ohne offenen
  manuellen Prüfbedarf
- Vor GEPRÜFT: dezenter Hinweis „Bescheid liegt vor und wird von Ihrer
  Kanzlei geprüft."

## Rechnungen ⚙

Modus-Wahl pro Kanzlei:

- **`IN_APP`**: vollständige Erstellung in taxtronik
  - XRechnung 3.0.2 CII-XML-Generierung für B2G-E-Rechnungen — besteht den
    KoSIT-Validator (Schema + Schematron inkl. BR-DE); CI-Job
    `e-rechnung` validiert gegen den gepinnten Validator
  - ZUGFeRD/Factur-X-Hybrid-PDF mit eingebettetem XML; der aktuelle Generator
    erhebt keinen Anspruch auf eine strikt validierte PDF/A-3-Datei
  - **Technische GoB-Kontrollen**: automatische lückenlose Rechnungsnummern
    je Jahr, DB-seitige Festschreibung nach Versand, Statusübergänge nur
    vorwärts, GoBD-Archivkopie vor Versand, Schutz abgerechneter Zeiteinträge
  - **USt-Satz je Position** (19 % / 7 % / 0 %) mit Steuerausweis und
    Rundung je Satz-Gruppe in Anzeige, PDF und E-Rechnung
  - Status-Maschine: DRAFT → SENT → PAID / OVERDUE / CANCELLED
  - Time-to-Invoice: nicht abgerechnete Zeiteinträge eines Mandanten direkt
    in Rechnungspositionen umwandeln
  - Worker markiert überfällige Rechnungen täglich, schreibt Notification
  - CSV-Export, XRechnung- und ZUGFeRD-Download pro Rechnung
- **`EXTERNAL`** (Default): Erstellung extern (z. B. zentrale
  DATEV-Abrechnung bei Partnerschaft mit mehreren Standorten), taxtronik
  versendet nur eine Standard-Mail mit PDF-Anhang. Konfigurierbarer
  Markdown-Begleittext mit Platzhaltern `{name}`, `{client}`, `{number}`,
  `{amount}`
- **`OFF`**: Modul komplett deaktiviert

Rechnungen anlegen/bearbeiten und versenden sind zusätzlich über
granulare Einzelrechte pro Mitarbeiter steuerbar (siehe
Benutzer-Verwaltung). Versendete Rechnungen sind für den Mandanten im
Portal als PDF abrufbar.

## Vollmachten ⚙

Modus-Wahl pro Kanzlei:

- **`MARKDOWN_OTP`**: Vollmachts-Text als Markdown in der App,
  Mandant bestätigt per E-Mail-Magic-Link + 6-stelligem E-Mail-Code. Der
  Nachweis wird **nicht** als fortgeschrittene oder qualifizierte elektronische
  Signatur (AES/QES) zugesagt
- **`PDF_TEMPLATE`** (Default): Standardtext + PDF-Anhang per Mail an Mandant.
  Konfigurierbarer Subject/Markdown-Body mit Platzhaltern `{name}`, `{client}`.
  Für Kanzleien mit externer Vollmachtsdatenbank
- **`OFF`**: Modul komplett deaktiviert

Status-Maschine: DRAFT → SENT → SIGNED / REVOKED. Audit-Log mit IP +
User-Agent bei Signatur.

## Workflow-Vorlagen ⚙

- Wiederkehrende Prozesse als Checklisten-Vorlagen
  (z. B. „Neuer Mandant", „Jahresabschluss-Prozess", „Lohn-Monatslauf")
- Vorlagen-Editor mit beliebig vielen Schritten, **Drag-and-Drop-Sortierung**
  (Pointer-Events, ohne externe Library)
- Pro Schritt: Titel, Beschreibung, Fälligkeit (Tage nach Start),
  empfohlene Tätigkeit (Skill)
- Standard-Tätigkeitsbereich pro Vorlage
- Vorlagen aktivieren/deaktivieren, Löschen wenn keine Instanzen vorhanden
- Pro Mandant Workflows starten — Items werden mit relativen
  Fälligkeitsdaten erzeugt
- Items: Häkchen-Toggle mit doneByStaff-Stamping, Inline-Assignment-
  Dropdown pro Mitarbeiter, Skill-Badge sichtbar, Überfälligkeits-Warnung
- Mitglieder- und Aufgaben-Zuweisungen folgen der Mandanten-Zugriffspolicy:
  `OPEN` erlaubt alle aktiven Tenant-Mitarbeiter, `RESTRICTED` und
  vertrauliche Mandanten nur tatsächlich Zugriffsberechtigte
- Automatisches Schließen der Instanz wenn alle Items erledigt
- **Workflow-Statistik** unter `/staff/workflows/stats`: pro Vorlage
  Ø Durchlaufzeit (Start → COMPLETED), Anzahl aktiver/abgeschlossener/
  abgebrochener Instanzen, **Engpass-Schritt** (Position mit längster
  durchschnittlicher Bearbeitungszeit über alle Instanzen)

## Form-Builder (eigene Anfrage-Formulare an Mandanten) ⚙

- Vorlagen pro Kanzlei (z. B. „Steuerunterlagen 2025", „Fahrtenbuch",
  „Lohnstammdaten")
- 12 Feldtypen: Text/Textarea/Zahl/Geldbetrag/Datum/E-Mail/Telefon/
  Auswahl/Mehrfachauswahl/Häkchen/Datei-Upload/Hinweistext
- Pro Feld: Pflicht-Toggle, Hilfetext, Min/Max, Optionen, Default-Wert
- Drag-and-Drop-Sortierung der Felder
- Auto-Slug aus Label, Schlüssel-Eindeutigkeits-Check
- Pro Mandant Formular versenden, Status-Übersicht
- Status-Maschine: PENDING → DRAFT → SUBMITTED → REVIEWED
- Mandant füllt im Portal aus, kann Entwurf speichern oder absenden
- **FILE-Feldtyp mit echtem Upload** direkt im Wizard
  (ClamAV-Scan + privater Object-Storage, max. 10 MB pro Datei; Klassifikation
  `GENERAL` ohne gesetzlichen Object Lock); Mandanten können einen Upload vor
  der Formularabgabe wieder verwerfen
- Grundlegende Pflichtfeld-Rückmeldung im Client; vollständige serverseitige
  Feldvalidierung (Pflicht, Typ/Format, Min/Max, freigegebene
  Auswahloptionen und Dateireferenz)
- Antworten typgerecht angezeigt (Geld als €-formatiert, Datum,
  Multiselect als Liste, Datei verlinkt zum Download)
- „Als geprüft markieren" mit optionaler Notiz
- **Verknüpfung mit Anforderungs-Vorlagen** — siehe Anforderungen
- n8n-Events `request.opened` / `request.responded` für Mail-Trigger

## Dashboard-Widget-Builder

- Persönliches Layout pro Mitarbeiter (Layout als JSON in
  `staff_user.dashboard_layout`)
- **12-Spalten 2D-Grid** mit Android-Style-Edit-Modus:
  - „Anpassen" schaltet Drag/Resize an
  - Widgets per Maus an beliebige Position ziehen
  - Resize-Handles an Ecke (SE), rechtem (E) und unterem (S) Rand
  - Auto-Reflow (vertical compact) verhindert Lücken
  - X-Knopf entfernt Widget, Plus-Bar fügt hinzu
  - Debounced Auto-Save (600 ms)
  - „Standard"-Knopf für Reset
- 12 Widget-Typen:
  - 6 KPI-Karten (Mandanten, Offene Anforderungen, Dokumente,
    **Offene Telefonzettel** (`doneAt: null`), Stammdaten-Anträge,
    Laufende Workflows)
  - 6 Listen-Widgets (Letzte Aktivitäten, Fällige Anforderungen,
    GwG-Ablauf, Ungeprüfte Bescheide, Nächste Steuertermine,
    **Meine Wiedervorlagen**)
- Listen-Widgets pre-fetchen 20–25 Items mit schlanker Custom-Scrollbar
- **Bewusst keine Mitarbeiter-Überwachungs-Widgets**
  (keine pro-Mitarbeiter-Stunden, Reaktionszeiten, Quoten)

## Zeiterfassung ⚙

- Start/Stop-Timer + manueller Eintrag mit Mandanten-Zuordnung
- Stundensatz pro Eintrag, abrechenbar/intern-Flag
- Verlinkt nach Abrechnung mit Rechnung (kein Doppel-Abrechnen)
- Pro Mandant Übersicht der unfaktrierten Stunden
- **Keine Mitarbeiter-Vergleichs-Auswertungen** (bewusst weggelassen,
  vertrauensbasierte Kanzleikultur)

## Telefonzettel ⚙

- Eingehende Telefonate notieren (Anrufer, Telefon, Betreff, Body)
- An Mitarbeiter weiterleiten (`forwardToStaff`)
- **Personenbuch / Autocomplete**: bekannte Anrufer (aus früheren Notizen)
  werden vorgeschlagen, Telefonnummer + Mandanten-Zuordnung werden
  automatisch übernommen
- Pro Mandant in der Detail-Seite sichtbar: im Zugriffsmodus **OPEN** für alle
  aktiven Mitarbeiter, bei **RESTRICTED** oder vertraulichem Mandanten nur für
  Admin/Partner und zugeordnete Berufsträger/Hauptbearbeiter
- **Inline-Anlage** im Mandanten-Detail-Cockpit per Klappformular
- **Lifecycle-Status** (`doneAt` + `doneByStaff`)
  - „Erledigt" ist eigenständig von „gelesen" — ein Zettel ist erst fertig,
    wenn der zugewiesene Mitarbeiter zurückgerufen hat
  - Check-Button setzt `doneAt`, Rotate-Icon nimmt zurück
  - Widget aufgeteilt in Offen/Erledigt-Sektion (collapsible)
- **Übertragen** — Inline-Dropdown zum Reassignment an anderen
  Mitarbeiter; setzt `readAt` zurück und schickt Notification an neuen
  Empfänger; nur auf offenen Zetteln möglich
- **→ Wiedervorlage** — legt einen eigenständigen, über `phoneNoteId`
  verknüpften `ClientReminder` an (Datum + Empfänger wählbar, Betreff/Body
  wird übernommen); ein Telefonzettel kann bewusst mehrere Wiedervorlagen für
  verschiedene Sachverhalte erhalten und bleibt bis zum manuellen Erledigen
  offen. Verknüpfte Wiedervorlagen erscheinen am Zettel mit Status,
  Fälligkeit und Detail-Link; die Aktion ist nur bei Mandantenbezug sichtbar
- Gesamtansicht unter `/staff/phone-notes` mit denselben Inline-Aktionen +
  Mandanten-Link

## Wiedervorlagen ⚙

- Eigenständige Tickets mit dauerhafter kanzleiweiter Nummer `#123`, Titel,
  Fälligkeit, optionalem Mandantenbezug und mehreren Zuständigen (Default: Ersteller)
- Übersicht mit An mich / Von mir / Alle zugänglichen, Zustandsfilter
  Offen / Erledigt / Archiv, Suche nach Nummer oder Titel und Seitennavigation
- Automatische Verweise und Rückverweise durch `#123` in neuen Beschreibungen
  und Kommentaren; aktuelle Sichtbarkeit wird für jedes Ziel erneut geprüft
- Archivieren erledigter Tickets durch Ersteller, Admin oder Partner; Nummer,
  Kommentare und Kontext bleiben erhalten. Zurückholen behält den Arbeitsabschluss
- Fester Recherche-Herkunftsbezug bleibt auch bei erneuter Delegation bestehen;
  vorhandene UUID-Links bleiben neben kurzen Nummernlinks gültig
- Bei mandantenbezogenen Wiedervorlagen werden Zuweisungen ebenfalls gegen
  `OPEN`/`RESTRICTED` und das Vertraulich-Flag geprüft; rein interne
  Wiedervorlagen benötigen nur einen aktiven Tenant-Mitarbeiter
- Inline-Block am Mandantendetail mit offenen + erledigten Sektionen
- Dashboard-Widget „Meine Wiedervorlagen" (Items mir zugewiesen oder von
  mir erstellt ohne Assignee)
- Worker `reminders-daily` schickt zur Fälligkeit eine Notification an
  Bearbeiter/Ersteller; idempotent über (resourceId, kind, day-bucket)
- Audit-Trail einschließlich Anlage, Abschluss, Archivierung und Wiederherstellung
- [Bedienung und Grenzen der Ticketverweise](docs/anwenderdoku/wiedervorlagen.md);
  Fachkatalog `REMINDER-TICKET-001` (ungeprüfter Entwurf)

## Fristenkontrollbuch

Vereinheitlichte Kontrollsicht `/staff/fristen` über alle fünf
fristenführenden Quellen — Steuertermine, Bescheidprüffälle/Einspruchsfristen,
Klagefristen, Anforderungs-Fälligkeiten und Wiedervorlagen.

- **Kein eigener Zustand**: Die Ansicht liest den aktuellen Status aus den
  Quellmodulen, sodass keine zweite manuelle Statuspflege entsteht. Ihre
  fachliche Richtigkeit bleibt aber von Quellstatus, Abschlussgrund und
  Nachweisen abhängig
- Offene Fristen erscheinen bis zum Horizont **ohne untere Grenze** — eine
  überfällige Frist verschwindet nie durch Zeitablauf; Erledigte als
  Rückschau im gewählten Fenster (7/30/90 Tage)
- Gruppierung nach Dringlichkeit (Überfällig / Heute / Diese Woche /
  Später), Filter „Meine" (Verantwortlicher = Hauptbearbeiter des
  Mandanten, bei Wiedervorlagen die Zuweisung)
- Aktuelle Wahrheitstabellen verlangen mehr als einen Status: Steuertermine
  schließen nur mit `DONE` samt Zeit/Person, Einspruchs- und Klagefristen nur
  mit dokumentierter Einlegung oder Bestandskraft-Disposition, Anforderungen
  nur mit `CLOSED` samt Zeit/Person und Wiedervorlagen nur mit dokumentiertem
  Abschluss. `SKIPPED`, `RESPONDED` und `CANCELLED` bleiben offen.
  Nach Fristende dokumentierte Einsprüche oder Klagen bleiben als
  Wiedereinsetzungs-/Dispositionsfall offen; ein strukturierter
  Wiedereinsetzungsworkflow ist noch nicht implementiert.
  `TEILABHILFE` erzeugt keine Klagefrist; die lineare Modellgrenze für
  parallele Teilverfahren bleibt. Eine bereits nach einer
  Teil-Einspruchsentscheidung persistierte Klagefrist bleibt auch bei einem
  späteren Status `ABGEHOLFEN` bis zum Einreichungs- oder vollständigen
  Dispositionsnachweis offen
- Fehlt wegen ungeklärter Bekanntgabe-/Nachweislage eine berechenbare
  Einspruchsfrist, bleibt ein vorhandener `internalRiskDeadline` als deutlich
  bezeichneter **interner Prüftermin** offen. UI, CSV und Tagesabschluss nennen
  ihn ausdrücklich keine Rechtsbehelfsfrist; eine echte Einspruchsfrist
  verdrängt den Prüffall. Ein eigener strukturierter Abschlussgrund „nicht
  anwendbar“ ist für diesen Prüffall noch nicht implementiert
- **Tägliche Abschlusskontrolle**: Admin/Partner können einmal pro Tenant und
  Kalendertag einen append-only Snapshot aller heute fälligen und überfälligen
  offenen Fristen dokumentieren. Bei offenen Positionen ist eine
  Eskalationsnotiz Pflicht. Quellabfragen und Insert verwenden einen
  konsistenten `REPEATABLE READ`-Lesestand; Stichtag, Snapshot- und
  Abschlusszeit stammen von der Datenbank. Die Einträge enthalten nur Quelle,
  technische Kontrollart (`CALCULATED_CONTROL_PROPOSAL`,
  `REVIEW_PENDING_CONTROL_PROPOSAL`, `INTERNAL_RISK` oder
  `OPERATIONAL_DUE_DATE`), Fälligkeit und pseudonyme UUID-Referenzen, keine Namen oder Fachtitel;
  Abschluss und Zählwerte werden auditiert. Der
  Snapshot führt keine fristwahrende Handlung aus, versendet keine Eskalation
  und erzwingt weder einen bestimmten Arbeitsschluss noch Vier-Augen-Prüfung.
  UUIDs und die freie Eskalationsnotiz bleiben aufbewahrungsrelevante Daten
- **CSV-Export als auditierter Kontrollauszug** (Fälligkeit,
  Verantwortlicher, Status, erledigt am/von) — jeder Export als
  `fristen.export.csv` in der Audit-Hash-Chain, rate-limitiert. Der Export
  ist kein Beweis der fristwahrenden Handlung und kein vollständiger
  historischer Erledigungsnachweis
- Zugriffsmodell: RESTRICTED-/vertrauliche Mandanten gefiltert (identisch
  zu Kalender/Exporten)

## Pendelordner ⚙

- Physische Belege-Ordner-Übergaben verfolgen (Kanzlei → Mandant)
- Status PREPARED → WITH_CLIENT → RETURNED → COMPLETED mit Auto-Stamping
  der jeweiligen Zeitstempel (`sentAt` / `returnedAt` / `completedAt`)
- Erwartetes Rückgabedatum (`expectedReturnAt`) + Inhaltsliste als
  Freitext
- Overdue-Indikator wenn `status='WITH_CLIENT' AND expectedReturnAt < heute`
- Worker `reminders-daily` schickt täglich eine Notification an den
  Ersteller bei überfälligen Pendelordnern
- Block am Mandantendetail + Aktion-Buttons „Ausgegeben / Zurückerhalten /
  Abgeschlossen"

## Anlieferungen ⚙

Gegenstück zum Pendelordner (Modul `handovers`): vom Mandanten physisch
bei der Kanzlei angelieferte Unterlagen verfolgen — vom Eingang bis zur
Abholung.

- Label + Inhaltsbeschreibung, Block am Mandantendetail
- Status RECEIVED → IN_PROGRESS → READY → PICKED_UP mit Zeitstempeln
- Bei „Abholbereit" (READY) Benachrichtigungs-Mail an den Ansprechpartner
- Portal-Sicht `/portal/handovers` zeigt dem Mandanten den Status
  (zusätzlich über Portal-Feature-Flag `handoversView` abschaltbar)
- Audit-Trail über `client_handover.*`

## RSS-Reader ⚙

Pro Mitarbeiter abonnierte RSS-Feeds — aus dem ursprünglichen
„BMF/BFH News"-Widget zu einem generischen Reader entwickelt.

- `RssFeed` pro Mitarbeiter: Name, URL, Farbwahl, sort_order, active-Flag
- **BFH + BMF werden für bestehende und neue Staff automatisch geseedet**
  (`seedDefaultRssFeeds` läuft in der Migration und im `createUserAction`)
- Worker `tax-news-fetch` (05:30 UTC täglich) zieht **distinct URLs** aus
  allen aktiven Abos — BMF wird nicht 20× geholt, auch wenn 20 User es
  abonnieren
- `tax_news_item` bleibt globaler Item-Cache mit `source = feedUrl`
- **Inline-Verwaltungs-Klappe im Widget** (Zahnrad-Icon):
  - Liste eigener Feeds mit Checkbox (aktivieren/deaktivieren)
  - Trash-Icon zum Entfernen
  - Add-Form (Name + URL + 7 Farboptionen für das Badge)
  - „Defaults"-Knopf seedet BMF+BFH neu, falls der User sie gelöscht hat
- Items im Widget gefiltert auf eigene aktive Feed-URLs; Badge zeigt
  konfigurierte Farbe pro Feed
- Notifications nur an `staff_user.tax_news_notify=true`-User, die diesen
  Feed aktiv abonniert haben

## Abwesenheiten

- Urlaubsantrag (Mitarbeiter beantragt; ADMIN/PARTNER oder Mitarbeiter
  mit Einzelrecht „Urlaub entscheiden" entscheidet)
- **Generische Abwesenheitsmeldung** (aus der früheren Krankmeldung
  erweitert): Krankheit oder Sonstiges (Fortbildung, Sonderurlaub …) mit
  optionalem Bescheinigungs-Upload (z. B. AU); Benachrichtigung an die
  Entscheidungsträger
- Abwesenheiten erscheinen als Einträge im Kanzleikalender
- Wandkalender für alle Mitarbeiter (4/8/12 Wochen)
  - Grün = Urlaub; sonstige Abwesenheit neutral als „abw." ohne
    Grund-Anzeige (Krankheit ist für Kollegen nicht erkennbar);
    Wochenenden ausgegraut
  - Reine Sichtbarkeit zur Absprache, kein Vergleich/Quoten

## BWA, Hochrechnung & Planung ⚙

### Import

- BWA-Perioden importieren als **XLSX (DATEV-Vorjahresvergleich)** oder
  **CSV (Addison)** mit Auto-Erkennung der Langform `a*.csv`
  (`Nummer;Bezeichnung;…`) vs. Kompaktform `s*.csv` (Erlöse / BE / Personal
  / Kosten / Vorl. Ergebnis als Spaltenüberschriften)
- Bekannte Mapping-Grenze: DATEV 1051 (Gesamtleistung) wird intern als
  `revenue`, DATEV 1300 (Betriebsergebnis) ersatzweise als `resultBeforeTax`
  geführt; das ist keine fachliche Gleichsetzung mit Umsatzerlösen
  beziehungsweise Ergebnis vor Steuern
- Idempotenter Re-Import: existierende Perioden werden übersprungen
- Periodenvergleich mit Vorjahr / Vorquartal, Score-Card-Engine

### Liquiditäts-Indikatoren (Portal + Staff)

Aus PNL-Werten abgeleitete Frühwarn-Indikatoren — keine Bilanzkennzahlen
(Disclaimer dauerhaft sichtbar):

- Operativer Cashflow-Proxy = Ergebnis + Abschreibungen
- Cashflow / Monat (rot bei negativ)
- Marge + Personalkostenquote mit Trend-Pfeilen (auf-/ab gegen Vorperiode)
- Frühwarnungen in amber Card: negativer Cashflow / Marge < 5 % rückläufig /
  Personalquote > 55 % steigend

### Jahres-Hochrechnung — zwei Strategien nebeneinander

- **Lineare Run-rate**: YTD-Werte mit `12 / erfasste Monate` aufs Jahr
  hochgerechnet; heuristische, mit zunehmender Datenabdeckung enger werdende
  Spanne. Eine echte Saisongewichtung wird mangels Vorjahres-Monatsverteilung
  nicht behauptet.
- **Trend-Regression (bekannte Abweichung)**: Der aktuelle Filter nimmt alle
  zwölfmonatigen `YEAR`-Perioden und begrenzt sie nicht auf Jahre vor dem
  Zieljahr. Die heuristische Spanne ist das Maximum von 1,5 ×
  Residuen-Standardabweichung und 5 % des Schätzwerts (kein statistisches
  Konfidenzintervall)
- Pro KPI (Erlöse / Kosten / Personal / Ergebnis vor Steuern / Steuern /
  Ergebnis nach Steuern): Erwartungswert + low/high-Spanne
- **Steuer-Pauschale**: 30 % Mittelwert (25–35 % Spanne) auf positives
  Ergebnis vor Steuern; bei Verlust → 0
- Disclaimer „eine BWA ist kein Abschluss" + Hinweis auf fachliche
  Beratung

### Eigene Planrechnung (Mandanten-Self-Service)

- 3-Schritt-Wizard auf `/portal/bwa/plan/new`:
  1. Name + Planjahr + Basis-Periode wählen, Quick-Buttons −10/−5/0/+5/+10/
     +20 % UND freie Prozent-Eingabe — Live-Vorschau zeigt sofort, was die
     Buttons gemacht haben (selektierter Button bleibt aktiv markiert)
  2. 7 Achsen anpassen: Erlöse / Sonstige Erträge / Personalkosten /
     Material / Abschreibungen / Sonstige Kosten / **Steuern**
     (Auto-Schätzung ~30 %, frei überschreibbar) — Live-Totals
     für Erträge / Aufwendungen / Ergebnis vor + nach Steuern
  3. Notizen / Annahmen + Status-Wahl (FINAL Default, DRAFT optional)
- Mehrere Versionen pro Jahr, Status DRAFT/FINAL
- Plan-Detail-Editor mit allen Achsen, Markdown-Notizen, Lösch-Funktion

### Plan ↔ Hochrechnung im Portal + Staff

- Eigener Block „Plan vs. Hochrechnung" mit Plan-Dropdown
  (Default: neuester FINAL-Plan)
- Pro Position: Plan / Hochrechnung / Δ absolut / Δ % mit Trend-Pfeilen
- Aufwand-Positionen invertieren die Richtung (weniger Kosten = grün)
- Hervorgehoben: Ergebnis vor Steuern + Ergebnis nach Steuern

### Szenario-Vergleich (mehrere Pläne + Mehrjahres-Sicht)

- Checkbox in der Plan-Liste — beliebig viele Pläne nebeneinander
- Optional Hochrechnung als zusätzliche Spalte
  (Default an, brand-getönt, Dark-Mode-tauglich)
- **Mehrjahres-Sortierung automatisch**: Pläne aus mehreren Jahren werden
  chronologisch in die Spalten einsortiert — inkl. Hochrechnung als
  „Bridge" im aktuellen Jahr
- Footer mit Totals (Erträge / Aufwendungen / Erg. vor + nach Steuern)

### Spiegelung im Staff-Bereich

- `/staff/clients/:id/bwa/plans` zeigt **dieselbe Dashboard-Sicht** wie der
  Mandant im Portal — gleiche Liquidität, Hochrechnung, Plan-vs-Hochrechnung,
  Plan-Vergleich, historische Tabellen
- Kanzlei kann:
  - Mandanten-Pläne öffnen + bearbeiten
  - Eigene Gegen-Planung anlegen
  - Pläne löschen
- **Actor-Badges** zeigen Herkunft pro Plan:
  - Lila „Mandant" — vom Mandant erstellt
  - Blau „Kanzlei" — von der Kanzlei erstellt
  - „Mandant → Kanzlei" — Übergang sichtbar, wenn jemand anderes
    zuletzt bearbeitet hat
- Plan-Detail-Page zeigt Erstellt-/Geändert-von mit Namen + Zeitstempel
- Server-Actions mit `.bind()`-Pattern (clientId pre-bound) bleiben
  serialisierbare Server-Actions
- Schema: `BwaPlan.updatedBy` + `updatedByType` tracken
  zuletzt-bearbeitet-von (Iter. 27)

### Datenmodell

- `bwa_period` + `bwa_position`: importierte BWAs pro Mandant/Zeitraum
- `bwa_plan` + `bwa_plan_line`: 7-Achsen-Planung pro Mandant
- Plan-Position als `(planId, axis)` unique; Achsen-Enum:
  REVENUE / PERSONNEL / OTHER_COSTS / DEPRECIATION / MATERIAL /
  OTHER_INCOME / TAXES
- Migrationen Iter. 26 (`20260608…_iter26_bwa_plan`) und
  Iter. 27 (`20260609…_iter27_bwa_plan_updated_by`)

## Subsumtions-Workspace / TCMS ⚙

Zwischenlayer für ein Tax Compliance Management System. Eine eigenständige,
**on-prem** Analyse-Engine (drei Schichten: wörtlich/Muster/Trigger
deterministisch, Embedding semantisch, optional LLM) wird als **zustandsloser**
`/v1/*`-Dienst angesprochen — taxtronik ist die datenführende, mandanten- und
identitätstragende Hülle und persistiert alles tenant-scoped (RLS). Die
LLM-Schicht läuft netzintern ohne offenen Port; Mandantendaten verlassen die
Kanzlei nicht.

### Zugang & Aktivierung

- Modul `risk` pro Tenant **plus** konfigurierte Engine (URL + Bearer-Token) —
  beides nötig, sonst ist die Subsumtion nicht sichtbar
- `RISK_LAYER_URL` ist ein trusted Operator-Backend-Ziel und darf Docker-Service-
  DNS, Loopback (`127.0.0.1`) oder eine interne IP enthalten; dafür ist kein
  `INTERNAL_FETCH_HOSTS`-Eintrag nötig
- Zugang: global ADMIN/PARTNER **oder** dem Mandanten zugeordneter
  Berufsträger/Hauptbearbeiter (`ClientResponsibility`)
- Jede Server-Action autorisiert über die **echte** Ressource (Analyse/
  Markierung), nicht über eine vom Client gelieferte `clientId` (kein IDOR)

### Sachverhalt erfassen

- **Eine Fläche**: formatierter, editierbarer Text (Tiptap) mit darüber
  liegendem Markierungs-Overlay — kein Moduswechsel
- Import aus **PDF/DOCX** (Server-Extraktion via `unpdf`/`mammoth`) oder aus
  einem vorhandenen Mandanten-Dokument (app-proxied aus SeaweedFS, Zugriff als
  Download auditiert)
- Stabile Zeichen-Offsets + `textHash` — Voraussetzung für reproduzierbares
  Overlay und Audit; nur Formatierung speicherbar, inhaltliche Textänderung
  hält die Offsets (sonst neue Analyse)

### Analyse — zweiphasig

- **Schnell/deterministisch** (synchron in der Server-Action): wörtliche,
  Muster- und Trigger-Treffer mit Normankern/Normketten
- **KI-Vertiefung** (asynchroner Worker `risk-analyse-llm`): zusätzliche
  EMBEDDING/LLM-Markierungen; der llama-server wird **on-demand** hochgefahren
  und bis zur Bereitschaft gepollt. UI bleibt nutzbar (Skeleton + Auto-Select
  der neuen Markierungen), ein **fehlgeschlagener Lauf** wird sichtbar gemacht
  mit „Erneut versuchen" statt endlosem „lädt"
- Der Engine-Status trennt API-Liveness, Embedding- und LLM-Bereitschaft,
  tatsächlich aktives CPU-/GPU-Backend, Performance-Bottleneck und belegte
  Inferenz-Slots; eine erreichbare API wird nicht als modellbereit ausgegeben
- **„Neu analysieren"**: nicht-destruktiver Merge — nur neue Markierungen
  werden ergänzt, die Berater-Bewertungen bleiben erhalten

### Markieren & Entscheiden (Governance-Matrix)

- Engine-Markierungen farbcodiert nach **Herkunft** (wörtlich · Muster ·
  Trigger · Heuristik · LLM · Berater), fachlich umstrittene Stellen
  gestrichelt; überlappende Markierungen werden mehrschichtig (Tracks)
  dargestellt, Hover hebt die zusammengehörige Spanne hervor
- Pro Markierung: Begriff, **Fundstelle** (markierter Text), Herkunft,
  Engine-Status, Normanker, Normketten (Kaskade) und **Rechtsnormen mit
  ausklappbarem Gesetzestext** (`/v1/normgraph` löst die Norm-ID auf)
- **Governance-Matrix**: FP/FF/IN, Schadensintensität, Wahrscheinlichkeit,
  Kaskadenreichweite, Kontrolle/Maßnahme, Prüf-Status, Verantwortlich, Notiz,
  Label/Kategorie, Farbe
- **Eigene Markierung** (Textselektion → Herkunft BERATER) mit Farbe, Label
  und Normanker; Offsets/markierter Text werden serverseitig abgeleitet
- **Audit**: jede Mutation hängt im selben Transaktion in der TaxTronik-
  Hash-Chain — die Engine führt **kein** Audit

### Delegation & Recherche

- **An Mitarbeiter zuweisen** → erzeugt eine Wiedervorlage (`ClientReminder`)
  mit Kontext-Ankern (Begriff/Norm/Analyse), setzt Verantwortlichkeit + Status
  „In Prüfung"; der/die Zuständige muss aktiver Mitarbeiter des Tenants sein
- Markierungen mit offener Delegation oder ausstehender Antwort zeigen diesen
  Zustand direkt in der Subsumtionsschicht und verlinken wahlweise zur
  Wiedervorlage/Delegation oder zum unmittelbaren Anlegen der Definition
- **Rechercheauftrag an n8n — technische Datenminimierung, kein §-203-Nachweis**:
  der Berater wählt,
  was mitgeht (kein/Auszug/ganzer Sachverhalt · Textbausteine · freier Prompt);
  deterministische Schwärzung der bekannten Stammdaten + heuristische Treffer
  (Firma, IBAN, Steuernummer, Betrag, Datum, **E-Mail**) in einer
  hervorgehobenen, **editierbaren Vorschau**; das Platzhalter→Original-Mapping
  verlässt die Kanzlei nie (RLS-geschützt gespeichert)
- Bekannte Versandgrenzen: frei befüllbare Normanker werden unverändert
  übertragen; die Vorschau ist serverseitig nicht per Token/Hash gebunden und
  getrennte Mappings für Text, Rechtsfrage und Auftrag können bei gleichen
  Platzhalternamen kollidieren. Die Funktion gewährleistet daher weder
  vollständige Anonymität noch die Zulässigkeit der Offenbarung.
- **Kanzleiweite, selbst anlegbare Prompt-Vorlagen**
- **Rechercheergebnisse-Ablage**: tenantgebundener n8n-Callback
  (Bearer-Credential, `research:write`-Scope, einmalige Request-ID);
  per Korrelations-Token automatische Zuordnung zur Ursprungs-Markierung +
  De-Anonymisierung, sonst heuristischer Zuordnungs-Vorschlag (Normanker-/
  Begriff-Overlap)

### Export, Katalog & Archiv

- Bericht als **DOCX/PDF**; Auswahl, welche Markierungen übernommen werden
  (gruppiert nach Herkunft ab-/zuwählbar)
- **Begriff in den Katalog definieren** (`/v1/katalog/definiere`) — Engine
  bleibt kanonische Katalog-Quelle (keine lokale Katalog-Tabelle)
- Revisionssichere **Archivierung** (GoBD-Snapshot, Object-Lock,
  schreibgeschützt)

### Datenmodell & Integration

- `risk_analysis` + `risk_marking` (Normanker/Normketten/Governance als
  erstklassige Spalten), `risk_research_request`/`risk_research_result`
  (sensibles Mapping RLS-geschützt), `risk_prompt_template` — alle tenant-scoped
  mit RLS-Policy (USING + WITH CHECK)
- Paket `@taxtronik/risk-layer` als reiner Transport (Schema/Mapping/Resilienz
  mit Circuit-Breaker + `safeFetch`); App-Geschäftslogik in
  `apps/web/src/server/risk/`

### Quantenlos — blind gezogene Compliance-Stichproben

- Admin-Oberfläche `/staff/admin/quantenlos` innerhalb des aktivierten
  Risk-Moduls; Stichprobenrahmen wahlweise aus Subsumtionsanalysen oder
  Audit-Ereignissen eines Zeitraums
- Backends `qpu`, `simulator` und `csprng`; asynchrone QPU-Jobs werden als
  wartend tenantgebunden persistiert und später explizit abgeholt
- Der vor der Ziehung festgelegte Rahmen wird als Commitment gebunden. Der
  Nachweis enthält Rahmen, Backend-Metadaten und gezogene IDs und wird im
  manipulationsgeschützten Audit-Ereignis `risk.los.gezogen` abgelegt
- „Nachweis prüfen" übermittelt den gespeicherten Nachweis **zusammen mit dem
  damals gebundenen Rahmen** an `/v1/los/pruefen`; es wird keine neue Ziehung
  mit vermeintlich identischen Inputs durchgeführt
- Für gezogene Subsumtionsfälle mit Mandantenbezug entstehen automatisch
  14-Tage-Wiedervorlagen; Audit-Stichproben werden nur in der Ergebnisliste
  ausgewiesen. Die Nachschau bleibt fachliche Aufgabe der Kanzlei.
  Quantenrandomness beweist weder Vollständigkeit des Rahmens noch fachliche
  Angemessenheit der Stichprobenparameter

## Wissensdatenbank ⚙

- Artikel + Kategorien
- Postgres-Volltext-Suche (deutsche Stemmer)
- Markdown-Editor

## Arbeitskorb & Mandantenpost ⚙

- Gemeinsamer Arbeitskorb unter `/staff/work` mit den Ansichten „Meine Arbeit“
  und „Team“, Quellenfilter sowie den Gruppen „Überfällig“, „Heute“, „Später“
  und „Ohne Termin“
- Zusammenführung von Mandantenpost, Workflows, Wiedervorlagen, Terminen und
  Telefonzetteln; Aktionen bleiben quellenspezifisch, sonst führen stabile
  Deep-Links zum Ursprungsdatensatz
- Separater asynchroner Mandantenposteingang, standardmäßig pro Kanzlei
  deaktiviert (`clientInbox: false`), mit neutralen Themen und automatischer
  Zuweisung nur bei genau einem berechtigten Hauptbearbeiter
- Mandantenweit sichtbare abgesendete Threads bei kontaktprivaten
  Uploadentwürfen; deutlicher Hinweis vor dem Senden, dass alle aktiven
  Portal-Kontakte des Mandanten Nachrichten und Anlagen sehen
- Sichere Anlagenannahme mit 10 Dateien, 25 MiB je Datei und 100 MiB je
  Nachricht, Magic-Byte-Prüfung, Virenscan und resumierbarem Staging
- Kein Archivdokument, OCR, Inhaltsindex, Frist- oder Workfloweffekt vor der
  ausdrücklichen Staff-Entscheidung; Titel und aktiver Dokumenttyp bestimmen
  serverseitig Schutzstufe, Storage und Retention
- Neutrale, inhaltsfreie Aktivitätshinweise; Betreff, Nachrichtentext und
  Dateinamen gelangen weder in E-Mail noch Notification oder gewöhnliche Logs

## Mandanten-Portal

- Magic-Link-Login (E-Mail), separate Auth-Surface mit eigenem Cookie
  - Im Dev wird der Link zusätzlich ins Server-Log geschrieben — kein
    Mailserver erforderlich zum Einloggen
- Anforderungen: Antworten + Dokumente hochladen, verknüpfte Formulare
  prominent verlinkt
- Formulare ausfüllen mit echtem Datei-Upload für FILE-Felder
- Dokumenten-Übersicht (eigene + von Kanzlei freigegebene)
- **Nachrichtenfach** (`/portal/inbox`): Metadatensuche, Themen-/Statusfilter,
  stabile 25er-Pagination, mobile Karten, Lesestand und schreibgeschützte
  erledigte Verläufe; kein Nachrichtenvolltext- oder Dateinamensindex
- **Stammdaten-Self-Service** (`/portal/stammdaten`): Mandant schlägt
  Änderungen vor, Verlauf mit Status (PENDING/APPROVED/REJECTED)
- **Steuererklärungen** (`/portal/steuer`): freigegebene Erklärungen mit
  Saldo + verknüpfte Bescheide ab Status GEPRÜFT
- **Termine** (`/portal/appointments`): eigene bestätigte Termine + Anfrage-
  Formular mit 1–3 Wunschterminen + optionalem Wunsch-Bearbeiter; Verlauf
  eigener Anfragen mit Status (PENDING/ACCEPTED/REJECTED/CANCELLED) +
  Rücknahme-Button bei PENDING; token-basierter iCal-Feed
  (`/api/portal/ical/:token`) zum Abonnieren der Termine
- **Auswertungen** (`/portal/bwa`): Liquiditäts-Indikatoren,
  Jahres-Hochrechnung (beide Strategien mit Spanne), Plan vs.
  Hochrechnung, eigene Planungen + Szenario-Vergleich
  (siehe „BWA, Hochrechnung & Planung")
- Rechnungen-Übersicht inkl. PDF-Abruf versendeter Rechnungen
- **Anlieferungen** (`/portal/handovers`): Status der bei der Kanzlei
  angelieferten Unterlagen bis „abholbereit" / „abgeholt"
- Einstellungen: E-Mail-Benachrichtigungen ein/aus pro Kontakt
- Sidebar-Footer: prominente „Darstellung"-Sektion mit UI-Mode + Theme-
  Toggle direkt über dem Abmelden-Button (zusätzlich in der Topbar)
- GwG-Onboarding-Wizard (token-basiert, kein Login nötig)

## Globale Suche

- Header-Suchfeld mit Live-Vorschlägen
- Sucht parallel in Mandanten, Dokumenten, Anforderungen, Wissensartikeln,
  Telefonzetteln

## Benachrichtigungen

- In-App-Notifications mit idempotentem Service (kein Spam)
- Header-Bell mit Dropdown (8 zuletzt) + ungelesen-Counter
- 30-Sekunden-Polling, pausiert wenn Tab im Hintergrund
- Öffnen über Navbar, Dashboard-Widget oder Benachrichtigungsseite markiert
  denselben Eintrag gelesen und synchronisiert den Zähler sofort
- „Alle gelesen"-Bulk-Action
- Volle Liste auf eigener Seite
- Quellgebundene Benachrichtigungen werden beim Abschluss bzw. bei der
  Freigabe des zugrunde liegenden Vorgangs automatisch erledigt. Wird ein
  Vorgang später wieder geöffnet oder erhält echte neue Aktivität, kann eine
  neue Benachrichtigung entstehen
- Notification-Kinds u. a. für GwG-Stufen (Soon/90/30/Expired,
  ID-Ablauf), **GwG-Pflichtlöschung** (`GWG_DELETION_DUE`, täglich an
  ADMIN/PARTNER bei löschreifen Belegen/Aufzeichnungen),
  Anforderungs-Antworten, Vollmachts-Signaturen, überfällige
  Rechnungen, Stammdaten-Änderungsanträge, Audit-Chain-Brüche,
  **Tax-Notice-Appeal-Reminder** (Einspruchsfrist 14/7/1),
  **Client-Reminder-Due** (Wiedervorlage fällig),
  **Pending-Binder-Overdue** (Pendelordner überfällig),
  **Appointment-Requested** (neue Mandanten-Terminanfrage),
  **Appointment-Decided** (Anfrage angenommen/abgelehnt),
  **Tax-Deadline-Request-Pending** (Vorwarnung vor dem automatischen
  Versand einer Steuertermin-Anforderung, mit Absprung zur Stopp-Aktion)
- Vor dem Daily-Insert werden bei Wiedervorlagen offener Zustand, Fälligkeit
  und aktuelle Zuweisung, bei Pendelordnern `WITH_CLIENT`-Status,
  Rückgabedatum und Ersteller erneut gelesen. Mandantenbezogene Empfänger
  müssen aktiv und aktuell zugriffsberechtigt sein; bei internen
  Wiedervorlagen wird die aktive Tenant-Zugehörigkeit geprüft

## DSGVO

- Anfragen-Verwaltung (Auskunft, Löschung, Berichtigung)
- Datenexport pro Mandanten-Kontakt als JSON: Stammdaten,
  Anforderungs-Antworten, Dokument-Metadaten (nur die dem Kontakt via
  Audit-Trail zugeordneten Dokumente), Vollmachten, Terminanfragen,
  Formular-Antworten, Telefonnotizen (Namens-Heuristik) + Verweis auf den
  Audit-CSV-Export; keine Datei-Downloads im Export, jeder Export
  auditiert
- Anonymisierung von Kontakten (`anonymized-<uuid>@taxtronik.local` /
  „Anonymisiert", Sessions revoked, Magic-Links invalidiert)
- Dienstleisterverzeichnis (Auftragsverarbeiter Art. 28/30 DSGVO,
  unter Admin/DSGVO einsortiert)
- DSFA-Vorlage + DSGVO-Lösch-/Aufbewahrungs-Konzept als Dokumentation
  unter `docs/compliance/`

## Compliance & Audit

- Hash-Chain-Audit-Log: Jeder Eintrag erhält einen eigenen UTC-
  Ereigniszeitpunkt (`occurredAt`, PostgreSQL `timestamptz(6)`) aus der
  App-/Hostuhr. Der ISO-Zeitpunkt ist Bestandteil der kanonischen Eventdaten
  und damit im Eintrags-Hash gebunden; Trigger blocken UPDATE/DELETE auf
  `audit_log`, `audit_anchor` und `audit_seal`
- **Dual Stamping / zwei gekoppelte Ketten**:
  - Die vollständige lokale Audit-Kette wird synchron in derselben Transaktion
    wie die Fachänderung fortgeschrieben.
  - `audit-anchor` verankert den neuesten committeten Ketten-Präfix alle zwei
    Sekunden asynchron über RFC 3161. Die Fachtransaktion wartet weder auf die
    TSA noch auf einen Anchor-Lock; weitere Audit-Einträge können während der
    Anfrage ohne Pause entstehen.
  - Die dünne externe Anchor-Kette bindet je Checkpoint lokalen ID-Bereich,
    rekonstruierten Spitzen-Hash und den SHA-256-Hash des vorherigen TSA-Tokens.
    Parallel laufende Worker können deshalb keinen persistierten Zweig bilden.
  - Rechnungs- und GwG-Ereignisse werden bei Rückstand bevorzugt. Exponentieller
    Retry, Admin-Status mit Auto-Refresh und Ops-Alarm ab anhaltendem Rückstand
    machen die verbleibende Verzögerung transparent.
  - Die TSA-`genTime` beweist, dass der verankerte lokale Präfix spätestens zu
    diesem Zeitpunkt existierte. Sie attestiert nicht den exakten
    `occurredAt`-Wert eines einzelnen Eintrags; zwischen lokalem Commit und
    externer Antwort bleibt prinzipbedingt ein kleines, sichtbares Fenster.
- Tagesversiegelung mit RFC-3161-Zeitstempel (TSA-Adapter) bleibt als
  zusätzlicher, unabhängiger Defense-in-Depth-Nachweis der Tageskettenspitze
- Verifikations-CLI: `pnpm verify:chain`
- **Persistiertes Chain-Verify-Ergebnis**: der tägliche
  `audit-verify-check`-Worker legt das Ergebnis als `TenantSetting`
  (`audit_verify_result`) ab; `/staff/admin/audit` zeigt es an (intakt /
  Bruch mit erster Bruchstelle / TSA-Probleme) statt bei jedem
  Seitenaufruf die Chain zu hashen. „Jetzt prüfen"-Button stößt einen
  neuen Lauf als BullMQ-Job an
- **Auth-/System-Ereignisse in der Audit-Chain**: `auth.login.success` /
  `.failure` / `.lockout`, `auth.totp.enroll`, `auth.backup_code.consume`,
  `auth.magic_link.consume` (Portal-Anmeldung) sowie `backup.run` — das
  OPEN-Zugriffsmodell wird mit Audit-Nachvollziehbarkeit begründet, also
  stehen auch Logins manipulationsevident in der Chain (kein Audit-Event
  bei unbekannter E-Mail — Anti-Enumeration)
- Audit-Log-Viewer (ADMIN/PARTNER) mit Filter, CSV-Export, Detail-Seite
  mit JSON-Diff vs. Vorgänger
  - Kombinierbare fachliche Kategorien und „Neueste/Älteste zuerst“; Ansicht
    und CSV verwenden dieselben Filter einschließlich Berliner Tagesgrenzen
  - Kategorien werden abgeleitet, unbekannte Ereignisse bleiben unter „Sonstige“.
    Hashreihenfolge und Gesamtverifikation bleiben unverändert; gefilterte
    Auszüge sind kein vollständiges Kettenarchiv
- Cross-Tenant-RLS-Tests (sequentiell, Vitest, in `packages/db`)
- Hash-Chain-, canonical-json- und RFC-3161-Verifikations-Tests in
  `packages/evidence/src/__tests__/`
- **Audit-Log-Rotation** („Kassenbon-Abriss")
  - Wöchentlicher Worker `audit-rotate` archiviert Segmente als
    hash-versiegeltes NDJSON im Object-Store (Object-Lock COMPLIANCE 10 J.)
  - Ein erhaltener RFC-3161-Token wird vor dem Persistieren gegen den
    tatsächlichen Datei-Hash und die konfigurierten Trust-Roots geprüft;
    bei TSA-Ausfall bleibt das explizite Feld `NULL` statt einen untrusted
    Nachweis zu speichern
  - `verify:chain` rekonstruiert die Chain durchgängig aus DB + Archiv-Dateien
    und prüft vorhandene Archiv-TSA-Token erneut; fehlende Token werden
    ausgewiesen und sind bei verpflichtender externer TSA ein Fehler
  - Admin-UI unter `/staff/admin/archive` mit Manual-Trigger
  - Nur SOFT-Rotation (DB bleibt); ein konfiguriertes
    `AUDIT_ARCHIVE_MODE=HARD` wird ehrlich auf SOFT normalisiert und pro
    Lauf als Warnung geloggt — `audit_archive` behauptet keinen
    DB-Cleanup, der nicht stattfand
- **GoBD-Verfahrensdokumentation aus dem IST-Zustand**: das Admin-Panel
  generiert die Verfahrensdoku aus der laufenden Konfiguration
  (Export über `/api/staff/admin/verfahrensdoku`)
- **Audit-Action-Labels** für 80+ Action-Keys und alle Resource-Types
  (inkl. der Auth-, Backup-, `gwg.check.destroy`- und
  `tax_notice.status`-Events) werden in „freundlichen" Views (Dashboard,
  Timeline, Notifications) deutsch übersetzt; Compliance-View bleibt
  technisch

## Backups & Disaster Recovery

- Postgres-Dump als lokale Operator-Kopie unter `backups/` und Upload in den
  S3-Backup-Bucket — manuell (`./taxtronik backup` /
  `pnpm --filter @taxtronik/web backup:run`) oder per Operator-Cron; jeder Lauf
  wird als `backup.run` in der Audit-Chain dokumentiert
- Automatischer Worker-Lauf `backup-run` täglich um 01:00 UTC: streamt den
  Postgres-Dump direkt nach S3 (ohne lokale Air-Gap-Kopie und ohne
  Dokument-Buckets); Fehlschläge fließen in Backup-Status und Health-Alarm ein
- Kanzleidateien-Export: `./taxtronik backup-files` schreibt die SeaweedFS-
  Dokument-Buckets (`gobd`, `gwg`, `general`, `staff-private`) nach
  `backups/object-store/<timestamp>/` (sichtbare Bytes, keine Versions-/Lock-
  Garantie)
- Versiegeltes Full-Backup: globaler Lock + Kapazitätsprüfung; App/Worker/n8n
  werden vor beiden DB-Dumps und Object-Export quiesziert, anschließend Cold-
  Snapshots von SeaweedFS/Redis/n8n erstellt. Gesamte Nutzlast + `.env` ist
  age-verschlüsselt; Ed25519-signiertes SHA-256-Inventar mit Key-Fingerprint
  erkennt fehlende/veränderte Dateien
- Optionaler Offsite-Vault: nur HTTPS, Bucket-Versioning und Default Object
  Lock COMPLIANCE mit konfigurierbarer Mindestdauer; Größe, RetainUntil und
  VersionId aller drei Artefakte werden als Receipt geprüft
- Recovery-CLI ohne vorhandene Produktiv-`.env`: `backup-verify` mit offline
  Public Key und `backup-decrypt` mit offline age-Identity in ein leeres Ziel
- Pre-Flight-DB-Backup vor Migration (`./taxtronik update`/`deploy`)
- Backup-Records mit Größe, SHA-256 und Status; letzter Stand und Restore-Drill
  sind in der Admin-Übersicht sichtbar. Start und Abruf vollständiger
  Datenbank-Dumps bleiben dem Betreiber-Host beziehungsweise Backup-Storage
  vorbehalten
- **Restore-Mechanismus**: `./taxtronik restore --list`,
  `./taxtronik restore --latest --target-url <postgres-url>` oder
  `./taxtronik restore --file <dump>`; automatischer Smoke-Test, Schutz vor
  Überschreiben durch `--confirm-overwrite`-Flag
- **Retention-/Object-Lock-Demodaten**: `pnpm demo:retention` erzeugt lokale
  GwG-Testfälle für löschreif/nicht löschreif sowie aktiven/abgelaufenen
  Governance-Lock
- **Monatlicher Restore-Drill**: Worker `backup-drill` (1. des Monats)
  spielt das jüngste Backup automatisch zurück und verifiziert die
  Audit-Hash-Chain auf der wiederhergestellten Datenbank
  (Art.-32-Nachweis)
- **Health-Alarme**: Worker `health-alert` prüft alle 5 Minuten
  Postgres / Redis / Object-Store / ClamAV und schickt Ops-Mails bei
  Ausfall und Erholung
- Produktions-Provisionierung ohne Demodaten:
  `pnpm --filter @taxtronik/db provision` legt Tenant,
  Default-Dokumenttypen und Admin-Konto an (Dev-Seed verweigert in
  Produktion, Doppel-Provisionierung wird erkannt)
- Disaster-Recovery-Runbook in `docs/operations/disaster-recovery.md`

## Update-Mechanik & Lizenzschlüssel

- Admin-UI prüft Update-Server auf neuere Versionen; Manifest v2 bindet
  Ed25519-signiert den exakten Git-Commit sowie getrennte Web-/Worker-Digests
- Release-Promotion ist ein Same-run-DAG: exakter annotierter SemVer-Tag auf
  `main` → vollständige CI + Security → Build/Trivy → Registry-Push →
  verpflichtendes Manifest; kein Status-/Skip-Fallback
- Operator-CLI deployt Registry-Images ausschließlich als
  `image:version@sha256:…`, prüft OCI-Version/Revision und speichert den
  vollständigen Last-Good-Vertrag für digest-gepinnten Rollback
- **Lizenzschlüssel-Verifikation** (Ed25519-JWT)
  - Admin-Card mit Status-Banner (gültig/abgelaufen/fehlend)
  - CLI `scripts/license-keygen.ts` zum Erzeugen
  - Operations-Dokumentation in `docs/operations/lizenz.md`
- **Subdomain-Trennung Staff/Portal** vorbereitet (Cookie-Domain pro
  Surface über `STAFF_COOKIE_DOMAIN`/`PORTAL_COOKIE_DOMAIN`,
  Caddy-Beispiel in `docs/operations/subdomain-trennung.md`)
- Operator-CLI räumt bei lokalen Docker-Builds ungenutzten BuildKit-Cache
  periodisch auf (`TAXTRONIK_BUILD_CACHE_PRUNE_UNTIL`, Default 168h)
- Die Ein-Klick-Installation provisioniert neben TaxTronik und n8n auch das
  verwaltete Signal samt hash-gepinnten Quanten-Extras und lokalem Granite-
  CPU-Backend. CPU-Inferenz funktioniert ohne GPU, wird wegen Analysezeiten
  von potenziell mehreren Minuten aber ausdrücklich als Performance-
  Bottleneck ausgewiesen
- Updates vergleichen den vorgesehenen Signal-Stand mit dem installierten
  Artefakt und überspringen einen unveränderten Build; ein bewusster Neuaufbau
  bleibt als Operator-Entscheidung möglich
- Mailhog ist Dev-only; Produktion verlangt ein echtes SMTP-Relay und blockt
  Mailhog-/localhost:1025-Defaults im `doctor`
- `pnpm test:ops` prüft Operator-CLI-Gates maschinell (Prod-SMTP, Risk-Layer,
  Build-Cache-Prune) und läuft als Quality-Gate in CI
- Betriebsrunbooks für Day-2 Operations, Secret-Rotation und Release-Rehearsal
  unter `docs/operations/`
- Assurance-Dokumentation mit Threat Model und Known Limits unter
  `docs/assurance/`

## ELSTER-Anbindung (Stufe 2: Steuerkonto-Abfrage)

Neutrales Paket `@taxtronik/elster`: typisierter HTTP-Client zur privaten
eric-bridge (separates Privat-Repo, eigener Debian-Container mit der
nativen ERiC-Bibliothek). Aktivierung per Feature-Flag
`ELSTER_BRIDGE_URL` + `ELSTER_BRIDGE_TOKEN` — ohne konfigurierte Bridge
bleibt das Modul inaktiv (gleiches Muster wie der Risk-Layer).

- Endpunkte: Health-Check, Validierung (Stufe 1), generische Abfrage +
  strukturierte Kontoabfrage inkl. Sollstellungen (Stufe 2)
- **Steuerkonto-UI** im Mandanten-Detail (`/staff/clients/[id]/elster`,
  bridge-gated): Abruf von Sollstellungen (Jahr), offenen Beträgen und
  Istbuchungen (ab Datum) je Steuerart; die **Steuerverbindung** ist auswählbar,
  mit vorausgewähltem Standard. Verbindung und tatsächlich verwendete Nummer
  werden beim Abruf unveränderlich festgehalten. Alte Abrufe erhalten keine
  nachträglich erfundene Verbindung. Jeder Abruf wird als Vorgang
  persistiert (append-only Historie, RLS) mit Evidence-Record; die
  Zertifikats-PIN wird durchgereicht, nie gespeichert
- Datenteil, TransferHeader und Hersteller-ID entstehen ausschließlich
  in der Bridge — das Monorepo enthält kein ERiC-Spezifikationswissen
  (CI-Guard `scripts/check-no-eric-spec.sh`)
- Fail-safe: Testmerker als Default, Echtübermittlung nur mit explizitem
  Echtfall-Häkchen; Zertifikats-PIN pro Aufruf, nicht persistiert
- Noch offen: Versand-Datenarten (UStVA zuerst), Worker-Jobs für
  periodische Soll/Ist-Abgleiche
- Architektur + Lizenzpflichten: `docs/development/eric-integration.md`

## Benutzer-Verwaltung (ADMIN/PARTNER)

- Anlegen mit Initial-Passwort (TOTP wird beim ersten Login eingerichtet)
- Optionaler persönlicher Staff-Anmeldemodus **„Nur physische
  FIDO2-Sicherheitsschlüssel“**. Das Opt-in wird erst mit mindestens zwei
  registrierten geeigneten Schlüsseln freigegeben; anschließend akzeptiert die
  Staff-Anmeldung weder Passwort noch TOTP oder Backup-Codes
- Die WebAuthn-Registrierung und -Anmeldung verlangt Benutzerverifikation
  (`userVerification: required`) und `cross-platform`-Authentikatoren. Für den
  Hardwaremodus werden nur `singleDevice`-Credentials akzeptiert, die weder
  backup-eligible noch backed-up sind und USB, NFC, BLE oder Smartcard als
  Hardware-Transport ausweisen
- Die Wiederherstellung des Hardwaremodus folgt der vorhandenen Hierarchie
  ADMIN → PARTNER/EMPLOYEE und PARTNER → EMPLOYEE; ADMIN-Konten bleiben der
  Administrations-CLI vorbehalten. Der wiederherstellende Akteur muss im
  Passwortmodus sein aktuelles Passwort und einen frischen echten TOTP
  bestätigen; Backup-Codes sind kein Step-up. Ein Hardware-only-Akteur nutzt
  den eigenen WebAuthn-Schlüssel mit einer an Akteur, Zielkonto und
  Auth-Revision gebundenen Challenge. Jede Wiederherstellung widerruft
  laufende Sitzungen; Credential-Widerruf, Kontowechsel und Audit werden
  datenbankseitig atomar ausgeführt. Der Magic-Link-Login des Mandantenportals
  bleibt unverändert
- Enrollment fordert `direct` und akzeptiert nur eine vollständige `packed`-
  Attestation. Eine nichtleere Deployment-AAGUID-Allowlist und ein im Modus
  `strict` verifiziertes FIDO-MDS-Statement sind für Enrollment und jede
  Hardware-Assertion zwingend; fehlende oder nicht mehr vertrauenswürdige
  Metadaten werden fail-closed abgelehnt
- Die AAGUID bezeichnet eine Modellfamilie, keine eindeutige Geräteinstanz.
  Zwei Credentials beweisen deshalb nicht kryptografisch zwei unterschiedliche
  physische Schlüssel. Bei der Aktivierung wird ein Schlüssel frisch bestätigt,
  während der zweite aktive, policykonforme Schlüssel nur gezählt wird
- Die ADMIN-Rolle kann ausschließlich von einem bestehenden ADMIN vergeben
  oder verändert werden; PARTNER können ADMIN-Konten auch nicht deaktivieren
- Persönliches Benutzerprofil für alle Rollen: Im Standardmodus
  Passwortänderung mit bisherigem Passwort, Wiederholung und anschließendem
  Logout auf allen Geräten; im Hardware-only-Modus ist die Passwortänderung
  gesperrt
- Anlegen seeded automatisch BMF + BFH als RSS-Feeds für den neuen User
- Aktivieren/Deaktivieren
- Rollen-Pflege (EMPLOYEE / PARTNER / ADMIN) inline
- Zusätzliches Merkmal „Berufsträger“, unabhängig von den Rollen. Historische
  ausdrückliche Zuordnungen werden mit Herkunftsvermerk übernommen; Entzug
  sperrt neue GwG-Freigaben und zeigt erforderliche Neuzuordnungen
- Optionale manuelle Beraternummer als internes Textfeld mit führenden Nullen;
  keine DATEV-Synchronisation, automatische Abrechnungszuordnung oder Portalausgabe
- Self-Lockout-Schutz (eigene Rollen nicht änderbar, eigener Account nicht
  deaktivierbar)
- Übersicht: Name, E-Mail, Rollen, Anmeldemodus/2FA-Status, letzter Login
- Hierarchischer Reset für fremde Passwörter und verlorene 2FA-Zuordnungen:
  ADMIN → PARTNER/EMPLOYEE, PARTNER → EMPLOYEE. ADMIN-Konten werden
  ausschließlich über die Administrations-CLI wiederhergestellt; E-Mail und
  Tenant-Slug müssen das einzelne Zielkonto eindeutig festlegen. Secrets,
  offene Setups und Backup-Codes werden gemeinsam entfernt, laufende Sitzungen
  sofort widerrufen und Web-Resets auditiert
- Tätigkeitsbereich-Zuordnung pro Mitarbeiter (Tags-Icon-Popover)
- **Granulare Einzelrechte je Mitarbeiter** (jenseits der Rollen):
  Rechnungen anlegen/bearbeiten, Rechnungen versenden, Urlaub
  entscheiden; ADMIN/PARTNER haben implizit alle Rechte, Vergabe/Entzug
  ist Admin-only und wird als `staff.permissions.update` auditiert

## Tätigkeitsbereiche / Skills

- Frei definierbare Skills pro Kanzlei, getrennt von Auth-Rollen
- 5 System-Skills für jeden Tenant vorbelegt: Finanzbuchhaltung,
  Lohnabrechnung, Jahresabschluss, Steuererklärungen, Beratung
- Eigene Skills mit Kürzel, Anzeige-Name, Farbe (Tailwind-Tönung)
- Inline-Bearbeitung, eigene Skills löschbar (System-Skills nicht)
- Skill-Badge in Workflow-Items sichtbar

## Kanzlei-Einstellungen (ADMIN/PARTNER)

- Verkäufer-Stammdaten für XRechnung/ZUGFeRD
- Branding
  - Anzeige-Name + Untertitel
  - Akzent-Farbe (Hex) → vollständige Tailwind-Brand-Skala
  - Logo-Upload (PNG/JPG/WebP, max. 200 KB als Data-URL)
- **Briefkopf** (`branding.letterhead`) — Organisationsname,
  mehrzeilige Adresse, Kontakt-Zeile, Fußnote (Steuerberaterkammer / USt-ID
  / Geschäftsführer); wird zusammen mit dem Branding-Logo in neu erzeugte
  In-App-Rechnungs-PDFs eingebunden (Logo im PDF: PNG/JPEG; WebP bleibt im
  Web-Branding nutzbar). Bereits revisionssicher archivierte
  Rechnungen und extern hochgeladene/signierte PDFs werden nicht verändert;
  Vollmachten und Bescheinigungen verwenden diese Einstellung derzeit nicht.
- **Rechtliche Hinweise** (`tenant_setting.legal`) — Impressum-URL +
  Datenschutzerklärung-URL; werden im Footer der Login-Seiten (Staff +
  Portal) verlinkt (insbesondere § 5 DDG und Art. 12/13 DSGVO); in
  angemeldeten Sitzungen bewusst nicht prominent angezeigt
- Serverseitig durchgesetzte Modul-Aktivierung pro Tenant — 15 Boolean-Module:
  deaktivierte Module verschwinden aus der Navigation und ihre direkten
  Seiten, Server-Actions und zugehörigen API-Pfade lehnen Aufrufe ab. Module:
  BWA, Wissensdatenbank,
  Zeiterfassung, Telefonzettel, Steuertermine + Bescheide (`taxNotices`),
  Workflows, Formulare, Wiedervorlagen, Pendelordner, Anlieferungen,
  Termine (`appointments`), RSS-Reader sowie als Opt-in Inbound-Mail
  (n8n-Mailstrecke), Subsumtion/TCMS (`risk`) und Signal-Engine
- **Portal-Feature-Flags** (granular, unabhängig von den Modul-Toggles):
  Terminanfragen, BWA-Ansicht, BWA-Planung, Dokument-Upload,
  Stammdaten-Self-Service, Anlieferungs-Status
- **Inbetriebnahme-Checkliste** — prüft Kanzlei-Kontaktdaten,
  Modul-/Rechnungsmodus-Entscheidung, den eingerichteten oder bewusst
  deaktivierten n8n-Pfad und den ersten GwG-aktiven Mandanten;
  begleitendes Anwenderdoku-Kapitel „Erste Schritte"
- **Zugriffsmodell** (`OPEN` / `RESTRICTED`) — `OPEN` (Default): jeder aktive
  Mitarbeiter darf mandantenübergreifend arbeiten (Audit-Log trägt die
  Nachvollziehbarkeit); `RESTRICTED`: nur Admin/Partner + zugeordnete
  Berufsträger/Hauptbearbeiter. Pro Mandant „vertraulich"-Flag als Ventil
  (auch im OPEN-Modus auf Zugeordnete beschränkt), nur Admin/Partner setzt es.
  Durchgesetzt wird das Gate in den Staff-API-Routen (Dokument-Download/
  -Preview, Bulk-ZIP, DATEV-/CSV-Exporte, globale Suche), im gesamten
  Mandanten-Detailbereich (`/staff/clients/[id]/**` per Layout-Guard mit
  Redirect, Subsumtion zusätzlich eigener Guard) sowie in den tenant-weiten
  Listen und Dashboard-Widgets (Mandanten-, Anforderungs-, Rechnungs-,
  Kalender- und Steuertermin-Ansichten filtern gesperrte Mandanten aus;
  reine Zähler-KPIs ohne Namen bleiben ungefiltert). Seit Audit 2026-07
  (Befund M-1) wird das Objekt-Gate auch in allen MUTIERENDEN Server-Actions
  unter `/staff/clients/[id]/**` durchgesetzt: `assertClientAccessTx` läuft
  als erste Anweisung in der Tenant-Tx (Muster `edit/actions.ts`), weil
  Server-Actions als direkte POSTs am Layout-Guard vorbeilaufen und RLS nur
  den Tenant scoped, nicht die Vertraulichkeit. Die frühere „bekannte
  Grenze" (Schreiboperationen per bekannter ID trotz Vertraulich-Flag) ist
  damit geschlossen.
- Vollmachten-Modus (`MARKDOWN_OTP` / `PDF_TEMPLATE` / `OFF`)
- Rechnungs-Modus (`IN_APP` / `EXTERNAL` / `OFF`)
- PDF-Begleittext-Templates für beide Modi (Markdown mit Platzhaltern)
- Steuer-Region pro Tenant als technischer Standardkalender. Sie ist nicht
  automatisch der rechtlich maßgebliche Feiertagsort eines konkreten
  Bekanntgabe- oder Fristvorgangs
- Feiertagskalender pro Bundesland konfigurierbar (alle 16 Länder +
  Buß-Bettag-Berechnung)
- Custom-Felder-Definitionen für Mandanten
- Anforderungs-Vorlagen
- SMTP-Konfiguration + Test-Mail
- TSA-Konfiguration (RFC-3161)
- **Geführte n8n-Automatisierung** — getrennte Instanz-UI/API-Verbindung,
  workflow-spezifische Production-Webhook-Ziele und Event-Abonnements;
  verwaltete sowie eigene Workflows, synthetische Tests, Fan-out,
  Routing-Modi `DISABLED`/`LEGACY`/`EXPLICIT`
  und differenzierte Zustell-/Aggregatstatus; der selektive Import
  materialisiert die separat gespeicherte, aus n8n erreichbare App-URL,
  Callback-Key-ID und Mail-Nicht-Geheimnisse ohne editionsabhängige n8n Custom
  Variables, Secrets bleiben Credentials; neue/geänderte Routen durchlaufen
  fail-closed **Entwurf → Test → unveränderte Aktivierung**. Erkannte oder aus
  Vorlagen geladene Routen werden im Formular materialisiert und mit
  „Speichern“/„Verwerfen“ explizit übernommen; Aktivstatus, Testmodus, URLs und
  Event-Abonnements werden gemeinsam persistiert
- Zentraler n8n-Eventkatalog mit deutschem Label, Kategorie, Beschreibung,
  Schutzklasse/PII-Hinweis und synthetischem Beispielpayload für alle
  statischen Events

## UI-Querschnitt

- **Darkmode** mit System-Erkennung (Hell/Dunkel/System-Toggle,
  Persistenz in localStorage, kein Flash-of-Wrong-Theme dank
  Inline-Bootstrap, globale CSS-Overrides für konsistente Tönung)
- **UI-Mode-Toggle „Klassik / Modern"**
  - Klassik (Default): leichtgewichtig, RDS-tauglich, kein Backdrop-Blur
  - Modern: Brand-Verlauf am Body, Glas-Cards (Backdrop-Blur 12 px +
    Multi-Layer-Schatten), Hover-Lift auf Cards, Gradient + Scale auf
    Primary-Buttons, Glas-Sidebar + Glas-Topbar, weicher Focus-Ring
  - Persistenz via localStorage + No-FOUC-Bootstrap im RootLayout
  - Respektiert `prefers-reduced-motion`
- Mobile-Sidebar mit Hamburger-Toggle
- Globale Suche im Header
- Benachrichtigungs-Bell-Dropdown mit Inline-Markierung als gelesen
- Theme-Toggle + UI-Mode-Toggle im Header
- Responsive Tabellen mit offset-basierter Pagination
- Schlanke Custom-Scrollbar (`.scrollbar-thin`) opt-in für eingebettete
  Listen — restliche App behält OS-typische Scrollbars
- Alle Datums/Zahlen-Formate de-DE (keine i18n geplant — DE-only)

## Architektur-Querschnitt

- **Next.js 16** (Turbopack-default, `proxy.ts`-Convention statt `middleware`)
- **React 19**
- **Auth.js v5** (zwei separate Configs `/staff/*` und `/portal/*`,
  getrennte Cookies, keine Cross-Surface-Sessions)
- Passwort plus TOTP für Mitarbeiter (Aktivierung beim ersten Login) oder nach
  persönlichem Opt-in ausschließlich physische FIDO2-Sicherheitsschlüssel
- Magic-Link für Portal-Kontakte
- Token-basierte Public-Pfade ohne Auth: `/poa/sign`, `/gwg-onboarding`
- Auth-Route-Group-Layouts (`(auth)/layout.tsx`) für Staff + Portal mit
  Pflicht-Footer (Impressum + Datenschutz)
- Multi-Tenant via `tenant_id`-Discriminator + Postgres-RLS-Policies
- Pro Request: Prisma-Middleware setzt `app.current_tenant_id` /
  `app.current_actor_id` / `app.current_actor_type` via `SET LOCAL`
- Doppelte Verteidigung: App-Filter + RLS-Policy + DB-Trigger
- BullMQ-Worker für Hintergrund-Jobs (22 Worker):
  `audit-anchor` (alle 2 Sekunden; nicht blockierende RFC-3161-Checkpoints),
  `evidence-seal`, `gwg-expiry-check`,
  `invoice-overdue-check`, `audit-verify-check`,
  `tax-deadline-materialize` (07:30 Berlin, materialisiert Termine, legt
  Auto-Anforderungen samt `QUEUED`-Status atomar an und verarbeitet den
  persistierten Benachrichtigungsfluss; höchstens drei Versuche nur bei
  eindeutigem Totalfehler, sonst fail-closed interne Eskalation),
  `audit-rotate`, `tax-news-fetch`
  (06:30 Berlin, holt alle aktiven RSS-Feeds aus `rss_feed`),
  `reminders-daily` (07:45 Berlin, schickt Notifications für
  Einspruchsfristen, fällige Wiedervorlagen, überfällige Pendelordner),
  `n8n-deliver` + `n8n-outbox-reconcile` (HMAC-signierter,
  workflow-spezifischer Outbox-Versand mit stabiler Event-/Delivery-ID,
  Fan-out und Retry), `n8n-retention` (03:45 UTC),
  `magic-link-cleanup`, `dsgvo-retention`, `poa-expiry-check`,
  `risk-analyse-llm` (on-demand LLM-Vertiefung der Subsumtion),
  `reminder-done-notify` (erledigte Delegationen/Wiedervorlagen),
  `backup-run` (täglicher Postgres-Dump direkt nach S3),
  `backup-drill` (monatlicher Restore-Test mit Chain-Verifikation),
  `health-alert` (5-Minuten-Infrastruktur-Health mit Ops-Mail),
  `workflow-n8n-dispatch` (minütliche Wiederaufnahme dauerhaft vorgemerkter
  Workflow-Events) und `storage-orphan-cleanup` (sechsstündliche Bereinigung
  journalisierter Storage-Waisen nach der jeweiligen Retention).
  Ein asynchroner Virus-Scan-Job existiert bewusst nicht — Scans laufen
  ausschließlich synchron beim Upload-Commit in `@taxtronik/storage`.
  Die Worker-Jobs haben eigene Unit-Tests
  (`apps/worker/src/jobs/__tests__/`)
- n8n als Workflow-Engine für Mail-Versand und Eskalationen: App → n8n ist
  HMAC-signiert; n8n → `/api/integrations/n8n/v1/*` nutzt ein
  tenantgebundenes Bearer-Credential mit minimalen Scopes und einmaliger
  Request-ID. n8n hat keinen direkten Datenbankzugriff; optionale
  n8n-Management-API nur für Workflow-Verwaltung,
  respektiert Portal-Notification-Setting per `notifiableContacts`-Array
- Getrenntes Staff-/Mandantenportal-Setup über `NEXTAUTH_URL`,
  `PORTAL_PUBLIC_URL`, `STAFF_COOKIE_DOMAIN` und `PORTAL_COOKIE_DOMAIN`;
  `/api/integrations/n8n/v1/*` sowie Legacy-`/api/n8n/*`
  gehören dabei auf die Staff/API-Seite oder eine interne App-URL
- SeaweedFS für Document-Storage mit Object-Lock-Buckets
- Reproduzierbare Release-Pins: SeaweedFS 4.41 und n8n 2.33.7 jeweils per
  Image-Digest, BullMQ 5.81.3 im pnpm-Lockfile
- ClamAV-Synchron-Scan + Helper `commitDocumentFromBytes` für Public-Wizard-
  Uploads
- Eigenständige Packages: `@taxtronik/db`, `@taxtronik/config`,
  `@taxtronik/evidence`, `@taxtronik/storage`, `@taxtronik/tax`,
  `@taxtronik/crypto` (AES-256-GCM Secret-Box mit HKDF-domain-getrenntem Key),
  `@taxtronik/http-utils` (SSRF-Guard + DNS-pinning-safeFetch via undici),
  `@taxtronik/rss` (Parser + Streaming-Body-Cap),
  `@taxtronik/n8n-shared` (driftfreier Eventkatalog/Whitelist +
  HMAC-Sign mit Replay-Nonce),
  `@taxtronik/risk-layer` (zustandsloser §4-Engine-Client: Schema/Mapping/
  Resilienz mit Circuit-Breaker, reiner Transport),
  `@taxtronik/elster` (typisierter Client zur privaten eric-bridge,
  Feature-Flag-gated — siehe „ELSTER-Anbindung")
- **Forgejo-Actions-CI** (`.forgejo/workflows/`, self-hosted Runner): `ci.yml`
  (Quality: Lint/Typecheck/Unit · DB: Migrationen/RLS/Drift/verify:chain mit
  Postgres-Service · Browser-E2E via Playwright mit Smoke-, Auth-, Action-,
  Compliance-, RBAC-, Concurrency- und Upload-Negativtests), `security.yml` (pnpm-audit +
  gitleaks-Secret-Scan, täglicher Cron), `build-images.yml` (Web-/Worker-
  Image-Build, build-only); GitHub-Mirror läuft ohne Actions, `dependabot.yml`
  liegt ebenfalls unter `.forgejo/`
- React-Grid-Layout v2 als einzige UI-Library außerhalb shadcn/ui-Stack
  (Dashboard-Widget-Grid mit Reflow)
- Sortable-List-Komponente eigenständig (Pointer-Events, ~80 Zeilen)
  für Workflow- und Form-Editor + Dashboard
- Geteilte Server-Component `<BwaDashboard>` für Portal- + Staff-Sicht
  (gleicher Datensatz, nur unterschiedlicher `linkPrefix`)
- Server-Actions in Client-Komponenten via `.bind(null, clientId)` —
  Next.js erkennt die gebundenen Aktionen als serialisierbar und überträgt
  sie korrekt; Wrapper-Closures werden vermieden, da sie als
  Event-Handler-Props nicht über die Server→Client-Grenze gehen dürfen

## Sicherheit & Compliance

- **Manipulationsevidenter Audit-Log zur GoBD-Nachvollziehbarkeit**:
  Hash-Chain pro Tenant; jeder Eintrag hat einen eigenen, im kanonischen Hash
  gebundenen UTC-Zeitpunkt aus der App-/Hostuhr (`occurredAt`,
  `timestamptz(6)`). Eine zweite, append-only Anchor-Kette verankert committete
  Spitzenstände im Regelfall binnen Sekunden per RFC 3161 und bindet dabei
  jeweils den vorherigen TSA-Token; Fachtransaktionen werden nicht blockiert.
  Der tägliche RFC-3161-TSA-Stempel der Kettenspitze (`evidence-seal` 02:30
  UTC) bleibt zusätzlich bestehen. Die Default-TSA ist **GlobalSign**
  (kostenlos/EU), pro Tenant umstellbar. D-Trust und weitere kommerzielle
  Endpunkte sind konfigurierbar; die Qualifikation des konkret beauftragten
  Dienstes wird nicht allein aus dem Anbieternamen behauptet. Die tägliche Verifikation
  (`audit-verify-check` 02:45 UTC) mit `SYSTEM_AUDIT_BREAK`-Notification an
  ADMIN/PARTNER bei Bruch, wöchentliche NDJSON-Auslagerung mit Object-Lock-
  Versiegelung; `pnpm verify:chain` rehasht jeden Eintrag, rekonstruiert die
  Kette aus DB+Archiv und prüft den TSA-Stempel kryptografisch:
  CMS-Signatur, messageImprint an den _rekonstruierten_ Ketten-Spitzen-Hash
  gebunden (nicht an die DB-Spalte → tötet den DB-gegen-DB-Angriff), Cert-Kette
  bis zum eingebetteten GlobalSign-Root R6 oder zu einem über
  `TSA_TRUSTED_ROOTS_FILE` bereitgestellten Betreiber-Trust-Anchor _as-of_
  genTime, kritische EKU timeStamping + ESS-SigningCertificate-Bindung.
  Eine Sperrstatusprüfung über OCSP/CRL ist derzeit nicht implementiert;
  Adapter-Modus wird im Report ausgewiesen, Self-Timestamp im Produktivmodus =
  harter Fail. Für Nicht-GlobalSign-Anbieter muss der Betreiber den passenden
  Root out-of-band bereitstellen und prüfen. Das Siegel
  belegt extern nur den spätesten Existenzzeitpunkt des jeweiligen verankerten
  Präfixes; individuelle lokale Ereigniszeiten werden nicht als exakte
  TSA-Zeiten ausgegeben. Bis zur asynchronen Antwort bleibt ein kleines,
  im Admin-Status sichtbares Verzögerungsfenster
- **Aufbewahrungs-Buckets nach Recht getrennt**: `gobd` (je Datei-Typ 6/8/10 J.
  nach § 147 AO bzw. § 14b UStG, Object-Lock COMPLIANCE), `gwg` (grundsätzlich
  5 J. nach § 8 Abs. 4 GwG; andere Gesetze können länger verpflichten,
  spätestens nach 10 J. ist zu vernichten; deshalb GOVERNANCE-Lock plus
  fachliche Löschprüfung), `general` / `staff-private` (kein Object-Lock);
  Retain-Until-Logik nach Kalenderjahres-Schluss (Jahresende + N + 1 Tag)
- **Staff-Authentisierung** standardmäßig mit Passwort und TOTP, lokal
  generiertem QR-Code (kein Drittanbieter-Roundtrip), 8 Backup-Codes als
  One-Time-Use mit Row-Lock-Konsumption, TOTP-Replay-Schutz via Redis-Nonce-Set
  und Account-Lockout an 5 _distinkten_ IPs (kein Single-IP-Lockout-DoS).
  Optional ersetzt der Modus „Nur physische FIDO2-Sicherheitsschlüssel“ nach
  Registrierung von mindestens zwei geeigneten Schlüsseln alle drei
  bisherigen Staff-Anmeldewege
- **Hardwaregebundene WebAuthn-Policy** für diesen Opt-in-Modus:
  `userVerification: required`, Authenticator-Attachment `cross-platform`,
  Credential-Gerätetyp `singleDevice`, `backupEligible: false`,
  `backedUp: false` und Hardware-Transport USB, NFC, BLE oder Smartcard.
  Enrollment verlangt `direct` + vollständige `packed`-Attestation, eine
  nichtleere AAGUID-Allowlist und FIDO MDS `strict`; jede Assertion bewertet
  Allowlist und MDS-Statement erneut und scheitert bei Nichtverfügbarkeit
  fail-closed. Eine AAGUID identifiziert nur die Modellfamilie, nicht ein
  individuelles physisches Gerät
- **Session-Cookie-Präfixe** (`session-cookie.ts`): in Production
  `__Host-taxtronik_*_session` (ohne konfigurierte Cookie-Domain; Browser
  erzwingen Secure + `Path=/` + kein Domain-Attribut — kein Überschreiben
  durch Subdomains) bzw. `__Secure-taxtronik_*_session` bei gesetzter
  `STAFF_`/`PORTAL_COOKIE_DOMAIN`; im Dev (HTTP) unverändert unpräfixt
- **CSRF-Origin-Check** als Defense in Depth zu `SameSite=lax` auf den drei
  Upload-Commit-Routen (Staff-Commit, New-Version-Commit, Portal-Commit):
  Cross-Origin-POST → `403 { error: 'origin_mismatch' }`
- **SSRF-Schutz + DNS-Rebinding** für jeden serverseitigen fetch zu Admin-
  konfigurierbaren URLs (RSS, TSA, n8n, Update-Manifest, Health-Check) via
  zentralem `safeFetch` mit undici-Agent + gepinntem Lookup, Body-Cap,
  `redirect: 'error'` + 30s-Default-Timeout
- **Risk-Layer-Transport** ist davon getrennt: `RISK_LAYER_URL` ist eine
  serverseitige Operator-Konfiguration, wird nur mit festen `/v1/*`-Pfaden und
  Bearer-Token genutzt, erlaubt interne IPs/Loopback und blockt Redirects
- **Rate-Limiting** auf Login, Passwortänderung, TOTP, Magic-Link, GwG-Upload,
  PoA-Sign, Portal-Write — fail-CLOSED in Production bei Redis-Ausfall;
  `checkIpOrGlobalLimit` deckelt sowohl Per-IP als auch globalen Sturm;
  per-User-Limits auf der Staff-Suche (30/min) und allen CSV-/ZIP-Exporten
  (5 pro 10 min je Export-Art: clients, audit, requests, invoices,
  datev-belege) → `429 { error: 'rate_limited' }`; öffentliche
  Token-Lade-Pfade (GwG-Onboarding, PoA-Signatur) per IP 30/10 min mit
  derselben generischen Fehlansicht wie bei ungültigem Token (kein
  Token-Probing-Orakel)
- **Reverse-Proxy-Trust-Boundary**: `TRUST_PROXY_REQUIRED`-ENV gate für
  `getClientIp` — kein blindes XFF-Vertrauen ohne explizite Operator-Zusage
- **Mail-Pipeline**: HMAC-Outbound für n8n inkl. Event, stabiler
  `eventId`/`deliveryId` + 128-Bit-Nonce; Empfänger
  deduplizieren at-least-once-Retries nach `deliveryId`,
  SMTP mit `requireTLS` + `minVersion TLSv1.2`, `from`/`to`/`subject`/
  `replyTo` durch CRLF-Stripping, Markdown-Renderer escapt user-supplied
  Variablen vor `{{var}}`-Substitution
- **Technische Pseudonymisierung vor dem Recherche-Egress, kein
  §-203-Nachweis**: Text, Rechtsfrage und Auftrag werden vor dem n8n-Relay
  deterministisch (bekannte Stammdaten) plus heuristisch
  (Firma/IBAN/Steuernummer/Betrag/Datum/E-Mail) reduziert; Normanker bleiben
  derzeit unverändert, Vorschau und Versand sind serverseitig nicht gebunden
  und getrennte Platzhaltermappings können kollidieren. Das Mapping bleibt
  RLS-lokal; scoped n8n-Inbound nutzt tenantgebundene Key-ID, Bearer-Token und
  einmalige Request-ID im Redis-Replay-Store (fail-closed).
- **Security Policy**: `SECURITY.md` mit vertraulichem Reporting-Kanal
  (E-Mail), Response-SLA (2/5 Werktage), Scope-Definition und Hinweis auf
  ADR-0002–0010 als Secure-by-Design-Grundlage
- **Container-Hardening**: `cap_drop: ALL` + `no-new-privileges` + `read_only`-
  Root-FS auf App/Worker mit `tmpfs:/tmp`, alle Infra-Ports an `127.0.0.1`,
  App/n8n hinter Reverse-Proxy (NGINX-Beispiel-Konfig in `infra/nginx/`;
  mit Hinweisen für `/api/integrations/n8n/v1/*`,
  Legacy-`/api/n8n/*`, separaten n8n-VHost und Staff-/Portal-Split);
  das Beispiel setzt bewusst keine eigenen Security-`add_header`-Zeilen — die
  Header kommen aus der App, ein nginx-seitiges `add_header` würde u. a. die
  token-spezifische `no-referrer`-Policy überschreiben)
- **Dev-Default-Denylist**: Bekannte Dev-Schlüsselwerte (`AUTH_SECRET`,
  `N8N_HMAC_SECRET`, `N8N_ENCRYPTION_KEY`, `POSTGRES_PASSWORD`,
  `TAXTRONIK_APP_PASSWORD`) werden in Production in der ENV-Validierung
  hart abgelehnt — kein „vergessenes Setup-Skript-Generieren" mit
  committed-Secret-Material
- **Compliance-Dokumente** unter `docs/compliance/`: `gobd.md`, `gobd-template.md`,
  `dsgvo-konzept.md`, `gwg.md`, `dsfa-template.md`, `vvt-template.md`,
  `eidas-tsa.md`, `auth-secret-rotation.md`, `tenancy-model.md`,
  `cookie-config.md`, `avv-template.md`, `pen-test-vorbereitung.md`
