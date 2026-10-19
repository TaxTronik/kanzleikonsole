# Tax-CMS-Betrieb (TCMS)

Das Tax-CMS (TCMS) ist ein interner, headless Dienst der kanzleikonsole
(ADR 0001 im TCMS-Repository, `docs/adr/0001-headless-dienst.md`, Abschnitt
8). Es ist nicht mit der Signal-Engine zu verwechseln, die historisch
„Risk-Layer / TCMS-Engine“ hieß. Diese Seite beschreibt den Betrieb in der
kanzleikonsole: Betriebsmodi, Netze, Images, Einrichtung, Rotation,
Sicherung und typische Fehlerbilder. Die Anwendungsvariablen von app und worker
(`TCMS_URL`, `TCMS_SERVICE_TOKEN`, `TCMS_ACTOR_PRIVATE_KEY`, `TCMS_ACTOR_KEY_ID`)
beschreibt die Konfigurationsdoku der Anwendung; hier geht es um ihre
Bereitstellung.

## 1. Betriebsmodi

`TCMS_DEPLOYMENT` legt fest, wem der Dienst gehört (Muster der Signal-Engine):

| Modus      | Bedeutung                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `managed`  | Die kanzleikonsole betreibt Datenbank, Migrationsschritt und Dienst selbst (Compose-Profil `tcms`), erzeugt alle Geheimnisse und rotiert sie. |
| `external` | Ein anderswo betriebenes Tax-CMS wird nur angebunden (HTTPS-URL, ein Dienst-Token, eigenes Schlüsselpaar). TaxTronik startet nichts.          |
| `disabled` | Modul aus. Leer gilt als `disabled`; jeder andere Wert ist ein Fehler.                                                                        |

Abweichend von Signal gilt für das Tax-CMS:

- eigene interne Netze statt des gemeinsamen Netzes `taxtronik`,
- eigene Datenbank mit eigenen Rollen (`tcms_owner`, `tcms_app`),
- Images ausschließlich per Digest aus dem signierten Release-Stand,
- Token- und Schlüsselrotation mit Überlappung.

## 2. Dienste und Netze (`managed`)

Die Operator-CLI lädt `infra/compose/docker-compose.tcms.yml` nur bei
`TCMS_DEPLOYMENT=managed` zusätzlich. Compose interpoliert auch Dienste
inaktiver Profile; ein Profil allein könnte die Pflichtwerte deshalb nicht auf
den verwalteten Fall beschränken. Fehlt im verwalteten Modus ein Pflichtwert,
bricht jeder Compose-Aufruf mit `… fehlt - ./taxtronik tcms setup` ab; in den
anderen Modi kennt Compose die TCMS-Dienste gar nicht.

| Dienst          | Image                                                     | Netze                           | Zweck                                                                      |
| --------------- | --------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------- |
| `tcms-db`       | `postgres:18-alpine` (Digest wie die Hauptdatenbank)      | `tcms-backend`                  | Datenbank `tcms`, Volume `tcms-db-data`, Superuser `tcms`                  |
| `tcms-migrate`  | `${TAXTRONIK_IMAGE_PREFIX}/tcms-migrate:<TCMS-Version>@…` | `tcms-backend`                  | kurzlebig: Rollen-Bootstrap, Migrationen, Prüfung der Laufzeitrolle        |
| `tcms-api`      | `${TAXTRONIK_IMAGE_PREFIX}/tcms-api:<TCMS-Version>@…`     | `tcms-backend`, `tcms-frontend` | Dienst auf Port 3200 (nur intern), Healthcheck `node /app/healthcheck.mjs` |
| `app`, `worker` | unverändert                                               | `default`, `tcms-frontend`      | sprechen `http://tcms-api:3200` an                                         |

Beide TCMS-Netze sind `internal: true` (`taxtronik-tcms-backend`,
`taxtronik-tcms-frontend`): kein Weg ins Internet, keine veröffentlichten
Ports. App und Worker erreichen die TCMS-Datenbank nie; `tcms-api` erreicht
weder die Hauptdatenbank noch Redis, SeaweedFS oder n8n. Reihenfolge:
`tcms-db` gesund → `tcms-migrate` erfolgreich beendet → `tcms-api`.

Härtung wie bei den übrigen Diensten: `read_only`, `no-new-privileges`,
`cap_drop: ALL` ohne `cap_add`, `tmpfs` für `/tmp`, Log-Rotation, `mem_limit`.
`tcms-db` läuft als UID/GID 70 (postgres-Benutzer des Images), `tcms-api` als 10001. `tcms-db` schreibt Statements auch bei Fehlern nie ins Log
(`log_min_error_statement=panic`, `log_error_verbosity=terse`), weil
Rollenpasswörter beim Bootstrap und Restore als SQL-Literal im Statement
stehen.

