# Anbindung des Tax-CMS (TCMS)

- **Dokumentstatus:** Ist-Dokumentation (TCMS Stufe 2, kanzleikonsole-Seite)
- **Bezug:** ADR 0001 des TCMS-Repos („Tax-CMS als headless Dienst der
  kanzleikonsole“)

Das Tax-CMS ist ein interner, headless Dienst. Die kanzleikonsole besitzt
Anmeldung, Oberfläche, Personen und Mandanten; sie ruft das TCMS je Anfrage mit
einem Dienst-Token und einer Ed25519-signierten Akteursbestätigung auf. Diese
Seite beschreibt den Teil in der kanzleikonsole, der nicht vom Betrieb abhängt.
Compose, Backup und Betrieb folgen gesondert, die Oberflächen in Stufe 3; bis
dahin ruft keine Seite das TCMS auf.

## 1. Vertrag (vendored)

`packages/tcms-contract` (`@taxtronik/tcms-contract`) ist eine byte-genaue
Kopie von `packages/contract/src` des TCMS-Repos ohne Tests: zod-Schemas des
HTTP-Vertrags, Fehlercodes, strenges JSON und Signieren/Prüfen der
Akteursbestätigung (nur `node:crypto`). `VENDOR.json` hält Quell-Repo,
Quell-Commit und je Datei den SHA-256 fest.

- **Nie von Hand ändern.** Änderungen am Vertrag entstehen im TCMS-Repo.
- **Prüfung:** `pnpm guard:tcms-contract` (Teil von `pnpm lint`) prüft, dass
  `src/` exakt `VENDOR.json` entspricht: keine lokale Änderung, keine fehlende,
  keine zusätzliche Datei (auch keine Dotfiles), keine Symlinks. ESLint lässt
  die Kopie aus (`eslint.config.mjs`), weil Korrekturen die Kopie verfälschen
  würden; geprüft wird sie im TCMS-Repo.
- **Aktualisieren:**

  ```bash
  # sauberer TCMS-Checkout auf dem gewünschten Stand (nur lesen)
  git -C /pfad/zu/tcms status --short          # muss leer sein
  node scripts/tcms/sync-contract.mjs --from /pfad/zu/tcms
  pnpm guard:tcms-contract
  ```

  Das Skript verweigert bei geänderten, gestagten oder unversionierten Dateien
  im Quellbaum, kopiert nur versionierte Dateien außer `__tests__/` und
  `*.test.*`, entfernt alles andere unter `packages/tcms-contract/src` und
  schreibt `VENDOR.json` mit `git rev-parse HEAD`. Danach Typprüfung und Tests
  der Nutzer des Vertrags und den Vertragstest (Abschnitt 6) gegen denselben
  TCMS-Stand laufen lassen. Die Aktualisierung ist ein eigener Commit mit dem
  Quell-Commit im Text.

- **Gegen die Quelle nachprüfen:** Der Guard sichert die Kopie gegen
  `VENDOR.json`, nicht `VENDOR.json` gegen das TCMS-Repo. Wer beides ändert,
  fällt erst in der Prüfung gegen die Quelle auf: TCMS-Checkout auf
  `quelle.commit` setzen und das Sync-Skript ausführen; danach muss
  `git status packages/tcms-contract` leer sein. Das gehört zum Review jeder
  Änderung unter `packages/tcms-contract`.

## 2. Konfiguration

Teil `tcms` des ENV-Schemas (`packages/config/src/env-schema.ts`), in den
Profilen `web` und `worker`. Pakete lesen ihn zur Aufrufzeit mit
`getTcmsConfig()` (`null` bei `disabled`); das Boot-Gate prüft dieselben
Regeln.

