# Benutzerhandbuch: Administration (Benutzer, Audit, Backup)

Dieses Kapitel richtet sich an Administratoren/Partner. Alle hier
beschriebenen Bereiche erfordern die Rolle ADMIN oder PARTNER.

## 1. Benutzerverwaltung (Kanzlei-Mitarbeiter)

**Administration → Benutzer:** Tabelle aller Mitarbeiter-Konten mit Rollen,
Tätigkeitsbereichen, 2FA-Status, letztem Login und Aktiv-Status.

- **Anlegen:** Name, E-Mail, Startpasswort (mindestens 12 Zeichen). Rollen:
  _Mitarbeiter_ (immer), optional _Partner_ und/oder _Admin_ (beide erreichen
  den Administrationsbereich). Nur ein bestehender ADMIN kann die ADMIN-Rolle
  vergeben oder verändern; PARTNER können ADMIN-Konten auch nicht
  deaktivieren. Mindestens eine Rolle ist Pflicht; die eigenen Rollen und der
  eigene Aktiv-Status sind nicht änderbar (Selbstschutz).
- **Berechtigungen (Einzelrechte):** Für Mitarbeiter ohne Admin-/Partner-
  Rolle steuern drei Schalter, was sie zusätzlich dürfen: _Rechnungen
  anlegen/bearbeiten_, _Rechnungen versenden_ (löst die unveränderliche
  Festschreibung aus; umfasst auch den PDF-Upload im Extern-Modus) und
  _Urlaub entscheiden_ (entscheidet Urlaubsanträge und erhält Urlaubs-/
  Abwesenheitsmeldungen). Admin/Partner haben immer alle Rechte. **Neu
  angelegte Mitarbeiter starten ohne Rechnungs-Rechte**; bestehende
  Mitarbeiter behalten beim Update ihre bisherigen Möglichkeiten und
  können danach gezielt eingeschränkt werden. Jede Änderung steht im
  Prüfprotokoll; ein Rechteentzug beendet die Sitzungen der betroffenen
  Person sofort. Ist der dafür erforderliche Redis-Widerruf nicht verfügbar,
  wird die Änderung nicht als erfolgreich gemeldet. Auch die Sessionprüfung
  lehnt bei einem Redis-Lesefehler fail-closed ab. Erweiterungen werden bei der
  nächsten Sessionprüfung aus der Datenbank wirksam, ohne zwingend auszuloggen.
- **Zwei-Faktor (TOTP) ist Pflicht:** Beim ersten Login richtet jede Person
  ihre Authenticator-App selbst ein (QR-Code wird lokal erzeugt, kein
  externer Dienst) und erhält **einmalig acht Backup-Codes** — sicher
  verwahren! Das Einrichtungsfenster beträgt 60 Minuten.
- **Deaktivieren** beendet sofort alle aktiven Sitzungen der Person; ebenso
  erzwingt jede Rollenänderung eine Neuanmeldung. Bei Redis-Ausfall schlägt die
  Aktion sichtbar fehl, statt einen nicht durchgesetzten Widerruf zu melden.
- **Kontowiederherstellung:** ADMIN können Passwort und TOTP von
  PARTNER-/Mitarbeiterkonten zurücksetzen; PARTNER dürfen dies ausschließlich
  für Mitarbeiterkonten. Dabei werden alle laufenden Sitzungen beendet und der
  Vorgang wird protokolliert. ADMIN-Konten sind von diesen Web-Aktionen
  ausgenommen und werden bei Passwort- oder TOTP-Verlust ausschließlich über
  `ADMIN_EMAIL=… TENANT_SLUG=… pnpm --filter @taxtronik/db reset-admin-password`
  wiederhergestellt. Beide Auswahlwerte sind Pflicht. Gibt es keinen oder
  wider Erwarten mehrere Treffer, bricht die CLI ohne Änderung ab; sie setzt
  niemals mehrere Admin-Konten gesammelt zurück.
- **Fehlversuche:** Wiederholte Fehlanmeldungen werden begrenzt
  (Wartezeiten); ein Konto wird erst gesperrt, wenn Fehlversuche von
  mehreren verschiedenen Quelladressen kommen — eine einzelne Person kann
  fremde Konten nicht aussperren. Alle Anmeldevorgänge stehen im
  Prüfprotokoll.

**Mandanten-Zugänge (Portal):** werden in der jeweiligen Mandantenakte
unter _Kontakte_ gepflegt (einladen, bearbeiten, deaktivieren — letzteres
beendet die Portal-Sitzung sofort). Mandanten melden sich ausschließlich
per E-Mail-Anmeldelink an (30 Minuten gültig, einmal verwendbar); Mandanten
ohne GwG-Freigabe erhalten keinen Zugang.