Jeder Dienst bekommt nur seine eigenen Geheimnisse: `tcms-db` das
Superuser-Passwort, `tcms-migrate` Superuser-, Owner- und App-Passwort,
`tcms-api` die Token-Liste, die öffentlichen Schlüssel, den Code-Schlüssel
(`TCMS_CODE_SCHLUESSEL`) und die URL der Rolle `tcms_app`; app und worker genau
ein Dienst-Token und den eigenen privaten Schlüssel. Der Code-Schlüssel kommt
wie die Token-Liste nur aus der `.env` (`0600`) als Pflichtwert
(`${TCMS_CODE_SCHLUESSEL:?…}`), nie aus dem Image, nie zu `tcms-migrate`, in
den Healthcheck oder zu app/worker. `scripts/tests/tcms-compose.test.mjs`
prüft Netze, Härtung und Umgebung am tatsächlichen Compose-Modell.

## 3. Images und Release

`tcms-api` und `tcms-migrate` baut das TCMS-Repository (Schnittstelle:
Nicht-root, nur Laufzeitabhängigkeiten, `tcms-migrate` ohne Node). Tag ist die
TCMS-Version. Compose zieht beide nie selbst (`pull_policy: never`).

**Release-Kanal (Produktion).** Welche TCMS-Version ein kanzleikonsole-Stand
freigibt, steht in `infra/compose/tcms-release.env` (Version und zwei
sha256-Digests, oder alle leer). Die Operator-CLI liest die Datei
ausschließlich aus genau dem Commit, den das signierte Update-Manifest nennt
(`git show <commit>:infra/compose/tcms-release.env`), nie aus dem Arbeitsbaum.
Damit gilt dieselbe Kette wie für Web und Worker: `UPDATE_PUBLIC_KEY` →
Manifest-Signatur → Release-Commit → Digest. Der Compose-Wrapper verweigert
jeden Aufruf, wenn `TCMS_VERSION`, `TCMS_API_DIGEST_SUFFIX` oder
`TCMS_MIGRATE_DIGEST_SUFFIX` (so, wie Compose sie interpoliert: eine gesetzte
Prozessvariable gewinnt vor `.env`) von den Pins des verifizierten
Last-Good-Commits in `.taxtronik.state` abweichen. Verankert der Stand kein
TCMS-Release, ist `managed` dort nicht betreibbar.

**Source-Kanal (nur außerhalb Produktion).** `TCMS_VERSION` nennt einen lokal
gebauten Tag `taxtronik/tcms-api:<tag>` bzw. `taxtronik/tcms-migrate:<tag>`
ohne Digest-Suffix. Gebaut wird im TCMS-Checkout mit dessen Dockerfiles, zum
Beispiel `docker build -t taxtronik/tcms-api:<tag> …`; fehlt ein lokales
Image, bricht `deploy` vor jeder Migration ab.

**deploy und update.** Nach der Signatur- und Checkout-Prüfung stagt die CLI
die Pins des signierten Commits nur für den laufenden Prozess, zieht beide
Images per Digest (Docker prüft den Inhalt gegen den Digest) und vergleicht
das Label `org.opencontainers.image.version` mit der TCMS-Version, alles vor
Pflichtbackup und Migration. Nach den Migrationen der kanzleikonsole startet
sie `tcms-db`, führt `tcms-migrate` aus (Exit-Code wird ausgewertet) und
erzeugt `tcms-api` neu; erst danach starten app und worker. Wird der neue
`tcms-api` nicht gesund, startet der bisherige Stand aus `.env` wieder und der
Ablauf bricht ab. Persistiert werden die Pins zusammen mit dem
Last-Good-Vertrag. Verankert der signierte Stand kein TCMS-Release, bricht ein
verwaltetes Tax-CMS den Ablauf vor jeder Wirkung ab; ohne verwaltetes Tax-CMS
läuft er normal weiter.

**Erster Rollout mit Code-Schlüssel (TCMS s8, Hinweis H5).** Ab diesem
TCMS-Stand speichert der Dienst Bestätigungscodes nur als HMAC mit
`TCMS_CODE_SCHLUESSEL` und startet ohne gültigen Schlüssel nicht. `deploy` und
`update` erzeugen einen fehlenden Schlüssel (Abschnitt 4) in der
`.env`-Vorbereitung, bevor eine Migration oder ein Containerwechsel läuft (bei
`update` im neuen Operator nach dem Fast-forward, also nach dem Pflichtbackup);
ein ungültiger Schlüssel bricht dort ab (`doctor` meldet `FEHLT`). Zusätzlich
prüfen `deploy` und `update` den Wert, den Compose tatsächlich verwendet (eine
gesetzte Prozessvariable vor der `.env`), vor den TCMS-Images und den
Migrationen der kanzleikonsole (bei `deploy` auch vor dem Backup davor), und
jeder Start von `tcms-db`/`tcms-migrate`/`tcms-api` (auch `tcms setup`) prüft
ihn noch einmal; ohne gültigen Schlüssel bleibt der laufende `tcms-api`
unverändert. Zwei Folgen des Rollouts nennt die CLI als Warnung:

- Die TCMS-Migration `freigabe_code_schluessel` lässt alle bis dahin
  ausgestellten Codes ablaufen. Freigeben ergibt dann „Der Code ist
  abgelaufen“ (ohne Fehlversuch), die Person fordert einen neuen Code an
  (höchstens 5 je Stunde). Rollout zu ruhiger Zeit, Nutzer vorher informieren.
- Die TCMS-Migration `nachricht_abgerufen` (H2) setzt einen CHECK, der eine
  Datenbank ohne Altbestand „verworfen und dennoch zugestellt bzw.
  unzustellbar gemeldet“ voraussetzt. Mit solchem Bestand scheitert
  `tcms-migrate` fail closed (die Migration läuft in einer Transaktion und
  wird zurückgerollt); `tcms-api` bleibt auf dem bisherigen Stand und das
  Update bricht ab. Die Daten nicht von Hand ändern, sondern die betroffenen
  Zeilen nur lesend zählen und an die TCMS-Betreuung geben:
  `docker exec taxtronik-tcms-db psql -X -U tcms -d tcms -tAc 'SELECT count(*) FROM "Nachricht" WHERE "verworfenAm" IS NOT NULL AND ("zugestelltAm" IS NOT NULL OR "unzustellbarAm" IS NOT NULL)'`.

**rollback.** Das Ziel muss das verwaltete Tax-CMS kennen (sonst Abbruch vor
jeder Wirkung mit dem Hinweis auf `tcms disable`). Im Release-Kanal gelten die
Pins des signiert verifizierten Ziel-Commits; beide Images werden vor dem
Checkout-Wechsel per Digest gezogen und geprüft. `tcms-api` wechselt vor app
und worker auf die Ziel-Images, ohne Migrationsschritt (ein Rollback migriert
nie). Scheitert die Aktivierung, kehrt `tcms-api` mit app und worker auf den
Last-Good-Stand zurück. Weil auch die TCMS-Datenbank vorwärts migriert,
müssen TCMS-Migrationen wie die der kanzleikonsole Expand/Contract folgen
(ältere `tcms-api` läuft auf dem neueren Schema). Ein Rollback auf ein
TCMS-Image vor s8 kennt den Code-Schlüssel nicht: Es erkennt die HMAC-Codes
des neueren Images nicht, eine Eingabe solcher Codes zählt dort als
Fehlversuch. Nur im Notfall und mit Hinweis an die Nutzer; der Schlüssel bleibt
in der `.env` (ältere Images ignorieren die Variable).

**Wie TCMS-Images in die Registry kommen.** Das TCMS-Repository baut
`tcms-api` und `tcms-migrate` in seinem eigenen Release-Workflow (gepinnte
Basis, Trivy-Gate, OCI-Labels `org.opencontainers.image.version`
= TCMS-Version und `org.opencontainers.image.revision` = TCMS-Commit) und
schiebt sie write-once nach `${REGISTRY}/${OWNER}/tcms-api:<version>` bzw.
`…/tcms-migrate:<version>` derselben Registry wie Web und Worker. Die
gemeldeten Digests übernimmt ein kanzleikonsole-Commit in
`infra/compose/tcms-release.env`. Der Release-Workflow der kanzleikonsole
prüft vor jedem Build, dass beide Digests in der Registry existieren und das
Versionslabel tragen (`scripts/release/verify-tcms-pins.sh`); ohne Pins läuft
der Release ohne Tax-CMS. `build-images.yml` enthält bewusst keine
TCMS-Platzhalter, weil die Quellen nur im TCMS-Repository liegen.

## 4. Einrichtung und Prüfung

```bash
./taxtronik tcms setup                    # interaktiv: managed | external | disabled
./taxtronik tcms setup managed            # nicht-interaktiv
./taxtronik tcms setup external           # fragt URL und Dienst-Token (verdeckt)
./taxtronik tcms status                   # Modus, Container, Netze, kids, Code-Schlüssel – ohne Werte
./taxtronik doctor                        # enthält die TCMS-Prüfungen
```

**managed.** `setup` erzeugt fehlende Geheimnisse und lässt vorhandene
unverändert: drei getrennte Datenbankpasswörter, ein Dienst-Token
(`TCMS_SERVICE_TOKEN`, Liste `TCMS_SERVICE_TOKENS` mit genau diesem Eintrag),
den Code-Schlüssel `TCMS_CODE_SCHLUESSEL` und ein Ed25519-Schlüsselpaar mit
neuem `kid` (`kk-<Datum>-<Fingerabdruck>`, wie `pnpm akteur:schluessel` im
TCMS-Repo).

