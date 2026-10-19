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
`tcms-api` die Token-Liste, die öffentlichen Schlüssel und die URL der Rolle
`tcms_app`; app und worker genau ein Dienst-Token und den eigenen privaten
Schlüssel. `scripts/tests/tcms-compose.test.mjs` prüft Netze, Härtung und
Umgebung am tatsächlichen Compose-Modell.

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
ohne Digest-Suffix.

## 4. Variablen

| Variable                                                                       | Inhalt                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `TCMS_DB_SUPERUSER_PASSWORD`, `TCMS_DB_OWNER_PASSWORD`, `TCMS_DB_APP_PASSWORD` | Passwörter von `tcms`, `tcms_owner`, `tcms_app`; nur `managed`                 |
| `TCMS_SERVICE_TOKENS`                                                          | Token-Liste des Dienstes (Komma-Liste; zwei Einträge nur während der Rotation) |
| `TCMS_ACTOR_PUBLIC_KEYS`                                                       | `kid=<SPKI-base64>`, kommagetrennt (zwei Einträge nur während der Rotation)    |
| `TCMS_VERSION`, `TCMS_API_DIGEST_SUFFIX`, `TCMS_MIGRATE_DIGEST_SUFFIX`         | Image-Tag und `@sha256:…`-Suffixe; im Release-Kanal aus dem signierten Stand   |
| `TCMS_API_MEM_LIMIT`, `TCMS_DB_MEM_LIMIT`, `TCMS_MIGRATE_MEM_LIMIT`            | Speichergrenzen (Standard 512m, 1g, 256m)                                      |
| `TCMS_DB_SHARED_BUFFERS`, `TCMS_DB_MAX_CONNECTIONS`, `TCMS_LOG_LEVEL`          | Datenbank-Tuning und Log-Stufe des Dienstes                                    |

## 5. Fehlerbilder

| Meldung                                                            | Ursache und Abhilfe                                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `TCMS_… fehlt - ./taxtronik tcms setup` (bei jedem Compose-Aufruf) | `managed` ohne vollständige Konfiguration: `./taxtronik tcms setup` ausführen oder `./taxtronik tcms disable`.                  |
| `TCMS_DEPLOYMENT muss managed, external oder disabled sein`        | Tippfehler in `.env`; Wert korrigieren.                                                                                         |
| `Registry-Compose verweigert: … verankert kein TCMS-Release`       | Der installierte Release gibt keine TCMS-Images frei. Auf einen Release mit TCMS aktualisieren oder `tcms disable`.             |
| `Registry-Compose verweigert: TCMS-Images … weichen … ab`          | `.env` oder Prozessumgebung nennt andere Digests als der signierte Stand. Nicht von Hand ändern; deploy/update/rollback nutzen. |
| `TCMS-Compose-Datei fehlt im Checkout`                             | `managed` in einem Checkout ohne TCMS-Unterstützung (älterer Release): vorher `./taxtronik tcms disable`.                       |