**Zugriffssteuerung auf Mandanten:** Unter Einstellungen wählbar: _Offen_
(jeder aktive Mitarbeiter sieht alle nicht-vertraulichen Mandanten) oder
_Eingeschränkt_ (nur zuständige Mitarbeiter laut Zuständigkeitsliste);
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
  RFC-3161-Anbieter gewählt (kostenlose oder kommerzielle Presets; eigener
  öffentlich auflösbarer Endpunkt möglich). Private/interne Ziele werden als
  SSRF-Schutz abgelehnt. Anbieter wie D-Trust bieten qualifizierte Dienste an;
  TaxTronik leitet die Qualifikation des konkret genutzten Dienstes jedoch
  nicht allein aus dem Preset ab. Vertrag, Endpunkt, Zertifikat und
  EU-Vertrauensliste sind durch den Betreiber zu prüfen.
  Produktion verlangt einen externen Anbieter und verwendet einheitlich in
  Worker und Statusprüfung die Reihenfolge Tenant-Einstellung →
  `TIMESTAMP_AUTHORITY_URL` → GlobalSign. Für Nicht-GlobalSign-Anbieter muss
  der Betreiber den zugehörigen Trust Anchor über `TSA_TRUSTED_ROOTS_FILE`
  bereitstellen und prüfen. Ein nicht qualifizierter Stempel bleibt ein externer Nachweis,
  besitzt aber nicht die gesetzliche Vermutungswirkung eines qualifizierten
  Zeitstempels. Ob diese benötigt wird, entscheidet die Kanzlei für ihren
  Prozess; Details stehen in `docs/compliance/eidas-tsa.md`.
- **Archivierung:** Wöchentlich werden ältere Protokollsegmente als
  unveränderliche Dateien (10 Jahre, schreibgeschützt) in den Object-Store
  ausgelagert; die Datenbank-Einträge bleiben zusätzlich erhalten.

## 3. Backup und Wiederherstellungstest

**Administration (Startseite), Karte „Letztes Backup":**

- zeigt Zeitpunkt, Status und Größe der letzten **Datenbanksicherung** sowie das
  Ergebnis des **monatlichen Restore-Tests** (1. des Monats): „erfolgreich
  (N Audit-Einträge verifiziert)" bedeutet, dass das letzte Backup real in
  eine Prüfdatenbank eingespielt und die Audit-Kette darauf verifiziert
  wurde. Ein Fehlschlag erzeugt eine Benachrichtigung an alle
  Administratoren und erfordert sofortige Klärung. Die Karte ist kein Nachweis
  über den Stand eines Full- oder Offsite-Backups.
- **Tägliche Datenbanksicherung:** Der Worker erstellt um 01:00 UTC
  automatisch einen Postgres-Dump im S3-Backup-Bucket. Der Betreiber muss
  Ausführung und Restore-Tests überwachen und zusätzlich lokale beziehungsweise
  externe Kopien vorsehen: `./taxtronik backup` erzeugt die lokale
  Operator-Kopie. Diese normalen DB-Dumps werden von TaxTronik nicht selbst
  verschlüsselt; `update`/`deploy` sichern außerdem vor jeder
  Datenbankmigration.
- **Full-Backup (Betreiber-Aufgabe):** `./taxtronik backup-full` erzeugt in
  einem Wartungsfenster einen gemeinsamen Wiederanlaufpunkt aus TaxTronik- und
  n8n-Datenbank, Cold-Snapshots der SeaweedFS-, Redis- und n8n-Volumes sowie der
  Recovery-Konfiguration. Das Klartext-Staging wird anschließend gelöscht; das
  Ergebnis ist ein age-verschlüsseltes Archiv mit signiertem SHA-256-Manifest.
  Ein getrennt administriertes, versionsfähiges Offsite-Ziel mit Object Lock
  ist für den Standortausfall vorzusehen. `backup-files` ist nur eine
  ergänzende Byte-Kopie der Dokument-Buckets und kein Ersatz für diesen
  Recovery Point.
- **Grenze des Monats-Tests:** Der automatische Drill stellt nur den
  Datenbank-Dump wieder her und prüft die Audit-Kette. Er entschlüsselt kein
  Full-Backup, restauriert keine Cold-Volumes und prüft weder n8n-Credentials
  noch Login oder Dokumentabruf. Ein regelmäßig dokumentierter Full-Restore auf
  einem **isolierten Zielsystem** bleibt Betreiberpflicht.
- Installationsweite Datenbank- und Full-Backups sind aus dem Browser bewusst
  nicht herunterladbar. Verifikation, Offsite-Kopie und Wiederherstellung
  erfolgen durch den Server-Betreiber. Verfahren und Kurzbefehle stehen in den
  Runbooks [Day-2 Operations](../operations/day-2-operations.md) und
  [Disaster Recovery](../operations/disaster-recovery.md).

## 4. n8n-Automatisierung

