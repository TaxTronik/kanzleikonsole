# Benutzerhandbuch: Administration (Benutzer, Audit, Backup)

Dieses Kapitel richtet sich an Administratoren/Partner. Alle hier
beschriebenen Bereiche erfordern die Rolle ADMIN oder PARTNER.

## 1. Benutzerverwaltung (Kanzlei-Mitarbeiter)

**Administration → Benutzer:** Tabelle aller Mitarbeiter-Konten mit Rollen,
Tätigkeitsbereichen, 2FA-Status, letztem Login und Aktiv-Status.

- **Anlegen:** Name, E-Mail, Startpasswort (mindestens 12 Zeichen). Rollen:
  *Mitarbeiter* (immer), optional *Partner* und/oder *Admin* (beide gelten
  als Administratoren). Mindestens eine Rolle ist Pflicht; die eigenen
  Rollen und der eigene Aktiv-Status sind nicht änderbar (Selbstschutz).
- **Berechtigungen (Einzelrechte):** Für Mitarbeiter ohne Admin-/Partner-
  Rolle steuern drei Schalter, was sie zusätzlich dürfen: *Rechnungen
  anlegen/bearbeiten*, *Rechnungen versenden* (löst die unveränderliche
  Festschreibung aus; umfasst auch den PDF-Upload im Extern-Modus) und
  *Urlaub entscheiden* (entscheidet Urlaubsanträge und erhält Urlaubs-/
  Abwesenheitsmeldungen). Admin/Partner haben immer alle Rechte. **Neu
  angelegte Mitarbeiter starten ohne Rechnungs-Rechte**; bestehende
  Mitarbeiter behalten beim Update ihre bisherigen Möglichkeiten und
  können danach gezielt eingeschränkt werden. Jede Änderung steht im
  Prüfprotokoll und beendet die Sitzungen der betroffenen Person.
- **Zwei-Faktor (TOTP) ist Pflicht:** Beim ersten Login richtet jede Person
  ihre Authenticator-App selbst ein (QR-Code wird lokal erzeugt, kein
  externer Dienst) und erhält **einmalig acht Backup-Codes** — sicher
  verwahren! Das Einrichtungsfenster beträgt 60 Minuten.
- **Deaktivieren** beendet sofort alle aktiven Sitzungen der Person; ebenso
  erzwingt jede Rollenänderung eine Neuanmeldung.
- **Wichtig (bekannte Grenze):** Einen Passwort-/TOTP-Reset für bestehende
  Konten gibt es derzeit nicht — bei verlorenem Authenticator samt
  Backup-Codes wird das Konto deaktiviert und neu angelegt.
- **Fehlversuche:** Wiederholte Fehlanmeldungen werden begrenzt
  (Wartezeiten); ein Konto wird erst gesperrt, wenn Fehlversuche von
  mehreren verschiedenen Quelladressen kommen — eine einzelne Person kann
  fremde Konten nicht aussperren. Alle Anmeldevorgänge stehen im
  Prüfprotokoll.

**Mandanten-Zugänge (Portal):** werden in der jeweiligen Mandantenakte
unter *Kontakte* gepflegt (einladen, bearbeiten, deaktivieren — letzteres
beendet die Portal-Sitzung sofort). Mandanten melden sich ausschließlich
per E-Mail-Anmeldelink an (30 Minuten gültig, einmal verwendbar); Mandanten
ohne GwG-Freigabe erhalten keinen Zugang.

**Zugriffssteuerung auf Mandanten:** Unter Einstellungen wählbar: *Offen*
(jeder aktive Mitarbeiter sieht alle nicht-vertraulichen Mandanten) oder
*Eingeschränkt* (nur zuständige Mitarbeiter laut Zuständigkeitsliste);
Administratoren sehen immer alles.

## 2. Prüfprotokoll (Audit)

**Administration → Audit:**

- **Hash-Chain-Status:** Karte mit dem Ergebnis der täglichen
  Integritätsprüfung (02:45 UTC) — grün „intakt" mit Anzahl geprüfter
  Einträge und Tagesversiegelungen, rot mit der ersten gebrochenen
  Eintrags-ID. **Jetzt prüfen** stößt eine sofortige Prüfung an (der Anstoß
  selbst wird protokolliert). Bei einem Bruch erhalten alle Administratoren
  zusätzlich eine Benachrichtigung.
- **Einträge durchsuchen:** Filter nach Aktion, Akteurstyp
  (Mitarbeiter/Mandant/System), Ressourcentyp und Zeitraum; die Detailseite
  zeigt Vorher/Nachher-Werte und prüft den Hash des Einzeleintrags live.
- **CSV-Export:** inklusive der Hash-Werte; mengenbegrenzt (Kürzung wird im
  Export vermerkt) und ratenlimitiert; jeder Export wird protokolliert.
- **Prüfer-Link:** Ein zeitlich begrenzter, signierter Link erlaubt einem
  externen Prüfer die reine Chain-Verifikation **ohne** Datenzugriff.
  Einzel-Widerruf ist nicht möglich (nur über Schlüsselrotation) — Links
  sparsam vergeben.
- **Zeitstempel (TSA):** Unter Einstellungen → Beweissicherung wird der
  RFC-3161-Anbieter gewählt (kostenlose Anbieter oder eIDAS-qualifizierte
  wie D-Trust; eigener Endpunkt möglich). In Produktion ist ein externer
  Anbieter Pflicht — reine Selbst-Zeitstempel meldet die tägliche Prüfung
  als Verstoß.
- **Archivierung:** Wöchentlich werden ältere Protokollsegmente als
  unveränderliche Dateien (10 Jahre, schreibgeschützt) in den Object-Store
  ausgelagert; die Datenbank-Einträge bleiben zusätzlich erhalten.

## 3. Backup und Wiederherstellungstest

**Administration (Startseite), Karte „Letztes Backup":**

- zeigt Zeitpunkt, Status und Größe der letzten Sicherung sowie das
  Ergebnis des **monatlichen Restore-Tests** (1. des Monats): „erfolgreich
  (N Audit-Einträge verifiziert)" bedeutet, dass das letzte Backup real in
  eine Prüfdatenbank eingespielt und die Audit-Kette darauf verifiziert
  wurde. Ein Fehlschlag erzeugt eine Benachrichtigung an alle
  Administratoren und erfordert sofortige Klärung.
- **Wichtig (Betreiber-Pflicht):** Die *tägliche* Sicherung selbst wird vom
  Server-Betreiber eingerichtet (`./taxtronik backup` per Cron) — sie
  läuft nicht automatisch aus der Anwendung. `./taxtronik update`/`deploy`
  sichern zusätzlich vor jeder Datenbankmigration automatisch.
- Wiederherstellung im Ernstfall: siehe Disaster-Recovery-Runbook
  (Betriebsdokumentation); Kurzbefehle stehen auf der Admin-Karte.

## 4. Weitere Admin-Bereiche (Verweise)

- **Datei-Typen & Schutzstufen**, **GwG-Pflichtlöschung** → Kapitel
  [Dokumente](dokumente.md)
- **Rechnungstypen** (Extern-Modus) → Kapitel [Rechnungen](rechnungen.md)
- **Verfahrensdokumentation (GoBD)** → erzeugt ein datiertes Dokument aus
  dem IST-Zustand des Systems (Quick-Link auf der Admin-Startseite); bei
  wesentlichen Konfigurationsänderungen neu erzeugen und ablegen.
- **Updates:** Die Karte „Versionen/Updates" zeigt die installierte Version
  und verfügbare Releases (signiertes Update-Manifest). Eingespielt wird
  ausschließlich vom Server-Betreiber.