Der **Code-Schlüssel** (TCMS s8, Hinweis H5) entsteht genau einmal: 32
Zufallsbyte als base64url ohne Padding (43 Zeichen, `openssl rand` in eine
Pipe). Der Dienst verwendet den Eintrag als Zeichenkette, nicht dekodiert.
`setup`, `deploy` und `update` erzeugen ihn nur, wenn er fehlt, und ersetzen
einen vorhandenen nie, denn ein neuer Schlüssel ließe alle offenen Codes
ablaufen. Bricht `setup` ab, findet der nächste Lauf den bereits geschriebenen
Schlüssel und erzeugt keinen zweiten. Ein vorhandener Wert muss das Format des
Dienstes erfüllen (Komma-Liste ohne Leerzeichen, je Eintrag 32–512 Zeichen aus
`A-Z a-z 0-9 - . _ ~ + /`, `=` nur am Ende, mindestens 8 verschiedene Zeichen,
kein Platzhalter, keine Doppelten) und darf keinem Dienst-Token oder
TCMS-Passwort gleichen; sonst bricht `setup` bzw. `deploy`/`update` ab, ohne
die `.env` zu ändern und ohne den Wert zu nennen. Ausgegeben wird nur die
Kennung `csk:<16 Hex-Zeichen>` (Anfang des SHA-256; nicht die
`codeSchluesselId` des Dienstes). Der private Schlüssel ist
PKCS#8-DER als base64 (`TCMS_ACTOR_PRIVATE_KEY`), der öffentliche SPKI-DER als
base64 in `TCMS_ACTOR_PUBLIC_KEYS` (`kid=…`), exakt die Formate von
`parsePrivatenSchluessel`/`parseSchluesselListe`. Erzeugt wird mit
`openssl genpkey -algorithm ed25519`; kein Schlüssel und kein Passwort steht
dabei in einer Kommandozeile oder Datei außer der `.env` (`0600`). Auf einer
installierten Instanz startet `setup` danach `tcms-db`, den Migrationsschritt
(Exit-Code wird ausgewertet) und `tcms-api` und erzeugt app und worker neu;
sonst übernimmt `./taxtronik deploy` den Start (`--no-start` erzwingt das).
Im Release-Kanal setzt `setup` die Image-Werte aus den Pins des installierten
Release-Stands.

**external.** `setup` verlangt eine HTTPS-URL ohne Zugangsdaten und ein
Dienst-Token (32–512 Zeichen, kein Platzhalter), erzeugt bei Bedarf das eigene
Schlüsselpaar und gibt nur den öffentlichen Eintrag `kid=<SPKI>` aus, den die
Betreiber des externen Tax-CMS an ihre `TCMS_ACTOR_PUBLIC_KEYS` anhängen.
TaxTronik startet und aktualisiert dort nichts. Der Wechsel von `managed` zu
`external` geht nur über `disable`; beim Wechsel von `external` zu `managed`
erzeugt `setup` ein neues Dienst-Token, statt das des externen Betreibers
weiterzuverwenden.

**Initialsetup.** `./taxtronik deploy` fragt bei einer neuen Installation
nach dem Tax-CMS (Standard: deaktiviert). Bestehende Installationen ohne Wert
werden bei `deploy`/`update` als `disabled` festgeschrieben und nie gefragt.

**doctor** prüft je Modus, ohne Werte auszugeben:

- alle Modi: gültiger Modus; bei `disabled` keine Zugangswerte mehr in `.env`,
- `managed`: Datenbankpasswörter vorhanden und paarweise sowie von den
  kanzleikonsole-Rollen verschieden, Token-Format, aktuelles Token in der
  Liste, Schlüsselliste gültig, `kid` gelistet und der gelistete öffentliche
  Schlüssel passt zum privaten (openssl), Image-Werte je Kanal; im laufenden
  Betrieb Container (`tcms-db`/`tcms-api` healthy, `tcms-migrate` mit Exit 0),
  beide Netze `internal`, `tcms-db` nur im Backend-Netz, app/worker **nicht**
  im Backend-Netz (sonst `FEHLT`),
- `managed`, Code-Schlüssel: fehlt, Format ungültig oder gleich einem Token
  bzw. Passwort → `FEHLT` (damit brechen auch `deploy`/`update` in der
  `.env`-Vorbereitung ab, bevor ein Dienst gestoppt wird); mehrere Einträge
  ohne Rotationszustand, unterbrochener Start, beschädigter Zustand oder
  fälliger Abschluss (`rotate-code-key --finish`) → `WARN`; laufende Rotation →
  `OK` mit dem frühesten Abschluss. Geprüft werden nur Vorhandensein, Format und
  Anzahl der Einträge, nie ein Wert. `tcms status` nennt zusätzlich die
  Kennungen (`csk:…`), welcher Eintrag signiert, und den Rotationsstand.
- `external`: HTTPS-URL, Token- und Schlüsselformat sowie `GET /v1/health` mit
  Token. Das Token geht nur über stdin an `curl --config -`, nie als Argument.

## 5. Rotation mit Überlappung

```bash
./taxtronik tcms rotate-token
./taxtronik tcms rotate-key
```

Beide Befehle folgen der Schnittstelle und laufen ohne Ausfall:

1. neues Token bzw. Schlüsselpaar (neuer `kid`) erzeugen und an die Liste des
   Dienstes anhängen → `tcms-api` neu starten (akzeptiert alt und neu),
2. `TCMS_SERVICE_TOKEN` bzw. `TCMS_ACTOR_PRIVATE_KEY`/`TCMS_ACTOR_KEY_ID`
   umstellen → app und worker neu starten,
3. warten (Schlüssel: mindestens 300 s nach dem Neustart von app/worker, weil
   Bestätigungen bis zu 120 s leben; Token: keine Wartezeit, alte Prozesse
   existieren nicht mehr),
4. alten Eintrag entfernen → `tcms-api` neu starten.

Der Ablauf ist wiederaufnehmbar: `.taxtronik.tcms-rotation` (`0600`, ohne
Geheimnisse) hält Art, Phase, `kid` bzw. Token-Kennung (`tok:` + 16 Hex-Zeichen
SHA-256) und den Umstellungszeitpunkt. Neue Geheimnisse liegen bis zur
Umstellung als `*_NEXT` in der `.env`. Bricht ein Schritt ab (Neustart
scheitert, Strg-C während der Wartezeit), setzt derselbe Befehl an der
richtigen Stelle fort, ohne neue Geheimnisse zu erzeugen und ohne die
Wartezeit zu verkürzen. Eine zweite Rotation startet erst nach Abschluss der
laufenden. Vor dem Start muss jede Liste genau den aktuellen Eintrag enthalten.
Datenbankpasswörter und das externe Tax-CMS: siehe
[Secret-Rotation](secret-rotation.md#tax-cms-tcms).

### Code-Schlüssel (7 Tage Überlappung)

```bash
./taxtronik tcms rotate-code-key            # Start (auch --start)
./taxtronik tcms rotate-code-key --finish   # frühestens 7 Tage später
```

Der Dienst signiert neue Bestätigungscodes mit dem ersten Eintrag von
`TCMS_CODE_SCHLUESSEL` und prüft mit allen. Ein Code gilt 7 Tage; so lange
muss der alte Schlüssel in der Liste bleiben, sonst laufen offene Codes ab.

1. **Start:** neuen Schlüssel erzeugen (32 Byte base64url, verschieden vom
   alten und von allen Tokens und Passwörtern), `TCMS_CODE_SCHLUESSEL=NEU,ALT`
   setzen, `tcms-api` neu starten. Ab dem erfolgreichen Neustart läuft die
   Frist; die CLI nennt den frühesten Abschluss (UTC). Eine Erinnerung für
   diesen Zeitpunkt setzen.
2. **Abschluss** (`--finish`) frühestens 7 Tage nach diesem Neustart: `ALT`
   entfernen, `tcms-api` neu starten. Vorher bricht der Befehl mit dem
   frühesten Zeitpunkt und der Restzeit ab und ändert nichts.

Vorzeitig nur bewusst:
`./taxtronik tcms rotate-code-key --finish --force --confirm-expiry OFFENE_CODES_LAUFEN_AB`.
Die CLI warnt dann: Offene Codes, die mit dem alten Schlüssel ausgestellt
wurden, laufen ab; betroffene Personen fordern einen neuen Code an (höchstens 5
je Stunde). `--force` ohne genau dieses Wort oder ohne `--finish` bricht vor
jeder Wirkung ab.

Der Zustand liegt in `.taxtronik.tcms-code-key-rotation` (`0600`): Phase
(`prepared` bis zum erfolgreichen Neustart, dann `published`), Kennungen von
alt und neu (`csk:` + 16 Hex-Zeichen SHA-256) und die Zeitpunkte von Start und
Neustart, nie ein Schlüssel. Scheitert der Neustart, setzt derselbe Befehl fort,
ohne einen zweiten Schlüssel zu erzeugen; bricht der Start ab, bevor der neue
Schlüssel in der `.env` steht, beginnt der nächste Lauf neu. Die Datei ist von
`rotate-token`/`rotate-key` unabhängig: Token und Akteursschlüssel lassen sich
während der 7 Tage rotieren. Fehlt die Datei bei zwei Einträgen (etwa nach einer
Wiederherstellung ohne sie), ist der Startzeitpunkt unbekannt: `--finish` geht
dann nur mit `--force` und dem Bestätigungswort und behält den ersten Eintrag.

## 6. Abschalten

`./taxtronik tcms disable` setzt `TCMS_DEPLOYMENT=disabled`, leert Token,
Schlüssel (auch den Code-Schlüssel) und URL, erzeugt app und worker ohne TCMS neu und entfernt danach
die TCMS-Container und -Netze. Das Volume `tcms-db-data` und die
`TCMS_DB_*`-Passwörter bleiben erhalten (Daten, Rollen, Superuser-Passwort des
Volumes); gelöscht wird nur bewusst von Hand.

## 7. Backup und Restore

Im verwalteten Modus sichert die CLI die TCMS-Datenbank wie die
Hauptdatenbank: `pg_dump --format=custom` im Container `tcms-db` (lokaler
Socket, kein Passwort), Datei `tcms-db-<Zeit>.dump` mit Modus `0600` und
`.sha256` daneben unter `backups/`, danach Upload beider Dateien in den
Bucket `backups` (`tcmsdump/JJJJ/MM/TT/`, 90-Tage-Lifecycle; S3-Zugang nur per
Namen an den Container). Ohne `.sha256` wird nichts hochgeladen, und ein
Restore verlangt sie: Aus dem Bucket immer Dump und `.sha256` zusammen holen. Gesichert wird bei `./taxtronik backup`, im Update-Pflichtbackup
vor jeder Code-Änderung, vor jedem TCMS-Migrationsschritt mit vorhandenem
Schema und mit `./taxtronik tcms backup` (für einen Host-Cron, denn der
tägliche Worker-Job erreicht die TCMS-Datenbank absichtlich nicht).
`backup-full` stoppt `tcms-api` zusammen mit App, Worker und n8n und legt den
Dump in das verschlüsselte Archiv. Ohne verwaltetes Tax-CMS ändert sich an den
Backups nichts.

Wiederherstellung: `./taxtronik tcms restore --file <dump> --confirm-overwrite
RESTORE_TCMS_DATABASE` mit festem Ablauf (Rollen und Passwörter aus `.env`,
dann Daten, dann Migrationsschritt); Details im
[Disaster-Recovery-Runbook](disaster-recovery.md#schritt-37-tax-cms-datenbank-verwaltet).

**Geheimnisse und Code-Schlüssel.** Alle TCMS-Geheimnisse (Datenbankpasswörter,
Tokens, privater Akteursschlüssel, `TCMS_CODE_SCHLUESSEL`) stehen nur in der
`.env` (`0600`). Die TCMS-Dumps (`backup`, Update-Pflichtbackup,
`tcms backup`, vor einer Migration) enthalten keines davon; vom Code-Schlüssel
liegen in der Datenbank nur der HMAC der offenen Codes und die abgeleitete
Kennung `codeSchluesselId`. `backup-full` legt die `.env` und, solange eine
Code-Schlüssel-Rotation läuft, `.taxtronik.tcms-code-key-rotation` in das
age-verschlüsselte Archiv. Darüber hinaus gehört die `.env` wie jede
Konfiguration in den Tresor außerhalb von TaxTronik
([Disaster-Recovery](disaster-recovery.md)).

**Verlust des Code-Schlüssels** kostet keine Daten: Codes, deren Schlüssel
nicht mehr in der Liste steht, gelten als abgelaufen. Freigeben ergibt „Der
Code ist abgelaufen“ ohne Fehlversuch, der nächste Abruf verwirft die offenen
Code-Mitteilungen (`CODE_ABGELAUFEN`), und die Person fordert einen neuen Code
an (höchstens 5 je Stunde). Vorgehen: `TCMS_CODE_SCHLUESSEL` in der `.env`
leeren und `./taxtronik tcms setup managed` ausführen (neuer Schlüssel,
Neustart von `tcms-api`; die CLI warnt, dass offene Codes ablaufen). Dasselbe gilt, wenn ein Dump eingespielt wird, dessen
Codes mit einem inzwischen entfernten Schlüssel ausgestellt wurden. Bei
Verdacht auf Offenlegung sofort rotieren und vorzeitig abschließen
(`rotate-code-key`, dann `--finish --force --confirm-expiry
OFFENE_CODES_LAUFEN_AB`): Mit Schlüssel und Datenbank zusammen ließen sich die
10⁶ möglichen Codes offline durchprobieren; das Ablaufen offener Codes ist dann
gewollt.

## 8. Variablen

| Variable                                                                           | Inhalt                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `TCMS_DB_SUPERUSER_PASSWORD`, `TCMS_DB_OWNER_PASSWORD`, `TCMS_DB_APP_PASSWORD`     | Passwörter von `tcms`, `tcms_owner`, `tcms_app`; nur `managed`                       |
| `TCMS_SERVICE_TOKENS`                                                              | Token-Liste des Dienstes (Komma-Liste; zwei Einträge nur während der Rotation)       |
| `TCMS_ACTOR_PUBLIC_KEYS`                                                           | `kid=<SPKI-base64>`, kommagetrennt (zwei Einträge nur während der Rotation)          |
| `TCMS_CODE_SCHLUESSEL`                                                             | Code-Schlüssel (HMAC der Bestätigungscodes); `NEU,ALT` nur während `rotate-code-key` |
| `TCMS_SERVICE_TOKEN_NEXT`, `TCMS_ACTOR_PRIVATE_KEY_NEXT`, `TCMS_ACTOR_KEY_ID_NEXT` | nur während einer Rotation bis zur Umstellung; danach leer                           |
| `TCMS_VERSION`, `TCMS_API_DIGEST_SUFFIX`, `TCMS_MIGRATE_DIGEST_SUFFIX`             | Image-Tag und `@sha256:…`-Suffixe; im Release-Kanal aus dem signierten Stand         |
| `TCMS_API_MEM_LIMIT`, `TCMS_DB_MEM_LIMIT`, `TCMS_MIGRATE_MEM_LIMIT`                | Speichergrenzen (Standard 512m, 1g, 256m)                                            |
| `TCMS_DB_SHARED_BUFFERS`, `TCMS_DB_MAX_CONNECTIONS`, `TCMS_LOG_LEVEL`              | Datenbank-Tuning und Log-Stufe des Dienstes                                          |

## 9. Fehlerbilder

| Meldung                                                                                                  | Ursache und Abhilfe                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TCMS_… fehlt - ./taxtronik tcms setup` (bei jedem Compose-Aufruf)                                       | `managed` ohne vollständige Konfiguration: `./taxtronik tcms setup` ausführen oder `./taxtronik tcms disable`.                                                                                                                                                                                     |
| `TCMS_DEPLOYMENT muss managed, external oder disabled sein`                                              | Tippfehler in `.env`; Wert korrigieren.                                                                                                                                                                                                                                                            |
| `TCMS_CODE_SCHLUESSEL: … Der vorhandene Wert wird nicht ersetzt`                                         | Code-Schlüssel ungültig oder gleich einem Token/Passwort. Von Hand korrigieren oder bewusst leeren und `./taxtronik tcms setup managed` ausführen (neuer Schlüssel: offene Codes laufen ab, Abschnitt 4).                                                                                          |
| `tcms-migrate fehlgeschlagen` beim ersten Rollout von TCMS s8                                            | Meist der CHECK der Migration `nachricht_abgerufen` bei Altbestand (Abschnitt 3, erster Rollout). `tcms-api` läuft auf dem bisherigen Stand weiter; Zeilen nur lesend zählen und an die TCMS-Betreuung geben.                                                                                      |
| `Registry-Compose verweigert: … verankert kein TCMS-Release`                                             | Der installierte Release gibt keine TCMS-Images frei. Auf einen Release mit TCMS aktualisieren oder `tcms disable`.                                                                                                                                                                                |
| `Registry-Compose verweigert: TCMS-Images … weichen … ab`                                                | `.env` oder Prozessumgebung nennt andere Digests als der signierte Stand. Nicht von Hand ändern; deploy/update/rollback nutzen.                                                                                                                                                                    |
| `TCMS-Compose-Datei fehlt im Checkout`                                                                   | `managed` in einem Checkout ohne TCMS-Unterstützung (älterer Release): vorher `./taxtronik tcms disable`.                                                                                                                                                                                          |
| `Eine Rotation (…) ist nicht abgeschlossen`                                                              | Denselben `rotate-…`-Befehl erneut ausführen; er setzt an der gespeicherten Phase fort.                                                                                                                                                                                                            |
| `Code-Schluessel-Rotation: Abschluss fruehestens …`                                                      | Die 7 Tage seit dem Neustart mit `NEU,ALT` sind nicht um. Zum genannten Zeitpunkt `rotate-code-key --finish` wiederholen; nur bewusst vorzeitig mit `--force --confirm-expiry OFFENE_CODES_LAUFEN_AB` (offene Codes laufen ab).                                                                    |
| `Code-Schluessel-Rotation laeuft seit …`                                                                 | Ein Start ist schon veröffentlicht; erst `--finish`, dann neu starten.                                                                                                                                                                                                                             |
| `… muss vor einer Rotation genau das aktuelle … enthalten`                                               | Liste enthält Fremdeinträge; mit `tcms status` prüfen und die Liste auf den aktuellen Eintrag zurückführen.                                                                                                                                                                                        |
| doctor: `haengt im TCMS-Backend-Netz`                                                                    | App/Worker wurden außerhalb der CLI mit falschem Netz gestartet; `./taxtronik tcms setup managed` erzeugt sie neu.                                                                                                                                                                                 |
| doctor: `TCMS_HEALTH … nicht erreichbar` (external)                                                      | URL, TLS-Kette oder Token prüfen; das externe Tax-CMS muss das Token in seiner Liste führen.                                                                                                                                                                                                       |
| `TCMS-Backup vor der Migration fehlgeschlagen; tcms-migrate laeuft nicht`                                | Backup-Verzeichnis/S3 prüfen (`./taxtronik tcms backup`); ohne Backup wird nicht migriert.                                                                                                                                                                                                         |
| `SHA-256 des Dumps stimmt nicht …` (restore)                                                             | Dump beschädigt oder falsche Prüfsummendatei; anderen Dump wählen.                                                                                                                                                                                                                                 |
| `pg_restore fehlgeschlagen; tcms-api bleibt gestoppt`                                                    | Der bisherige Stand liegt unter `backups/tcms-pre-restore/`; mit diesem Dump erneut `tcms restore` ausführen.                                                                                                                                                                                      |
| Worker-Log `tcms-nachrichten: Abruf gescheitert` (`fehler`, `status`, `grund`)                           | Dienst nicht erreichbar, Token/Schlüssel falsch (401) oder Antwort außerhalb des Vertrags. Der nächste Lauf (1 min) versucht es erneut; `tcmsRequestId` im Log des Dienstes nachsehen.                                                                                                             |
| Worker-Log `Zustellung nicht gemeldet, nächster Lauf`                                                    | Die Mitteilung ist eingeplant, die Bestätigung kam nicht an. Kein Handlungsbedarf: Der nächste Lauf meldet, ohne erneut zuzustellen.                                                                                                                                                               |
| Worker-Log `Mitteilung nicht zugestellt` (`grund`) und Hinweis „Mitteilung des Tax-CMS nicht zugestellt“ | Empfänger in TaxTronik nicht bestätigt (z. B. `KONTAKT_UNBESTAETIGT`: Kontakt hat sich nie im Portal angemeldet). Kontaktdaten korrigieren; nach 7 Tagen wird die Mitteilung als unzustellbar abgeschlossen und dem Tax-CMS so gemeldet (die Kanzlei sieht es an der Freigabe und adressiert neu). |
| Worker-Log `Mitteilung im Tax-CMS bereits abgeschlossen` (`meldung`, `status` 409)                       | Das Tax-CMS kannte die Mitteilung schon als zugestellt bzw. unzustellbar (z. B. Meldung eines früheren Laufs). Gilt als erledigt; kein Handlungsbedarf. Häufen sich die Einträge, `tcmsRequestId` im Log des Dienstes prüfen.                                                                      |
| Worker-Log `voller Abruf ohne Einplanung`                                                                | 50 zurückgestellte Mitteilungen belegen den Postausgang (älteste zuerst); neue kommen erst nach Korrektur oder nach 7 Tagen dran. Empfänger der Hinweise korrigieren.                                                                                                                              |
| Worker-Log `Lease verloren, Lauf beendet`                                                                | Ein Lauf dauerte länger als der Lease (2 min, je Mitteilung verlängert) – meist ein sehr langsamer Dienst. Der nächste Lauf setzt fort; Doppelte schließt die Zustellzeile aus.                                                                                                                    |

## 10. Zustellung der Mitteilungen (Stufe 4)

Der Worker-Job `tcms-nachrichten-zustellen` holt jede Minute den Postausgang
des Tax-CMS ab (Freigabe angefordert, Bestätigungscode, Neuadressierung,
gemeldetes Ereignis), prüft die Empfänger gegen TaxTronik und plant Mails über
die Mail-Outbox bzw. In-App-Hinweise ein; danach bestätigt er die Zustellung
beim Dienst bzw. meldet eine nicht zustellbare Mitteilung mit festem Grund als
unzustellbar. Technik: [Anbindung, Abschnitt 8](../development/tcms-anbindung.md#8-zustellung-des-postausgangs-stufe-4).

- **Voraussetzungen:** Modul „Tax-CMS“ des Tenants an, `TCMS_DEPLOYMENT`
  `managed` oder `external`, Worker mit derselben `TCMS_*`-Konfiguration wie
  die App, `PORTAL_PUBLIC_URL` (oder `NEXTAUTH_URL`) für den Link ins Portal
  und funktionierender Mailversand der Kanzlei. Der Worker meldet sich als
  Systemakteur „Zustellung kanzleikonsole“ (Audit des Tax-CMS: „System: …“);
  seine ID je Tenant entsteht beim ersten Lauf in `tcms_systemakteur` und
  ändert sich nie.
- **Ein Lauf je Tenant:** Lease in `tcms_systemakteur` (2 Minuten, vor jeder
  Mitteilung verlängert). Mehrere Worker-Instanzen sind zulässig.
- **Zustand:** `tcms_nachricht_zustellung` (nur Owner): je Mitteilung Status
  `EINGEPLANT`, `ZURUECKGESTELLT` oder `UNZUSTELLBAR`, fester Grund, Zeitpunkte;
  keine Inhalte. Gemeldete Zeilen werden nach 30 Tagen gelöscht. Wird die
  Datenbank des Tax-CMS auf einen Stand vor einer Meldung zurückgesetzt, liefert
  sie gemeldete Mitteilungen erneut; innerhalb der 30 Tage verhindert die
  Zustellzeile eine zweite Zustellung, danach nicht.
- **Code:** liegt in TaxTronik nur Secret-Box-verschlüsselt im
  Versandauftrag und nur bis zum Endstatus (auch bei Fehlschlag); kein
  „Erneut senden“. Ein Neuversand entsteht im Tax-CMS (neuer Code bzw.
  Neuadressierung).
- **Prüfen:** Worker-Log `tcms-nachrichten-zustellen: done` mit Zählern
  (`abgerufen`, `eingeplant`, `zurueckgestellt`, `unzustellbar`, `gemeldet`,
  `fehler`); Zustellstatus der Mails in der Mail-Outbox (Anlass
  „Tax-CMS: …“).
