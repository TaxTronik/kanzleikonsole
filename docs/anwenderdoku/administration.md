# Benutzerhandbuch: Administration (Benutzer, Audit, Backup)

Dieses Kapitel richtet sich an Administratoren/Partner. Alle hier
beschriebenen Bereiche erfordern die Rolle ADMIN oder PARTNER.

## 1. Benutzerverwaltung (Kanzlei-Mitarbeiter)

**Administration → Benutzer:** Tabelle aller Mitarbeiter-Konten mit Rollen,
Tätigkeitsbereichen, Anmeldemodus/2FA-Status, letztem Login und Aktiv-Status.

- **Anlegen:** Name, E-Mail, Startpasswort (mindestens 12 Zeichen). Rollen:
  _Mitarbeiter_ (immer), optional _Partner_ und/oder _Admin_ (beide erreichen
  den Administrationsbereich). Nur ein bestehender ADMIN kann die ADMIN-Rolle
  vergeben; kein angemeldeter Staff-Akteur kann eine bestehende ADMIN-Rolle
  entziehen. Eine PARTNER-Rolle kann nur ein aktiver ADMIN derselben Kanzlei
  entziehen. PARTNER können ADMIN-Konten auch nicht deaktivieren. Mindestens
  eine Rolle ist Pflicht; die eigenen Rollen und der eigene Aktiv-Status sind
  nicht änderbar (Selbstschutz).
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
- **Standardanmeldung mit Passwort + TOTP:** Beim ersten Login richtet jede
  Person ihre Authenticator-App selbst ein (QR-Code wird lokal erzeugt, kein
  externer Dienst) und erhält **einmalig acht Backup-Codes** — sicher
  verwahren! Das Einrichtungsfenster beträgt 60 Minuten.
- **Optional nur physische Sicherheitsschlüssel:** Im eigenen Profil kann eine
  Person bis zu zehn geeignete FIDO2-Schlüssel registrieren. Erst mit zwei
  aktiven und aktuell MDS-vertrauenswürdigen Schlüsseln lässt sich „Nur
  Sicherheitsschlüssel“ einschalten; die
  Aktivierung muss mit einem registrierten Schlüssel bestätigt werden. Danach
  funktionieren Passwort, Authenticator-App und Backup-Codes ausdrücklich
  **nicht** als Login-Fallback. Schlüssel können im aktiven Modus weder
  hinzugefügt noch entfernt werden; auch die Rückkehr zu Passwort + TOTP muss
  mit einem registrierten Schlüssel bestätigt werden. Den zweiten Schlüssel
  getrennt und sicher verwahren.
- **Geeignete Schlüssel:** TaxTronik verlangt WebAuthn-Benutzerverifikation,
  einen `cross-platform`-Authenticator, ein gerätegebundenes `singleDevice`-
  Credential ohne Backup-Eignung oder -Status und einen gemeldeten
  Hardware-Transport über USB, NFC, BLE oder Smartcard. Integrierte
  Plattform-Authentikatoren sowie `hybrid`/`cable` werden abgewiesen.
- **Attestierte Modellfreigabe:** Vor der Nutzung muss der Betreiber
  `WEBAUTHN_HARDWARE_AAGUID_ALLOWLIST` mit mindestens einer geprüften
  Modell-AAGUID sowie die dazugehörige
  `WEBAUTHN_HARDWARE_POLICY_REVISION` konfigurieren. Bei jeder Änderung der
  Allowlist oder Vertrauenspolicy muss die Revision erhöht werden; eine leere
  Allowlist mit höherer Revision deaktiviert den Zugang clusterweit. Enrollment
  fordert eine direkte, vollständige `packed`-Attestation und prüft sie mit
  FIDO MDS im Modus `strict`. Login und Moduswechsel prüfen die aktuelle
  Allowlist, den signierten MDS-Eintrag und dessen positiven
  `FIDO_CERTIFIED*`-Status erneut. Widerrufene,
  nichtzertifizierte, selbstdeklarierte, unbekannte oder kompromittierte
  Statusdaten, eine leere Liste oder ein MDS-/Netzausfall blockieren die
  Hardware-Assertion; es gibt keinen Passwort-/TOTP-Fallback.
- **Keine Aussage über zwei Geräte:** Die AAGUID bezeichnet eine Modellfamilie,
  nicht die Seriennummer oder eine individuelle Schlüsselinstanz. Auch zwei
  registrierte Credentials beweisen deshalb nicht kryptografisch, dass zwei
  verschiedene physische Geräte vorliegen. Bei der Aktivierung wird ein
  Schlüssel frisch bestätigt; der zweite muss aktiv sein und die aktuelle
  Allowlist-/MDS-Prüfung ebenfalls bestehen, wird in diesem Schritt aber nicht
  erneut kryptografisch präsentiert. Beide Schlüssel
  vor dem Opt-in einzeln testen, kennzeichnen und getrennt verwahren.