| Variable                 | Regel                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TCMS_DEPLOYMENT`        | `managed`, `external` oder `disabled` (Standard, auch leer). Bei `managed`/`external` sind die vier folgenden Werte Pflicht.                                                                                                        |
| `TCMS_URL`               | nur `http(s)://host[:port]` – kein Pfad (der Client signiert `/v1/…` exakt wie gesendet), keine Query, kein Fragment, keine Zugangsdaten. In Produktion `https://`; `http://` nur bei `managed` zum Compose-Dienst `tcms-api:3200`. |
| `TCMS_SERVICE_TOKEN`     | Regeln des Dienstes: 32–512 Zeichen, b64token-Zeichensatz, kein Platzhalter, mindestens 8 verschiedene Zeichen.                                                                                                                     |
| `TCMS_ACTOR_PRIVATE_KEY` | privater Ed25519-Schlüssel, PKCS#8-DER als kanonisches base64 (`pnpm akteur:schluessel` im TCMS-Repo).                                                                                                                              |
| `TCMS_ACTOR_KEY_ID`      | kid im Format der Schlüsselliste des Dienstes: 1–64 Zeichen `A-Z a-z 0-9 . _ -`.                                                                                                                                                    |

Fehlermeldungen nennen Variable und Grund, nie den Wert. `getTcmsConfig()`
liefert den privaten Schlüssel bereits als `KeyObject`; das Dienst-Token ist
im Konfigurationsobjekt nicht aufzählbar und erscheint weder in
`JSON.stringify` noch in `console.log`. Die Konstanten `TCMS_COMPOSE_DIENST`
und `TCMS_COMPOSE_PORT` halten Dienstname und Port für den Compose-Betrieb
fest.

**Rotation.** Der Dienst akzeptiert mehrere Dienst-Tokens
(`TCMS_SERVICE_TOKENS`) und öffentliche Schlüssel (`TCMS_ACTOR_PUBLIC_KEYS`)
gleichzeitig. Neues Token bzw. neuen Schlüssel zuerst beim Dienst ergänzen,
dann `TCMS_SERVICE_TOKEN` bzw. `TCMS_ACTOR_PRIVATE_KEY` und `TCMS_ACTOR_KEY_ID`
der kanzleikonsole umstellen und neu starten, zuletzt den alten Eintrag beim
Dienst entfernen. Bestätigungen leben höchstens 60 Sekunden; nach dem Neustart
genügt diese Wartezeit vor dem Entfernen.

## 3. Client (`@taxtronik/tcms-client`)

Reiner Transport ohne Geschäftslogik, ohne DB-Zugriff und ohne Logs.

```ts
const client = new TcmsClient({ config: getTcmsConfig()! }); // einmal je Prozess
const { daten, requestId } = await client.aufruf({
  methode: 'GET',
  pfad: '/v1/mandanten/:mandantId/kontext',
  params: { mandantId },
  query: { stand: '2026-10-16' },
  querySchema: KontextQuerySchema, // optional, lokal geprüft
  antwortSchema: KontextAntwortSchema,
  akteur, // aus apps/web/src/server/tcms (Abschnitt 4)
});
await client.health(); // GET /v1/health, nur Dienst-Token
```

Ein künftiges Endpunktregister im Vertrag (`{ methode, pfad, querySchema,
bodySchema, antwortSchema }`, Typ `TcmsEndpunkt`) speist `aufruf` direkt.

- **Bindung.** Target und Body entstehen je Aufruf genau einmal; der Hash
  läuft über genau die gesendeten Bytes. Pfadparameter werden mit
  `encodeURIComponent` kodiert und müssen danach ein kanonisches Segment sein
  (`A-Z a-z 0-9 _ ~ -`); Query-Werte werden zusätzlich in `!'()*` kodiert, weil
  der URL-Parser von fetch sonst z. B. `'` nachkodiert und das gesendete vom
  signierten Target abwiche. Vor dem Senden prüft der Client
  `pathname + search` der URL gegen das signierte Target. Pfade unter
  `/v1/mandanten/:mandantId/…` verlangen `akteur.cli.id == mandantId`, sonst
  wird nicht gesendet.
- **Bestätigung.** `signiereAkteur` aus dem Vertrag, frisches `jti`, `iat`
  jetzt, Lebensdauer 30 s (höchstens 60 s), neue Bestätigung je Versuch.
