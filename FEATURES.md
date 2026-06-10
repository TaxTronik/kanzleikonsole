# taxtronik — Funktionsumfang

Stand: 2026-06-10. Die mit ⚙ markierten Module sind pro Kanzlei in den
Einstellungen ein- bzw. ausschaltbar.

## Überblick

**Mandanten & Akte** — Mandanten-CRM · Onboarding-Wizard · GwG-Compliance ·
Anforderungen · Dokumente (Datei-Manager) · Kanzleikalender ⚙ · Bescheide &
Steuererklärungen ⚙ · Telefonzettel ⚙ · Wiedervorlagen · Pendelordner

**Beratung & Auswertung** — BWA, Hochrechnung & Planung ⚙ ·
Subsumtions-Workspace / TCMS ⚙ · Wissensdatenbank ⚙

**Abrechnung & Vertretung** — Rechnungen ⚙ · Vollmachten ⚙ · Zeiterfassung ⚙

**Prozesse & Vorlagen** — Workflow-Vorlagen · Form-Builder ·
Status-Maschinen-Builder · Anforderungs-Vorlagen · Custom-Felder

**Mitarbeiter & Kanzlei** — Dashboard-Widget-Builder · RSS-Reader ·
Abwesenheiten · Benutzer-Verwaltung · Tätigkeitsbereiche/Skills ·
Kanzlei-Einstellungen

**Mandanten-Portal** — Login · Anforderungen · Formulare · Dokumente ·
Stammdaten-Self-Service · Steuererklärungen · Termine · Auswertungen ·
Rechnungen · GwG-Onboarding

**Querschnitt** — Globale Suche · Benachrichtigungen · DSGVO · Compliance &
Audit · Backups & DR · Update-Mechanik & Lizenz · UI (Dark/Modern) ·
Sicherheit · Architektur

---

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
- Stammdaten-Bearbeitung in zwei Sektionen
  - **Verwaltung** (frei änderbar): DATEV-Nr, Addison-Nr, Rechnungs-E-Mail,
    Priorität A/B/C, **interne Akten-Notiz** (Markdown, nur Kanzlei sieht es),
    **Vertraulich-Flag** (Admin/Partner-only; schirmt den Mandanten auch im
    offenen Zugriffsmodell auf Zugeordnete ab)
  - **GwG-relevant** (Name, Rechtsform, Adresse, USt-ID) — Änderung setzt
    bestehenden VERIFIED-GwG-Check auf IN_REVIEW zurück
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
- **Wiedervorlagen-Block** — Datum + Stichwort + optional zugewiesener
  Bearbeiter; offene + erledigte Sektion mit Check-Toggle; Worker schickt
  zur Fälligkeit eine Notification an Bearbeiter/Ersteller
- **Pendelordner-Tracker** — physische Belege-Ordner-Übergaben verfolgen;
  Status PREPARED → WITH_CLIENT → RETURNED → COMPLETED mit Auto-Stamping
  der jeweiligen Zeitstempel; Overdue-Reminder über `expectedReturnAt`;
  Inhaltsliste als Markdown
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
  1. **Stammdaten** (Pflicht) — Name + Kind + DATEV/Addison + USt-ID +
     Adresse → erzeugt Client, weiter zu Schritt 2
  2. **Ansprechpartner + Portal-Zugang** (optional) — `ClientContact`
     anlegen mit Default-Checkbox „Magic-Link jetzt versenden"
  3. **GwG-Onboarding** (Pflicht) — versendet `GwgOnboardingInvite` per
     n8n-Mail; zeigt „bereits gesendet"-Banner wenn vorhanden
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
  + Mandant deaktivieren bei Ablauf
- Personalausweis-Ablauf-Check (60 Tage vor Expiry: Notification an
  Bearbeiter + Auto-Anforderung an Mandant, idempotent)
- Re-Verifikation bei GwG-relevanten Stammdaten-Änderungen (sowohl bei
  Staff-Edit als auch bei genehmigten Self-Service-Änderungen)
- **GwG-Onboarding-Einladung** — Mandant identifiziert sich selbst, ohne
  Portal-Account
  - Magic-Link mit 14-Tage-Token, hash-gespeichert (analog PoA-Sign)
  - 4-Schritt-Wizard: Stammdaten → wirtschaftlich Berechtigte →
    Personalausweis-Vorder/Rückseite je Person → optionale Zusatz-Dokumente
  - Datei-Upload direkt im Wizard (JPG/PNG/PDF, ClamAV-Scan, Object-Lock)
  - Beim Submit: Mandant-Stammdaten werden aktualisiert (mit GwG-relevant-
    Audit), bestehender Check geht auf IN_REVIEW oder neuer Check entsteht
  - Wirtschaftlich Berechtigte + Ausweis-Dokumente werden als
    `gwg_beneficial_owner` + `gwg_id_document` (Vorder + Rückseite) angelegt
  - Audit-Trail mit IP + User-Agent
  - Kanzlei besorgt nur HR-Auszug + Transparenzregister-Auszug selbst