- **Betrieb und Datenschutz:** Der App-Container benötigt HTTPS-Zugriff auf den
  FIDO Metadata Service; Cache und Refresh laufen bedarfsgetrieben und nicht
  als eigener periodischer Job. Beim Produktionsstart wird nur die Policy an
  die Datenbank gebunden; der MDS-Netzzugriff beginnt erst mit einer
  Hardware-Zeremonie. TaxTronik speichert AAGUID,
  Attestationsformat und Prüfzeitpunkt, nicht die rohe Zertifikatskette. Der
  externe Abruf erzeugt Server-Verbindungsdaten. Allowlist-Änderungen,
  Monitoring, Ausfall und Datenschutz sind vor dem Rollout nach dem
  [FIDO-MDS-Runbook](../operations/fido-mds.md) zu planen.
- **Deaktivieren** beendet sofort alle aktiven Sitzungen der Person; ebenso
  erzwingt jede Rollenänderung eine Neuanmeldung. Bei Redis-Ausfall schlägt die
  Aktion sichtbar fehl, statt einen nicht durchgesetzten Widerruf zu melden.
- **Kontowiederherstellung:** ADMIN können Passwort und TOTP von
  PARTNER-/Mitarbeiterkonten zurücksetzen; PARTNER dürfen dies ausschließlich
  für Mitarbeiterkonten. Der Reset wird an die aktuelle Auth-Revision der
  handelnden Person gebunden und widerruft auch Hardware-Credentials, die das
  Zielkonto bereits im Passwortmodus registriert, aber noch nicht für
  Hardware-only aktiviert hatte. Eine eigene Passwortänderung widerruft
  entsprechend die eigenen noch aktiven Vorabregistrierungen. Für ein Konto im
  Modus „Nur Sicherheitsschlüssel“
  sind die normalen Passwort-/TOTP-Resets absichtlich gesperrt. Stattdessen
  sperrt **Hardware-Zugang wiederherstellen** alle registrierten Schlüssel,
  deaktiviert den Modus, setzt ein neues Startpasswort und erzwingt beim
  nächsten Login ein neues TOTP-Setup. Der Reset folgt derselben Hierarchie.
  Vor der Freigabe muss die handelnde Person ihre Identität erneut bestätigen:
  Im Standardmodus sind das das aktuelle eigene Passwort und ein frischer
  sechsstelliger TOTP aus der Authenticator-App; ein Backup-Code ist hier
  ausdrücklich nicht zulässig. Nutzt die handelnde Person selbst
  Hardware-only, bestätigt sie mit ihrem eigenen registrierten Schlüssel. Die
  dafür erzeugte Einmal-Anfrage ist an handelnde Person, Zielkonto und aktuelle
  Auth-Revision gebunden.

  Schlüsselwiderruf, Rückkehr in den Passwort-/TOTP-Modus, Erhöhung der
  Auth-Revision und Prüfprotokoll-Eintrag werden unter den Datenbanklocks
  gemeinsam ausgeführt. Die Auth-Revision macht alle vorherigen Hardware-
  Sessions beim nächsten Request ungültig. Parallel geänderte Rollen oder
  Anmeldezustände brechen die Recovery ohne Teiländerung ab; insbesondere wird
  davor kein separater Redis-Widerruf ausgeführt, der trotz DB-Rollback als
  Logout bestehen bleiben könnte.
  ADMIN-Konten sind von allen Web-Recovery-Aktionen ausgenommen und werden bei
  Verlust von Passwort, TOTP oder Sicherheitsschlüsseln ausschließlich über
  `ADMIN_EMAIL=… TENANT_SLUG=… pnpm --filter @taxtronik/db reset-admin-password`
  wiederhergestellt. Die CLI deaktiviert Hardware-only, sperrt registrierte
  Schlüssel, erhöht die Auth-Revision und startet Passwort/TOTP-Onboarding
  neu. Reset, Schlüsselwiderruf und ein `SYSTEM`-Eintrag im Prüfprotokoll
  werden gemeinsam abgeschlossen. Das Klartextpasswort erscheint
  ausschließlich in der gewählten Credential-Datei, niemals im Terminal oder
  in Logs. Die CLI legt die Datei exklusiv (`O_EXCL`) mit No-follow-Schutz neu
  an (POSIX: `0600`) und committet den Reset erst nach vollständigem
  Datei-`fsync` und anschließendem `fsync` des POSIX-Elternverzeichnisses. Eine
  vorhandene Datei oder ein Symlink wird nicht überschrieben; ein Ausgabefehler
  lässt den Reset zurückrollen und entfernt nur eine in diesem Versuch
  entstandene Teildatei. Scheitert erst der Datenbank-Commit, kann die bereits
  geschriebene, aber unwirksame Datei zurückbleiben; sie muss anhand des
  CLI-Fehlers verworfen werden. Beide Auswahlwerte sind Pflicht. Gibt es keinen
  oder wider Erwarten
  mehrere Treffer, bricht sie ohne Änderung ab; sie setzt niemals mehrere
  Admin-Konten gesammelt zurück.

- **Fehlversuche:** Wiederholte Fehlanmeldungen werden begrenzt
  (Wartezeiten); ein Konto wird erst gesperrt, wenn Fehlversuche von
  mehreren verschiedenen Quelladressen kommen — eine einzelne Person kann
  fremde Konten nicht aussperren. Fehlversuche mit einem bekannten
  Hardware-Credential stehen tenantgebunden und ohne Schlüssel-ID, E-Mail oder
  internes Prüfdetail im Prüfprotokoll. Unbekannte Konten oder Credentials
  erzeugen bewusst keinen tenantlosen Eintrag.

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