- **Antworten.** `redirect: 'error'`, Zeitlimit je Aufruf (Standard 10 s,
  Health 3 s), Größe hart begrenzt (Standard 8 MiB, je Aufruf
  `maxAntwortBytes`; `Content-Length` vorab, sonst gestreamt mit Abbruch), nur
  `application/json`, strenges JSON, Umschlag und Daten mit dem zod-Schema des
  Aufrufs (die Schemas des Vertrags sind `strict`: unbekannte Felder sind ein
  Protokollfehler).
- **Fehler.** `TcmsUngueltig` (400 mit `felder`, oder `lokal: true`, wenn
  nicht gesendet), `TcmsNichtAuthentifiziert` (401), `TcmsNichtBerechtigt`
  (403, `grund`), `TcmsNichtGefunden` (404), `TcmsKonflikt` (409),
  `TcmsNichtVerfuegbar` (Transport, Zeitlimit, 500/502/503/504, offener
  Breaker), `TcmsProtokollFehler` (alles Unerwartete). `message` enthält nur
  Status und Code, nie Antwortkörper; `meldung`/`grund`/`felder` des Dienstes
  stehen als Eigenschaften bereit. Jeder Fehler trägt die `requestId` der
  Antwort: Der Dienst erzeugt sie selbst und übernimmt keine des Aufrufers,
  deshalb reicht der Client die Antwort-ID nach oben weiter.
- **Wiederholung und Breaker.** Nur `GET` bei Transportfehler oder 503, mit
  neuer Bestätigung; nie POST/PUT/PATCH/DELETE, nie 401, nie Zeitlimit. Der
  Circuit-Breaker liegt gemeinsam mit dem Risk-Layer in
  `@taxtronik/http-utils/resilience` und zählt nur Ausfälle, keine fachlichen
  Antworten.
- **401 und Verbindung.** Der Dienst schließt bei jedem 401 die Verbindung,
  bei ungültigem Token auch vor dem Lesen des Bodys; dann kann statt der 401
  ein Transportfehler ankommen. Beides wird nicht wiederholt.
- **Geheimnisse.** Token und Schlüssel (als `KeyObject`) stehen nur in
  privaten Feldern; `JSON.stringify(client)` zeigt Origin und kid.

## 4. Akteursabbildung (`apps/web/src/server/tcms/akteur.ts`)

Sicherheitskritisch: Das TCMS leitet seine Rechte (`kannLesen`,
`kannBearbeiten`, `kannWuerdigen`) aus der Bestätigung ab. Quelle ist nur die
serverseitig geprüfte Sitzung (`staffAuth`/`portalAuth`) und der aktuelle
Datenbestand; einziger Eingabewert ist die Mandanten-ID des Aufrufziels, für
die der Zugriff geprüft wird. Es laufen ausschließlich vorhandene Prüfungen
der kanzleikonsole. Einstiege: `kanzleiAkteur({ mandantId? })`,
`kanzleiMandantenListe()`, `portalAkteur()` (prüfen die Sitzung selbst);
die `…Tx`-Varianten nehmen eine bereits geprüfte Sitzung und eine
Tenant-Transaktion.