- **Pflichtvernichtung nach § 8 Abs. 4 GwG** — Review-Queue unter
  `/staff/admin/gwg-retention` (ADMIN/PARTNER, kein stilles Auto-Delete):
  - Löschreif ab Jahresende des Mandatsendes + 5 Jahre
    (`client.mandateEndedAt`)
  - **Datei-Belege**: bestätigte Vernichtung löscht Bytes + DB-Records,
    auditiert `gwg.evidence.destroy` (GwG-Belege liegen dafür im eigenen
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
- Klick auf den Dateinamen öffnet die **Inline-Vorschau** (PDF/Bild/Office),
  Download separat.

### Datei-Typen & Schutzstufen

- Jedes Dokument hat einen **Typ**; der Typ trägt die **Schutzstufe**, die
  Bucket + Object-Lock + Aufbewahrung steuert — genau drei, fix:
  *kein Lock* · *GwG · 5 Jahre* · *GoBD · 10 Jahre*.
- 7 gesetzlich fixierte Kern-Typen (read-only). Die Kanzlei kann unter
  **Admin → Datei-Typen** eigene Typen ergänzen (z. B. „Arbeitspapiere")
  und einer Stufe zuweisen (bei Anlage fix).
- **Retagging** compliance-bewusst: Höherstufung kopiert die Datei
  serverseitig in den korrekten Object-Lock-Bucket um (Re-Store, neu
  virengeprüft); gleiche Stufe = Metadaten; Herabstufung gesperrt
  (angewandte Aufbewahrung ist nicht entfernbar). Auch als Sammel-Aktion.

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
  Object-Lock (GoBD 10 J. COMPLIANCE / GwG 5 J. GOVERNANCE), Store nie
  öffentlich (App proxied Up-/Downloads).
- Upload-Limit 100 MB pro Datei; das mitgelieferte
  `infra/clamav/clamd.conf` hebt das clamd-Stream-Limit passend dazu auf
  `StreamMaxLength 110M` an (Stock-Image: 25M → Scans > 25 MB schlügen
  sonst fehl).
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
hierin umbenannt.

### Steuertermin-Engine

- Konfiguration pro Mandant: USt-VA (mtl./quart./jährl.),
  LSt-Anmeldung (mtl./quart./jährl.), ESt/KSt/GewSt-VZ + Erklärungen
- Mit Dauerfristverlängerung (USt/LSt) → +1 Monat
- **Beratene Erklärungsfrist § 149 (3) AO** als `advised`-Option pro
  Schedule-Config (letzter Tag des Monats Februar des zweiten Folgejahres
  statt 31.07. des Folgejahres). Default `false`; eine UI zum Aktivieren
  gibt es noch nicht — das Flag ist derzeit nur per DB setzbar
- Werktagsverschiebung gem. § 108 (3) AO inkl. bundes­länderspezifischer
  Feiertage (alle 16 Länder + Buß-Bettag, Karfreitag/Ostermontag/
  Pfingstmontag via Gauß-Algorithmus)
- **Tagesgenaue Überfälligkeit (§ 108 (1) AO)**: ein heute fälliger Termin
  ist noch nicht überfällig — OVERDUE wird erst nach Ende des
  Fälligkeitstags gesetzt
- Auto-Anforderung an Mandanten N Tage vor Fälligkeit (konfigurierbar),
  auditiert als `tax_deadline.auto_request`
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
  + Anliegen + optional Wunsch-Bearbeiter
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
- Einspruchsfrist automatisch berechnet (Bescheid-Datum + 33 Tage —
  Bekanntgabefiktion + 1 Monat), Warnung bei < 7 Tagen Restdauer
- **Einspruchsfristen-Reminder**: Worker `reminders-daily` schickt
  14 / 7 / 1 Tage vor `appealDeadline` Notifications an den Prüfer
  (idempotent über day-bucket pro Resource/Kind)
- **Status-Maschine mit bedienbaren Übergängen** (Quick-Action-Auswahl in
  der Tabelle, `updateNoticeStatusAction`, auditiert `tax_notice.status`),
  entlang des Einspruchs-Lebenszyklus § 347 ff. AO:
  - NEU → GEPRÜFT (Normalfall) oder direkt EINSPRUCH
  - GEPRÜFT → EINSPRUCH / RECHTSKRÄFTIG; zurück auf NEU (Fehlklick)
  - EINSPRUCH → ABGEHOLFEN / ZURÜCKGEWIESEN
  - ABGEHOLFEN / ZURÜCKGEWIESEN → RECHTSKRÄFTIG (final)
  - Side-Effects: GEPRÜFT stempelt `reviewedAt/-By`, EINSPRUCH
    `appealFiledAt`, Abschluss `appealResolvedAt`
- PDF des Bescheids wird verlinkt (über Document-Modul)
- Verknüpfungs-Indikator zeigt in der Tabelle „↪ aus Erklärung"
  + „Portal"-Badge, wenn der Mandant die Erklärung sieht

### Mandanten-Portal-Sicht

- `/portal/steuer` listet alle freigegebenen Erklärungen mit Saldo,
  Disclaimer „nicht rechtsverbindlich"
- Wenn der zugehörige Bescheid eingegangen + ab Status GEPRÜFT freigegeben:
  grüner Bestätigungs-Block mit Ist-Beträgen, Abweichung zur Erklärung,
  Einspruchsfrist-Hinweis, Download des Bescheid-PDF
- Vor GEPRÜFT: dezenter Hinweis „Bescheid liegt vor und wird von Ihrer
  Kanzlei geprüft."

## Rechnungen ⚙

Modus-Wahl pro Kanzlei:

- **`IN_APP`** (Default): vollständige Erstellung in taxtronik
  - XRechnung 3.0 CII-XML-Generierung (B2G-Pflicht)
  - ZUGFeRD/Factur-X PDF/A-3 mit eingebettetem XML
  - Status-Maschine: DRAFT → SENT → PAID / OVERDUE / CANCELLED
  - Time-to-Invoice: nicht abgerechnete Zeiteinträge eines Mandanten direkt
    in Rechnungspositionen umwandeln
  - Worker markiert überfällige Rechnungen täglich, schreibt Notification
  - CSV-Export, XRechnung- und ZUGFeRD-Download pro Rechnung
- **`EXTERNAL`**: Erstellung extern (z. B. zentrale DATEV-Abrechnung
  bei Partnerschaft mit mehreren Standorten), taxtronik versendet nur
  eine Standard-Mail mit PDF-Anhang. Konfigurierbarer Markdown-Begleittext
  mit Platzhaltern `{name}`, `{client}`, `{number}`, `{amount}`
- **`OFF`**: Modul komplett deaktiviert

## Vollmachten ⚙

Modus-Wahl pro Kanzlei:

- **`MARKDOWN_OTP`** (Default): Vollmachts-Text als Markdown in der App,
  Mandant signiert per E-Mail-Magic-Link + 6-stelligem Email-OTP
  (eIDAS „Advanced Electronic Signature")
- **`PDF_TEMPLATE`**: Standardtext + PDF-Anhang per Mail an Mandant.
  Konfigurierbarer Subject/Markdown-Body mit Platzhaltern `{name}`, `{client}`.
  Für Kanzleien mit externer Vollmachtsdatenbank
- **`OFF`**: Modul komplett deaktiviert

Status-Maschine: DRAFT → SENT → SIGNED / REVOKED. Audit-Log mit IP +
User-Agent bei Signatur.

## Workflow-Vorlagen

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
- Automatisches Schließen der Instanz wenn alle Items erledigt
- **Workflow-Statistik** unter `/staff/workflows/stats`: pro Vorlage
  Ø Durchlaufzeit (Start → COMPLETED), Anzahl aktiver/abgeschlossener/
  abgebrochener Instanzen, **Engpass-Schritt** (Position mit längster
  durchschnittlicher Bearbeitungszeit über alle Instanzen)

## Form-Builder (eigene Anfrage-Formulare an Mandanten)

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
  (ClamAV-Scan + Object-Lock-Storage, max. 10 MB pro Datei)
- Pflichtfeld-Validierung client- und server-seitig
- Antworten typgerecht angezeigt (Geld als €-formatiert, Datum,
  Multiselect als Liste, Datei verlinkt zum Download)
- „Als geprüft markieren" mit optionaler Notiz
- **Verknüpfung mit Anforderungs-Vorlagen** — siehe Anforderungen
- n8n-Events `request.opened` / `request.responded` für Mail-Trigger

## Status-Maschinen-Builder (Admin)

- Kanzlei definiert eigene Zustandsautomaten unter
  `/staff/admin/state-machines`
  (z. B. „Mandanten-Onboarding-Phase", „Erklärungs-Bearbeitungsstand")
- Listen-Editor mit Drag-and-Drop für Zustände
- Pro Zustand: Key, Label, Farbe (8 Tailwind-Tönungen), Initial-/Endzustand-Flag
- Pro Übergang: Quelle → Ziel, Label, optionale Freitext-Bedingung
- Validierung: genau ein Initial-State pro Maschine, alle Transitionen
  verweisen auf vorhandene States
- Anwendung an Ressourcen (Mandant, GwG-Check) ist als Folge-Iteration
  geplant — der Builder existiert eigenständig

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
- Pro Mandant in der Detail-Seite sichtbar (alle Kollegen sehen es)
- **Inline-Anlage** im Mandanten-Detail-Cockpit per Klappformular
- **Lifecycle-Status** (`doneAt` + `doneByStaff`)
  - „Erledigt" ist eigenständig von „gelesen" — ein Zettel ist erst fertig,
    wenn der zugewiesene Mitarbeiter zurückgerufen hat
  - Check-Button setzt `doneAt`, Rotate-Icon nimmt zurück
  - Widget aufgeteilt in Offen/Erledigt-Sektion (collapsible)
- **Übertragen** — Inline-Dropdown zum Reassignment an anderen
  Mitarbeiter; setzt `readAt` zurück und schickt Notification an neuen
  Empfänger; nur auf offenen Zetteln möglich
- **→ Wiedervorlage** — 1-Klick-Konvertierung in `ClientReminder`
  (Datum + Empfänger wählbar, Betreff/Body wird übernommen); schließt den
  Zettel automatisch; nur sichtbar wenn Zettel Mandantenbezug hat
- Gesamtansicht unter `/staff/phone-notes` mit denselben Inline-Aktionen +
  Mandanten-Link

## Wiedervorlagen

- Pro Mandant Datum + Stichwort + optional Notiz + zugewiesener
  Bearbeiter (Default: Ersteller)
- Inline-Block am Mandantendetail mit offenen + erledigten Sektionen
- Dashboard-Widget „Meine Wiedervorlagen" (Items mir zugewiesen oder von
  mir erstellt ohne Assignee)
- Worker `reminders-daily` schickt zur Fälligkeit eine Notification an
  Bearbeiter/Ersteller; idempotent über (resourceId, kind, day-bucket)
- Audit-Trail über `client_reminder.create/.done/.delete`

## Fristenkontrollbuch

Vereinheitlichte Kontrollsicht `/staff/fristen` über alle vier
fristenführenden Quellen — Steuertermine, Einspruchsfristen (Bescheide),
Anforderungs-Fälligkeiten und Wiedervorlagen.

- **Kein eigener Zustand**: Erledigung wird aus den Quellmodulen abgelesen
  (dort auditiert) — das Buch kann nie vom echten Stand abweichen
- Offene Fristen erscheinen bis zum Horizont **ohne untere Grenze** — eine
  überfällige Frist verschwindet nie durch Zeitablauf; Erledigte als
  Rückschau im gewählten Fenster (7/30/90 Tage)
- Gruppierung nach Dringlichkeit (Überfällig / Heute / Diese Woche /
  Später), Filter „Meine" (Verantwortlicher = Hauptbearbeiter des
  Mandanten, bei Wiedervorlagen die Zuweisung)
- Erledigt-Wahrheitstabellen bewusst konservativ: GEPRÜFT (Bescheid) und
  RESPONDED (Anforderung) gelten als OFFEN, solange die Entscheidung/
  Prüfung aussteht (Unit-getestet)
- **CSV-Export als Erledigungsnachweis** (Fälligkeit, Verantwortlicher,
  Status, erledigt am/von) — jeder Export als `fristen.export.csv` in der
  Audit-Hash-Chain, rate-limitiert
- Zugriffsmodell: RESTRICTED-/vertrauliche Mandanten gefiltert (identisch
  zu Kalender/Exporten)

## Pendelordner

- Physische Belege-Ordner-Übergaben verfolgen
- Status PREPARED → WITH_CLIENT → RETURNED → COMPLETED mit Auto-Stamping
  der jeweiligen Zeitstempel (`sentAt` / `returnedAt` / `completedAt`)
- Erwartetes Rückgabedatum (`expectedReturnAt`) + Inhaltsliste als
  Freitext
- Overdue-Indikator wenn `status='WITH_CLIENT' AND expectedReturnAt < heute`
- Worker `reminders-daily` schickt täglich eine Notification an den
  Ersteller bei überfälligen Pendelordnern
- Block am Mandantendetail + Aktion-Buttons „Ausgegeben / Zurückerhalten /
  Abgeschlossen"

## RSS-Reader

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

- Urlaubsantrag (Mitarbeiter beantragt, ADMIN/PARTNER entscheidet)
- Krankmeldung mit AU-Bescheinigungs-Upload
- Wandkalender für alle Mitarbeiter (4/8/12 Wochen)
  - Grün = Urlaub, Rot = Krank, Wochenenden ausgegraut
  - Reine Sichtbarkeit zur Absprache, kein Vergleich/Quoten

## BWA, Hochrechnung & Planung ⚙

### Import

- BWA-Perioden importieren als **XLSX (DATEV-Vorjahresvergleich)** oder
  **CSV (Addison)** mit Auto-Erkennung der Langform `a*.csv`
  (`Nummer;Bezeichnung;…`) vs. Kompaktform `s*.csv` (Erlöse / BE / Personal
  / Kosten / Vorl. Ergebnis als Spaltenüberschriften)
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

- **Linear + Saisonalität**: YTD-Werte aufs Jahr hochgerechnet, Spanne
  ±5 – ±18 % je nach Anteil restliches Jahr
- **Trend-Regression**: Linear-Regression über Vorjahre, Spanne aus
  1,5 × Residuen-Standardabweichung (~85 % Konfidenz)
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
- **Rechercheauftrag an n8n — anonymisiert (§ 203 StGB)**: der Berater wählt,
  was mitgeht (kein/Auszug/ganzer Sachverhalt · Textbausteine · freier Prompt);
  deterministische Schwärzung der bekannten Stammdaten + heuristische Treffer
  (Firma, IBAN, Steuernummer, Betrag, Datum, **E-Mail**) in einer
  hervorgehobenen, **editierbaren Vorschau**; das Platzhalter→Original-Mapping
  verlässt die Kanzlei nie (RLS-geschützt gespeichert)
- **Kanzleiweite, selbst anlegbare Prompt-Vorlagen**
- **Rechercheergebnisse-Ablage**: signierter n8n-Inbound (HMAC + Replay-Nonce);
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

## Wissensdatenbank ⚙

- Artikel + Kategorien
- Postgres-Volltext-Suche (deutsche Stemmer)
- Markdown-Editor

## Mandanten-Portal

- Magic-Link-Login (E-Mail), separate Auth-Surface mit eigenem Cookie
  - Im Dev wird der Link zusätzlich ins Server-Log geschrieben — kein
    Mailserver erforderlich zum Einloggen
- Anforderungen: Antworten + Dokumente hochladen, verknüpfte Formulare
  prominent verlinkt
- Formulare ausfüllen mit echtem Datei-Upload für FILE-Felder
- Dokumenten-Übersicht (eigene + von Kanzlei freigegebene)
- **Stammdaten-Self-Service** (`/portal/stammdaten`): Mandant schlägt
  Änderungen vor, Verlauf mit Status (PENDING/APPROVED/REJECTED)
- **Steuererklärungen** (`/portal/steuer`): freigegebene Erklärungen mit
  Saldo + verknüpfte Bescheide ab Status GEPRÜFT
- **Termine** (`/portal/appointments`): eigene bestätigte Termine + Anfrage-
  Formular mit 1–3 Wunschterminen + optionalem Wunsch-Bearbeiter; Verlauf
  eigener Anfragen mit Status (PENDING/ACCEPTED/REJECTED/CANCELLED) +
  Rücknahme-Button bei PENDING
- **Auswertungen** (`/portal/bwa`): Liquiditäts-Indikatoren,
  Jahres-Hochrechnung (beide Strategien mit Spanne), Plan vs.
  Hochrechnung, eigene Planungen + Szenario-Vergleich
  (siehe „BWA, Hochrechnung & Planung")
- Rechnungen-Übersicht
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
- „Alle gelesen"-Bulk-Action
- Volle Liste auf eigener Seite
- Notification-Kinds u. a. für GwG-Stufen (Soon/90/30/Expired,
  ID-Ablauf), **GwG-Pflichtlöschung** (`GWG_DELETION_DUE`, täglich an
  ADMIN/PARTNER bei löschreifen Belegen/Aufzeichnungen),
  Anforderungs-Antworten, Vollmachts-Signaturen, überfällige
  Rechnungen, Stammdaten-Änderungsanträge, Audit-Chain-Brüche,
  **Tax-Notice-Appeal-Reminder** (Einspruchsfrist 14/7/1),
  **Client-Reminder-Due** (Wiedervorlage fällig),
  **Pending-Binder-Overdue** (Pendelordner überfällig),
  **Appointment-Requested** (neue Mandanten-Terminanfrage),
  **Appointment-Decided** (Anfrage angenommen/abgelehnt)

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

- Hash-Chain-Audit-Log: jeder Eintrag hash-verkettet, Trigger blockt
  UPDATE/DELETE auf `audit_log` und `audit_seal`
- Tagesversiegelung mit RFC-3161-Zeitstempel (TSA-Adapter)
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
- Cross-Tenant-RLS-Tests (sequentiell, Vitest, in `packages/db`)
- Hash-Chain-, canonical-json- und RFC-3161-Verifikations-Tests in
  `packages/evidence/src/__tests__/`
- **Audit-Log-Rotation** („Kassenbon-Abriss")
  - Wöchentlicher Worker `audit-rotate` archiviert Segmente als
    hash-versiegeltes NDJSON im Object-Store (Object-Lock COMPLIANCE 10 J.)
  - `verify:chain` rekonstruiert die Chain durchgängig aus DB + Archiv-Dateien
  - Admin-UI unter `/staff/admin/archive` mit Manual-Trigger
  - Nur SOFT-Rotation (DB bleibt); ein konfiguriertes
    `AUDIT_ARCHIVE_MODE=HARD` wird ehrlich auf SOFT normalisiert und pro
    Lauf als Warnung geloggt — `audit_archive` behauptet keinen
    DB-Cleanup, der nicht stattfand
- **Audit-Action-Labels** für 80+ Action-Keys und alle Resource-Types
  (inkl. der Auth-, Backup-, `gwg.check.destroy`- und
  `tax_notice.status`-Events) werden in „freundlichen" Views (Dashboard,
  Timeline, Notifications) deutsch übersetzt; Compliance-View bleibt
  technisch

## Backups & Disaster Recovery

- Postgres-Dump in den S3-Backup-Bucket — manuell (`scripts/backup.sh` /
  `pnpm --filter @taxtronik/web backup:run`) oder per Operator-Cron;
  jeder Lauf wird als `backup.run` in der Audit-Chain dokumentiert
- Pre-Flight-DB-Backup vor Migration (`scripts/update.sh`)
- Backup-Records mit Größe, SHA-256 und Status (letzter Stand in der
  Admin-Übersicht)
- **Restore-Mechanismus**: `pnpm backup:restore --latest` (oder `--key`),
  automatischer Smoke-Test, Schutz vor Überschreiben durch
  `--confirm-overwrite`-Flag
- Disaster-Recovery-Runbook in `docs/operations/disaster-recovery.md`

## Update-Mechanik & Lizenzschlüssel

- Admin-UI prüft Update-Server auf neuere Versionen, signiertes Versions-Manifest
- **Lizenzschlüssel-Verifikation** (Ed25519-JWT)
  - Admin-Card mit Status-Banner (gültig/abgelaufen/fehlend)
  - CLI `scripts/license-keygen.ts` zum Erzeugen
  - Operations-Dokumentation in `docs/operations/lizenz.md`
- **Subdomain-Trennung Staff/Portal** vorbereitet (Cookie-Domain pro
  Surface über `STAFF_COOKIE_DOMAIN`/`PORTAL_COOKIE_DOMAIN`,
  Caddy-Beispiel in `docs/operations/subdomain-trennung.md`)

## Benutzer-Verwaltung (ADMIN/PARTNER)

- Anlegen mit Initial-Passwort (TOTP wird beim ersten Login eingerichtet)
- Anlegen seeded automatisch BMF + BFH als RSS-Feeds für den neuen User
- Aktivieren/Deaktivieren
- Rollen-Pflege (EMPLOYEE / PARTNER / ADMIN) inline
- Self-Lockout-Schutz (eigene Rollen nicht änderbar, eigener Account nicht
  deaktivierbar)
- Übersicht: Name, E-Mail, Rollen, 2FA-Status, letzter Login
- Tätigkeitsbereich-Zuordnung pro Mitarbeiter (Tags-Icon-Popover)

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
  - Logo-Upload (PNG/JPG/SVG/WebP, max. 200 KB als Data-URL)
- **Briefkopf** (`branding.letterhead`) — Organisationsname,
  mehrzeilige Adresse, Kontakt-Zeile, Fußnote (Steuerberaterkammer / USt-ID
  / Geschäftsführer); wird in alle ausgehenden PDFs eingebunden
  (Vollmachten, Rechnungen, Bescheinigungen)
- **Rechtliche Hinweise** (`tenant_setting.legal`) — Impressum-URL +
  Datenschutzerklärung-URL; werden im Footer der Login-Seiten (Staff +
  Portal) verlinkt (Pflicht nach Telemediengesetz / DSGVO); in
  angemeldeten Sitzungen bewusst nicht prominent angezeigt
- Modul-Aktivierung pro Tenant (BWA / Wissen / Zeiterfassung /
  Telefonzettel / Steuertermine + Bescheide / Subsumtion-TCMS)
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
  reine Zähler-KPIs ohne Namen bleiben ungefiltert). Bekannte Grenze:
  Mutations-Server-Actions verlassen sich auf Tenant-Isolation (RLS) und
  prüfen das Objekt-Gate noch nicht — wer die ID eines vertraulichen
  Mandanten kennt, kann dort Schreiboperationen auslösen.
- Vollmachten-Modus (`MARKDOWN_OTP` / `PDF_TEMPLATE` / `OFF`)
- Rechnungs-Modus (`IN_APP` / `EXTERNAL` / `OFF`)
- PDF-Begleittext-Templates für beide Modi (Markdown mit Platzhaltern)
- Steuer-Region pro Tenant (Bundesland für Feiertagsberechnung)
- Feiertagskalender pro Bundesland konfigurierbar (alle 16 Länder +
  Buß-Bettag-Berechnung)
- Custom-Felder-Definitionen für Mandanten
- Anforderungs-Vorlagen
- Status-Maschinen-Definitionen
- SMTP-Konfiguration + Test-Mail
- TSA-Konfiguration (RFC-3161)
- n8n-Bridge (HMAC-Secret, Workflow-Import)

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
- TOTP-Pflicht für Mitarbeiter (Aktivierung beim ersten Login)
- Magic-Link für Portal-Kontakte
- Token-basierte Public-Pfade ohne Auth: `/poa/sign`, `/gwg-onboarding`
- Auth-Route-Group-Layouts (`(auth)/layout.tsx`) für Staff + Portal mit
  Pflicht-Footer (Impressum + Datenschutz)
- Multi-Tenant via `tenant_id`-Discriminator + Postgres-RLS-Policies
- Pro Request: Prisma-Middleware setzt `app.current_tenant_id` /
  `app.current_actor_id` / `app.current_actor_type` via `SET LOCAL`
- Doppelte Verteidigung: App-Filter + RLS-Policy + DB-Trigger
- BullMQ-Worker für Hintergrund-Jobs (14 Workers):
  `evidence-seal`, `gwg-expiry-check`,
  `invoice-overdue-check`, `audit-verify-check`,
  `tax-deadline-materialize`, `audit-rotate`, `tax-news-fetch`
  (05:30 UTC, holt alle aktiven RSS-Feeds aus `rss_feed`),
  `reminders-daily` (06:45 UTC, schickt Notifications für
  Einspruchsfristen, fällige Wiedervorlagen, überfällige Pendelordner),
  `n8n-deliver` + `n8n-outbox-reconcile` (HMAC-signierter Outbox-Versand),
  `magic-link-cleanup`, `dsgvo-retention`, `poa-expiry-check`,
  `risk-analyse-llm` (on-demand LLM-Vertiefung der Subsumtion).
  Ein asynchroner Virus-Scan-Job existiert bewusst nicht — Scans laufen
  ausschließlich synchron beim Upload-Commit in `@taxtronik/storage`.
  Die Worker-Jobs haben eigene Unit-Tests
  (`apps/worker/src/jobs/__tests__/`)
- n8n als Workflow-Engine für Mail-Versand und Eskalationen (signierte
  HMAC-Webhooks, n8n liest via `/api/n8n/*` mit Token,
  respektiert Portal-Notification-Setting per `notifiableContacts`-Array)
- SeaweedFS für Document-Storage mit Object-Lock-Buckets
- ClamAV-Synchron-Scan + Helper `commitDocumentFromBytes` für Public-Wizard-
  Uploads
- Eigenständige Packages: `@taxtronik/db`, `@taxtronik/config`,
  `@taxtronik/evidence`, `@taxtronik/storage`, `@taxtronik/tax`,
  `@taxtronik/crypto` (AES-256-GCM Secret-Box mit HKDF-domain-getrenntem Key),
  `@taxtronik/http-utils` (SSRF-Guard + DNS-pinning-safeFetch via undici),
  `@taxtronik/rss` (Parser + Streaming-Body-Cap),
  `@taxtronik/n8n-shared` (Event-Whitelist + HMAC-Sign mit Replay-Nonce),
  `@taxtronik/risk-layer` (zustandsloser §4-Engine-Client: Schema/Mapping/
  Resilienz mit Circuit-Breaker, reiner Transport)
- **Forgejo-Actions-CI** (`.forgejo/workflows/`, self-hosted Runner): `ci.yml`
  (Quality: Lint/Typecheck/Unit · DB: Migrationen/RLS/Drift/verify:chain mit
  Postgres-Service · Browser-Smoke via Playwright), `security.yml` (pnpm-audit +
  gitleaks-Secret-Scan, wöchentlicher Cron), `build-images.yml` (Web-/Worker-
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

- **GoBD-konformer Audit-Log**: Hash-Chain pro Tenant, täglicher RFC-3161-
  TSA-Stempel (`evidence-seal` 02:30 UTC; Default-TSA **GlobalSign** kostenlos/EU,
  pro Tenant umstellbar, D-Trust für eIDAS-qualifiziert), tägliche Verifikation
  (`audit-verify-check` 02:45 UTC) mit `SYSTEM_AUDIT_BREAK`-Notification an
  ADMIN/PARTNER bei Bruch, wöchentliche NDJSON-Auslagerung mit Object-Lock-
  Versiegelung; `pnpm verify:chain` rehasht jeden Eintrag, rekonstruiert die
  Kette aus DB+Archiv und prüft den TSA-Stempel **voll kryptografisch**:
  CMS-Signatur, messageImprint an den _rekonstruierten_ Ketten-Spitzen-Hash
  gebunden (nicht an die DB-Spalte → tötet den DB-gegen-DB-Angriff), Cert-Kette
  bis zum eingebetteten GlobalSign-Root R6 _as-of_ genTime, kritische EKU
  timeStamping + ESS-SigningCertificate-Bindung; Adapter-Modus wird im Report
  ausgewiesen, Self-Timestamp im Produktivmodus = harter Fail
- **Aufbewahrungs-Buckets nach Recht getrennt**: `gobd` (10 J. § 147 AO,
  Object-Lock COMPLIANCE), `gwg` (5 J. § 8 Abs. 4 GwG — Höchstfrist mit
  Vernichtungspflicht, deshalb Object-Lock GOVERNANCE mit privilegierter
  Frühlöschung), `general` / `staff-private` (kein Object-Lock);
  Retain-Until-Logik nach Kalenderjahres-Schluss (Jahresende + N + 1 Tag)
- **TOTP-Pflicht für Staff** mit lokal generiertem QR-Code (kein Drittanbieter-
  Roundtrip), 8 Backup-Codes als One-Time-Use mit Row-Lock-Konsumption,
  TOTP-Replay-Schutz via Redis-Nonce-Set, Account-Lockout an 5 _distinkten_
  IPs (kein Single-IP-Lockout-DoS)
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
- **Rate-Limiting** auf Login, TOTP, Magic-Link, GwG-Upload, PoA-Sign,
  Portal-Write — fail-CLOSED in Production bei Redis-Ausfall;
  `checkIpOrGlobalLimit` deckelt sowohl Per-IP als auch globalen Sturm;
  per-User-Limits auf der Staff-Suche (30/min) und allen CSV-/ZIP-Exporten
  (5 pro 10 min je Export-Art: clients, audit, requests, invoices,
  datev-belege) → `429 { error: 'rate_limited' }`; öffentliche
  Token-Lade-Pfade (GwG-Onboarding, PoA-Signatur) per IP 30/10 min mit
  derselben generischen Fehlansicht wie bei ungültigem Token (kein
  Token-Probing-Orakel)
- **Reverse-Proxy-Trust-Boundary**: `TRUST_PROXY_REQUIRED`-ENV gate für
  `getClientIp` — kein blindes XFF-Vertrauen ohne explizite Operator-Zusage
- **Mail-Pipeline**: HMAC-Outbound für n8n inkl. event + 128-Bit-Nonce,
  SMTP mit `requireTLS` + `minVersion TLSv1.2`, `from`/`to`/`subject`/
  `replyTo` durch CRLF-Stripping, Markdown-Renderer escapt user-supplied
  Variablen vor `{{var}}`-Substitution
- **§ 203-Anonymisierung vor jedem Egress**: Rechercheaufträge aus der
  Subsumtion werden vor dem n8n-Relay deterministisch (bekannte Stammdaten) +
  heuristisch (Firma/IBAN/Steuernummer/Betrag/Datum/E-Mail) geschwärzt,
  editierbare Vorschau, das Platzhalter→Original-Mapping bleibt RLS-lokal;
  signierter n8n-Inbound (HMAC + Timestamp-Fenster + Redis-Replay-Nonce,
  fail-closed)
- **Container-Hardening**: `cap_drop: ALL` + `no-new-privileges` + `read_only`-
  Root-FS auf App/Worker mit `tmpfs:/tmp`, alle Infra-Ports an `127.0.0.1`,
  App/n8n hinter Reverse-Proxy (NGINX-Beispiel-Konfig in `infra/nginx/`;
  das Beispiel setzt bewusst keine eigenen Security-`add_header`-Zeilen —
  die Header kommen aus der App, ein nginx-seitiges `add_header` würde u. a.
  die token-spezifische `no-referrer`-Policy überschreiben)
- **Dev-Default-Denylist**: Bekannte Dev-Schlüsselwerte werden in Production
  in der ENV-Validierung hart abgelehnt — kein „vergessenes Setup-Skript-
  Generieren" mit committed-Secret-Material
- **Compliance-Dokumente** unter `docs/compliance/`: `gobd.md`, `gobd-template.md`,
  `dsgvo-konzept.md`, `gwg.md`, `dsfa-template.md`, `vvt-template.md`,
  `eidas-tsa.md`, `auth-secret-rotation.md`, `tenancy-model.md`,
  `cookie-config.md`, `avv-template.md`, `pen-test-vorbereitung.md`