Unter **Administration → Einstellungen → n8n-Automatisierung** wird n8n nicht mehr als
eine einzige, globale Webhook-URL behandelt. Administratoren verbinden dort
optional die n8n-Instanz zur Workflow-Verwaltung und erfassen anschließend pro
Workflow dessen exakte Production-Webhook-URL plus abonnierte Events. Mehrere
Ziele für dasselbe Event sind möglich und werden unabhängig zugestellt.

Der Status unterscheidet deshalb:

- die optionale n8n-API-Verbindung für Import und Verwaltung,
- den fail-closed Ablauf **Entwurf → synthetischer Test → unveränderte
  Aktivierung** jedes einzelnen Workflow-Ziels; URL- oder Eventänderungen
  deaktivieren das Ziel wieder und verwerfen den Prüfnachweis,
- den Zustellstatus je Ziel sowie das aggregierte Ergebnis eines Events,
- und die bewusste Entscheidung **Deaktiviert**, wenn die Kanzlei n8n nicht
  einsetzen möchte.

Das Outbound-HMAC-Secret, der optionale n8n-Management-API-Key und das
tenantgebundene Callback-Credential sind drei unterschiedliche Zugangsdaten.
Das Callback-Token wird nur bei seiner Erzeugung angezeigt und besitzt
explizite Lese-/Schreib-Scopes. Secrets werden nach dem Speichern nicht erneut
angezeigt. Die separat gespeicherte **TaxTronik-Adresse aus n8n** ist beim
mitgelieferten Compose-Betrieb in Produktion normalerweise
`http://app:3000`, im lokalen Dev-Stack
`http://host.docker.internal:3000`; eine externe n8n-Instanz benötigt
stattdessen die aus ihrer Laufzeit erreichbare TaxTronik-Adresse.
Einrichtung, eigene Workflows, Eventkatalog, Datenschutz und Fehlerdiagnose
stehen im Kapitel
[n8n-Automatisierungen](n8n-automatisierungen.md). Secret-Rotation und
Netzwerkbetrieb bleiben Betreiberaufgaben.

## 5. Datenschutz-Einwilligungen und Dienstleister

Unter **Administration → Datenschutz** pflegt die Kanzlei neben dem Text der
Datenschutzhinweise auch die freiwilligen Einwilligungsoptionen, die in der
internen Erfassung und im öffentlichen GwG-Onboarding angeboten werden.

- Standardoptionen wie Fax oder Newsletter können deaktiviert und später
  wieder aktiviert werden. Das verändert keine bereits abgegebenen
  Erklärungen.
- Eigene Optionen erhalten eine Bezeichnung, eine optionale Erläuterung und
  einen Bereich. „Entfernen“ deaktiviert eine bereits gespeicherte Option;
  historische Nachweise behalten dadurch ihren eingefrorenen Wortlaut.
- Eine Option kann mit einem unter **Dienstleister** erfassten Anbieter
  verknüpft werden. Der Nachweis friert dessen Namen, Kategorie,
  Datenzugriffskennzeichen und erfassten AVV-/Vertragszeitraum zum Zeitpunkt
  der Erklärung ein. Die Verknüpfung ersetzt keinen erforderlichen Vertrag
  nach Art. 28 DSGVO.
- Ein verknüpfter Dienstleister kann erst gelöscht werden, nachdem die
  Verknüpfung im Einwilligungskatalog entfernt wurde. Bei historischen,
  bereits fehlenden Anbietern zeigt die Administration einen Reparaturhinweis
  und verlangt eine neue Auswahl oder „keiner“.
- Gleichzeitige Änderungen in zwei Admin-Sitzungen werden nicht still
  überschrieben. Die zweite Sitzung muss die Seite neu laden und ihren Stand
  erneut prüfen. Ein beschädigter Katalog sperrt neue Erfassungen
  vorsichtshalber, kann aber auf derselben Admin-Seite kontrolliert durch einen
  vollständig validierten Katalog ersetzt werden.

Einwilligungen sind freiwillig und zweckbezogen. Rechtsgrundlagen,
Auftragsverarbeitungsverträge, Löschfristen und die tatsächliche technische
Einbindung eines Dienstleisters bleiben unabhängig davon zu prüfen.

## 6. Weitere Admin-Bereiche (Verweise)

- **Datei-Typen & Schutzstufen**, **GwG-Pflichtlöschung** → Kapitel
  [Dokumente](dokumente.md)
- **Rechnungstypen** (Extern-Modus) → Kapitel [Rechnungen](rechnungen.md)
- **Verfahrensdokumentation (GoBD)** → erzeugt ein datiertes Dokument aus
  dem IST-Zustand des Systems (Quick-Link auf der Admin-Startseite); bei
  wesentlichen Konfigurationsänderungen neu erzeugen und ablegen.
- **Updates:** Die Karte „Versionen/Updates" zeigt die installierte Version
  und verfügbare Releases (signiertes Update-Manifest). Eingespielt wird
  ausschließlich vom Server-Betreiber.