| Claim     | Quelle in der kanzleikonsole                                                                                                | Begründung                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knd`     | `KANZLEI` für Staff-Sitzungen, `MANDANT` für Portal-Sitzungen                                                               | Art der Sitzung, nicht wählbar.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tnt`     | `session.user.tenantId`, Person/Kontakt muss in genau diesem Tenant existieren                                              | Tenant-Wechsel oder fremde Personen ergeben keine Bestätigung (Abfrage mit Tenant-Filter und RLS).                                                                                                                                                                                                                                                                                                                                          |
| `sub`     | StaffUser-ID bzw. ClientContact-ID der Sitzung                                                                              | Personen-IDs der kanzleikonsole (ADR §5).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `nam`     | `fullName` frisch aus der DB, getrimmt, höchstens 200 Zeichen                                                               | Anzeigename zum Zeitpunkt der Anfrage (Audit im TCMS); leer → keine Bestätigung.                                                                                                                                                                                                                                                                                                                                                            |
| `rol.adm` | `isStaffAdmin(session)`: Rolle `ADMIN` oder `PARTNER`                                                                       | Die kanzleikonsole behandelt beide identisch als Kanzleileitung (alle Einzelrechte, Zugriff auf alle Mandanten, Schreiben an jedem Mandanten: `hasStaffPermission`, `canAccessClientTx`, `canWriteClientTx`); ADR §3.2 nennt „Admin/Partner“. `kannBearbeiten` im TCMS (`adm` oder `cli.bt` oder `cli.hb`) gewährt damit höchstens, was `canWriteClientTx` gewährt. Nur `ADMIN` wäre strenger als die eigene Regel und sperrte Partner aus. |
| `rol.bt`  | `StaffUser.isProfessional` frisch aus der DB                                                                                | Berufsträgereigenschaft der Person; Voraussetzung jeder §-153-Würdigung im TCMS.                                                                                                                                                                                                                                                                                                                                                            |
| `cli`     | nur wenn `canStaffAccessClientTx` (gemeinsame Policy ACCESS-CLIENT-MODE-001) den Zugriff erlaubt                            | OPEN/RESTRICTED/vertraulich wie überall; frische Rollen, Mandant muss im Tenant existieren (auch für Admins). Ohne Zugriff: keine Bestätigung, kein Aufruf.                                                                                                                                                                                                                                                                                 |
| `cli.bt`  | `canStaffReviewGwgTx`: Zuordnung `BERUFSTRAEGER` und Person aktiv, `isProfessional`, mit Rolle                              | „Zuständige Berufsträgerin“ nach aktuellem Stand; eine Zuordnung ohne (noch gültige) Qualifikation bleibt Zugriff, aber nicht `bt`.                                                                                                                                                                                                                                                                                                         |
| `cli.hb`  | Zuordnung `HAUPTBEARBEITER` (`ClientResponsibility`)                                                                        | Hauptbearbeitung; `VERTRETER`/`FACHLICH` zählen nicht (wie in `canWriteClientTx`).                                                                                                                                                                                                                                                                                                                                                          |
| Liste     | `accessibleClientsWhereFor` (höchstens 5 000), `bt`/`hb` wie oben je Mandant                                                | Für Portfolio/Arbeitskorb im Body, über `req.b` gebunden; mehr Mandanten → keine Bestätigung statt stiller Kürzung. Ein Differenztest hält Liste, `bt`, `hb` deckungsgleich mit den Einzelprüfungen.                                                                                                                                                                                                                                        |
| Portal    | `findPortalProfilesForContactTx`: aktiver Kontakt, Mandant zugelassen, nicht anonymisiert, Mandat aktiv, E-Mail der Sitzung | `cli.id` = Mandant der Portal-Sitzung, `bt`/`hb` immer `false` (Vertrag).                                                                                                                                                                                                                                                                                                                                                                   |

Keine Bestätigung (`TcmsAkteurVerweigert`, UI-Meldung „Kein Zugriff auf das
Tax-CMS.“, Grund nur als Eigenschaft) bei: ungültiger oder abgelaufener
Sitzung, Rollen der Sitzung ≠ aktuelle Rollen (veraltete Sitzung: neu
anmelden), deaktivierter Person, Login-Sperre (`lockedUntil`), fehlendem
Mandantenzugriff, mehr als 5 000 Mandanten, Kontakt ohne Portalzugang.

## 5. Modul, Gate und Health-Check

- **Modul `tcms`** im Modul-Register (`BOOLEAN_MODULE_KEYS`, Standard aus),
  Tenant-Schalter unter _Einstellungen → Module_ („Tax-CMS“). Aktiv ist das
  TCMS für einen Tenant nur mit Schalter an **und**
  `TCMS_DEPLOYMENT != disabled` (`istTcmsAktiv` aus
  `@taxtronik/tcms-client`).
- **Gate für Server-Aktionen:** `assertTcmsAktivTx(tx, tenantId)` bzw.
  `assertTcmsAktiv(ctx)` aus `apps/web/src/server/tcms/dienst.ts`
  (`TcmsInaktivError` mit UI-Meldung); der Modulschalter allein wirkt
  zusätzlich über die `module`-Option der Action-Guards. **Worker:**
  `isWorkerTcmsActive(tenantId)` aus `apps/worker/src/module-gate.ts`
  (Modulschalter über `isWorkerTenantModuleEnabled`, dieselbe Regel
  `istTcmsAktiv`).
- **Client je Prozess:** `tcmsClient()` (`null` bei `disabled`) lädt
  Konfiguration und Schlüssel beim ersten Zugriff einmal.
- **Health-Check:** `checkTcms()` in `apps/web/src/server/health/checks.ts`:
  `GET /v1/health` mit Dienst-Token, Zeitlimit 3 s, ohne Wiederholung und ohne
  Breaker; `null` bei `disabled`. Das Ergebnis enthält nur feste Texte (kein
  Ausnahmetext, keine URL, keine Version). Noch in keine Seite und nicht in
  `/api/health/detail` eingebunden (Betrieb bzw. Stufe 3).

## 6. Vertragstest gegen den echten Dienst

`packages/tcms-client/src/__tests__/vertrag.contract.test.ts` läuft nur mit
`TCMS_CONTRACT_TESTS=1` über `pnpm --filter @taxtronik/tcms-client test:contract`
(eigene Vitest-Konfiguration, nicht im Unit-Lauf und nicht in CI). Er prüft
gegen eine laufende TCMS-API: Health; signierter
`GET /v1/mandanten/:id/kontext` (Demo-Mandant „Talwind“, Demo-Kanzleiperson
„Anna Roth“, UUIDs aus `packages/db/seeds/demo.ts` des TCMS); `POST
/v1/portfolio` mit Mandantenliste im Body; eine Query mit Umlauten und
Sonderzeichen (400 statt 401 belegt die Bindung, weil der Dienst die
Bestätigung vor der Query prüft); Portal-Endpunkt mit Portal-Akteur. Negativ:
falscher Schlüssel, unbekannte kid und falsches Token (401), fremder Mandant
(404), `cli` ≠ Mandant im Pfad (404), Portal-Akteur auf Kanzlei-Endpunkt
(404), Body nach der Signatur verändert (401), Replay derselben Bestätigung
(401 mit `Connection: close`), Größenlimit gegen eine echte Antwort und gegen
einen lokalen Testserver (8 MiB).

Start mit einer eigenen, nur gelesenen TCMS-Kopie (Pfade der
Entwicklungsumgebung; `main` ist im Haupt-Checkout ausgecheckt, deshalb
`--detach`):

```bash
git -C /home/claude/tcms worktree add --detach /home/claude/wt/tcms-kkct main
cd /home/claude/wt/tcms-kkct
pnpm install --frozen-lockfile && pnpm db:generate
bash /home/claude/work/tcms-mkdb.sh tcms_kkct /home/claude/wt/tcms-kkct
# Schlüsselpaar: Ausgabe in eine Datei mit Modus 600, nie ins Terminal-Log.
umask 077 && node scripts/akteur-schluessel.mjs --kid kk-vertrag > ~/kkct-schluessel.txt
# API auf freiem Port (Token zufällig, z. B. openssl rand -base64 48):
TCMS_SERVICE_TOKENS=<token> TCMS_ACTOR_PUBLIC_KEYS=<kid>=<spki> \
  DATABASE_URL=postgresql://tcms_app:<passwort>@127.0.0.1:55432/tcms_kkct \
  HOST=127.0.0.1 PORT=<port> node_modules/.bin/tsx apps/api/src/server.ts
# Vertragstest in der kanzleikonsole:
cd <kanzleikonsole>/packages/tcms-client
TCMS_CONTRACT_TESTS=1 TCMS_URL=http://127.0.0.1:<port> TCMS_SERVICE_TOKEN=<token> \
  TCMS_ACTOR_PRIVATE_KEY=<pkcs8> TCMS_ACTOR_KEY_ID=<kid> pnpm test:contract
```

Die Gründe der Abweisungen stehen nur im Log des Dienstes (`grund`, z. B.
`SIGNATUR`, `KID_UNBEKANNT`, `DIENST_TOKEN`, `REQ_BODY`, `JTI_WIEDERHOLT`) und
lassen sich über die `requestId` zuordnen. Nach einer Aktualisierung des
vendored Vertrags (Abschnitt 1) gegen denselben TCMS-Stand ausführen.
