# Anbindung des Tax-CMS (TCMS)

- **Dokumentstatus:** Ist-Dokumentation (TCMS Stufen 2 bis 4, kanzleikonsole-Seite)
- **Bezug:** ADR 0001 des TCMS-Repos („Tax-CMS als headless Dienst der
  kanzleikonsole“)

Das Tax-CMS ist ein interner, headless Dienst. Die kanzleikonsole besitzt
Anmeldung, Oberfläche, Personen und Mandanten; sie ruft das TCMS je Anfrage mit
einem Dienst-Token und einer Ed25519-signierten Akteursbestätigung auf. Diese
Seite beschreibt den Teil in der kanzleikonsole, der nicht vom Betrieb abhängt;
Compose, Backup und Betrieb stehen in
[TCMS-Betrieb](../operations/tcms-betrieb.md). Seiten und Aktionen rufen das
TCMS ausschließlich über die Helfer aus Abschnitt 7 auf; wie eine Oberfläche
gebaut wird, beschreibt der [Leitfaden](tcms-oberflaechen.md).

## 1. Vendorte Pakete: Vertrag und Domain

Zwei Pakete sind byte-genaue Kopien aus dem TCMS-Repo ohne Tests (Liste
`VENDOR_PAKETE` in `scripts/tcms/vendor-lib.mjs`):

| Paket                                                 | Quelle im TCMS-Repo     | Inhalt                                                                                                                                                                |
| ----------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/tcms-contract` (`@taxtronik/tcms-contract`) | `packages/contract/src` | zod-Schemas des HTTP-Vertrags, Endpunktregister, Fehlercodes, strenges JSON, Signieren/Prüfen der Akteursbestätigung (nur `node:crypto`)                              |
| `packages/tcms-domain` (`@taxtronik/tcms-domain`)     | `packages/domain/src`   | Labels, Formatierung, Katalog, Phasen und Profilregeln für die Oberflächen (zod-frei, ohne Abhängigkeiten); **ohne `audit.ts`**: die Hashkette rechnet nur der Dienst |

Die Oberflächen nehmen Labels und Formatierung aus `@taxtronik/tcms-domain`
statt eigene Texte zu pflegen; Fachentscheidungen trifft weiter allein der
Dienst (ADR 0001). `VENDOR.json` im Paket hält Quell-Repo, Quellpfad,
Quell-Commit und je Datei den SHA-256 fest.

- **Nie von Hand ändern.** Änderungen entstehen im TCMS-Repo.
- **Prüfung:** `pnpm guard:tcms-contract` (Teil von `pnpm lint`) prüft für
  jedes Paket, dass `src/` exakt seinem `VENDOR.json` entspricht: keine lokale
  Änderung, keine fehlende, keine zusätzliche Datei (auch keine Dotfiles und
  keine ausgeschlossene Datei wie `audit.ts`), keine Symlinks; Quellpfad und
  Beschreibung müssen zum Paket passen (ein `VENDOR.json` lässt sich nicht in
  ein anderes Paket kopieren). ESLint lässt die Kopien aus
  (`eslint.config.mjs`), weil Korrekturen sie verfälschen würden; geprüft
  werden sie im TCMS-Repo.
- **Aktualisieren:**

  ```bash
  # sauberer TCMS-Checkout auf dem gewünschten Stand (nur lesen)
  git -C /pfad/zu/tcms status --short          # muss leer sein
  node scripts/tcms/sync-contract.mjs --from /pfad/zu/tcms                  # alle Pakete
  node scripts/tcms/sync-contract.mjs --from /pfad/zu/tcms --paket domain   # nur eines
  pnpm guard:tcms-contract
  ```

  Das Skript verweigert bei geänderten, gestagten oder unversionierten Dateien
  im Quellbaum, kopiert je Paket nur versionierte Dateien außer `__tests__/`,
  `*.test.*` und den Ausschlüssen des Pakets, entfernt alles andere unter
  `<paket>/src` und schreibt `VENDOR.json` mit `git rev-parse HEAD`. Gelesen
  wird nur der Git-Blob des Commits (`git ls-tree`/`git cat-file`), nie der
  Arbeitsbaum; Symlinks, ausführbare Dateien und Submodule brechen ab (Red
  Team RT2-K-01: Ein Symlink-Blob sieht im Review harmlos aus, dereferenziert
  hätte er Fremdinhalt vendored). Alle gewählten Pakete werden gelesen und
  geprüft, bevor das erste geschrieben wird. Danach Typprüfung und Tests der
  Nutzer und den Vertragstest (Abschnitt 6) gegen denselben TCMS-Stand laufen
  lassen. Die Aktualisierung ist ein eigener Commit mit dem Quell-Commit im
  Text.

- **Gegen die Quelle nachprüfen:** Der Guard sichert die Kopie gegen
  `VENDOR.json`, nicht `VENDOR.json` gegen das TCMS-Repo. Wer beides ändert,
  fällt erst in der Prüfung gegen die Quelle auf: TCMS-Checkout auf
  `quelle.commit` setzen und das Sync-Skript für das Paket ausführen; danach
  muss `git status packages/tcms-<paket>` leer sein. Alternativ liefert
  `pnpm vertrag:export [--paket domain]` im TCMS-Repo für denselben Commit
  dasselbe `VENDOR.json` (gleiche Paketliste, Ausschlüsse und Beschreibung).
  Das gehört zum Review jeder Änderung unter `packages/tcms-contract` und
  `packages/tcms-domain`.
- **Stand:** Vertrag und Domain aus TCMS `main` `bfdfdd2` (s11; davor
  `92a1211` s10, `f146a78` s9, `4752652` s7/s8, `7a900b1`). Stufe 4: Akteursarten `KANZLEI`, `MANDANT`, `SYSTEM` mit
  `akteure` je Endpunkt, strukturierter Postausgang; Härtungen s5/s6:
  Portal-Endpunkte nur für `MANDANT`, maschinenlesbarer Grund `fehler.grund`
  jedes 403, Rechte-Kennzeichen für Stammdaten und Kontaktrollen,
  `verweigerung` an den Rechten der Durchführung, Zustellstatus an Freigaben
  und Risikoakzeptanzen, Meldung „unzustellbar“. s7: `heute` der
  Einrichtung, `partei` beim Ändern der Verantwortlichen, gesperrte Schritte
  einer Feststellung als 400 mit `felder.von`, Zeitraumzahlen,
  Pflichtattribut-Lücken, `rechte.bearbeiten` in Risiken, Kontrollen und
  Ländern, Länderbezüge, Rechte am Ereignis, Melderecht im Portal, berechnete
  Kennzahlen der Prüfung, „Nachweise je Dokument“, Bausteine lebend streng
  und eingefroren tolerant. s8: eine Zeichenregel aus Unicode-Eigenschaften
  (`UNZULAESSIG_KLASSE`), einzeilige Titel und Namen, Basisregel für
  Freitexte (`TEXT_UNZULAESSIG`), gespeicherte Profile tolerant
  (`ProfilAntwortenGespeichertSchema`). s9: Basisregel zusätzlich ohne
  Richtungssteuerzeichen (U+202A–202E, U+2066–2069, Meldung „Unzulässige
  Zeichen“), gespeicherte Abschnitte, Snapshots und Assistenten-Entwürfe
  tolerant (nur Länge, `BeschreibungBlockGespeichertSchema`), Listen in fester
  Reihenfolge. Domain zusätzlich mit den Rollen der
  Mandantenseite (`MANDANT_ROLLEN`). s10: maschinenlesbarer Konfliktgrund
  `fehler.konflikt` (feste Liste `KONFLIKT_GRUENDE`, je Endpunkt
  `konflikte`, Prüfung mit `fehlerSchemaFuer`), Idempotenzschlüssel der
  Portal-Meldung (`idempotenzSchluessel`, 24 h), Steuerart, Land, Zeitraum
  und Quellangabe einzeilig; die Einrichtung liefert unbekannte Personen als
  `null`. s11: Lesepfad `ereignisAnlagenJeDokumentLesen` (Ereignis-Anlagen je
  Dokument, nur Kanzlei; Grundlage für „Ungeklärte Anlage freigeben“), Audit-Liste
  als nach `maskiert` diskriminierte Union (vertrauliche Feststellungen für
  Nicht-Beteiligte ohne Person, Detail und Hashes; `prevHash`, `hash` und
  `kopf.hash` nullbar). s12: Die Kanzleileitung (`rol.adm`, in der
  kanzleikonsole Admin und Partner) liest vertrauliche Inhalte auf allen
  Lesepfaden unabhängig von Beteiligung und Mandatsbezug; das Audit liefert ihr
  keine maskierten Einträge (Schema unverändert). Vertrag und Dienst nur gemeinsam
  ausrollen: Die Schemas sind strikt, ein 403 ohne Grund ist für diesen
  Vertrag ein Protokollfehler. Die Zeichenregel folgt der Unicode-Version der
  Laufzeit: kanzleikonsole und Dienst auf derselben Node-Hauptversion (24).

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

Bevorzugter Weg ist das Endpunktregister des Vertrags (`ENDPUNKTE`, eine
Quelle für Methode, Pfad und Schemas; der Dienst registriert seine Routen
daraus und startet nicht bei Abweichung):

```ts
const { daten } = await rufeEndpunkt(client, ENDPUNKTE.kontextLesen, {
  params: { mandantId },
  query: { stand: '2026-10-16' },
  akteur,
});
```

`rufeEndpunkt` leitet die Typen von Eingabe und Ergebnis aus den Schemas ab
und prüft vor dem Senden zusätzlich zum Dienst: Pfadparameter mit dem
`paramsSchema` des Eintrags (z. B. UUIDs), die Akteursart nur auf Endpunkten,
deren `akteure` sie nennen (Stufe 4; `portal` ist davon abgeleitet und nur
noch für bestehende Aufrufer da), `health` nur über `client.health()`.

- **Akteursarten je Client (Stufe 4).** Ein `TcmsClient` bestätigt nur die
  Arten aus `akteurArten`: Standard `PERSONEN_AKTEURE` (`KANZLEI`,
  `MANDANT`), `NUR_SYSTEMAKTEUR` (`SYSTEM`) nur allein. Die Web-App baut ihren
  Client mit `PERSONEN_AKTEURE` (`server/tcms/dienst.ts`) und kann keinen
  Systemakteur signieren; den bildet allein der Zustell-Worker (Abschnitt 8).
  Der Guard `apps/web/src/__tests__/tcms-systemakteur-guard.test.ts` sperrt
  im Quelltext der Web-App Bestätigungen der Art `SYSTEM`, eigene Clients,
  andere Akteursarten, den Postausgang und Importe aus dem Worker.
  Abruf, Bestätigung und Meldung „unzustellbar“ des Postausgangs stehen als
  `holeOffeneNachrichten`/`meldeNachrichtZugestellt`/
  `meldeNachrichtUnzustellbar` im Client.

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
  (403, `grund` = Text des Dienstes, `verweigerung` = maschinenlesbarer Grund
  aus `fehler.grund`; ein 403 ohne gültigen Grund ist ein Protokollfehler),
  `TcmsNichtGefunden` (404), `TcmsKonflikt` (409, `konflikt` =
  maschinenlesbarer Grund aus `fehler.konflikt`, TCMS s10; `rufeEndpunkt`
  prüft jede Fehlerantwort mit `fehlerSchemaFuer(endpunkt)`: Ein 409 ohne
  Grund an einem Endpunkt mit `konflikte`, ein Grund, den der Eintrag nicht
  nennt, oder ein Grund an einem Endpunkt ohne `konflikte` ist ein
  Protokollfehler `SCHEMA` mit Pfad `fehler.konflikt`),
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
| `nam`     | `fullName` frisch aus der DB, mit der Zeichenregel des Vertrags bereinigt (TCMS s8), getrimmt, höchstens 200 Zeichen        | Anzeigename zum Zeitpunkt der Anfrage (Audit im TCMS); leer → keine Bestätigung.                                                                                                                                                                                                                                                                                                                                                            |
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
anmelden), deaktivierter Person, fehlendem Mandantenzugriff, mehr als 5 000
Mandanten, Kontakt ohne Portalzugang. Die Login-Sperre (`lockedUntil`) zählt
bewusst nicht: Sie sperrt nur neue Passwort-Anmeldungen; sonst könnten
Fehlversuche Dritter einer angemeldeten Person das TCMS sperren.

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
- **Modulbereich und Navigation (Stufe 3):** Bereich `tcms` im
  Modul-Register (`apps/web/src/lib/module-registry.ts`) mit `/staff/tcms`,
  `/staff/clients/[id]/tcms` und `/portal/tcms` (Layout-Gate und
  `requireModulePage`: Modul aus → 404). Die Einträge „Tax-CMS“ in der
  Seitenleiste (Staff: Gruppe Mandatsarbeit, Portal: Zusammenarbeit),
  „Tax-CMS-Arbeitskorb“ (Mandatsarbeit), „Tax-CMS-Audit“ (Administration,
  nur Admin/Partner) und der Reiter der Mandantenakte erscheinen zusätzlich
  nur bei konfiguriertem Dienst (`dienst: 'tcms'` in `lib/navigation-registry.ts`, gespeist aus
  `tcmsKonfiguriert()`). Modul an, Dienst nicht konfiguriert: kein
  Menüpunkt; direkt aufgerufene Seiten zeigen einen Hinweis statt eines
  Fehlers. „Subsumtion / TCMS“ (Modul `risk`) ist davon getrennt.
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
Bestätigung vor der Query prüft); Portal-Endpunkt mit Portal-Akteur; jeder
GET-Endpunkt des Registers, der nur den Mandanten als Parameter braucht, über
`rufeEndpunkt` (jede Erfolgsantwort gegen das `antwortSchema` des Registers,
fachliche Abweisungen über das `FehlerSchema`). Negativ:
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
# Lokale .env (Modus 600) mit SESSION_SECRET und TCMS_CODE_SCHLUESSEL – ohne
# Code-Schlüssel startet der Dienst nicht (TCMS s8); Werte nie ausgeben.
pnpm env:lokal
bash /home/claude/work/tcms-mkdb.sh tcms_kkct /home/claude/wt/tcms-kkct
# Schlüsselpaar: Ausgabe in eine Datei mit Modus 600, nie ins Terminal-Log.
umask 077 && node scripts/akteur-schluessel.mjs --kid kk-vertrag > ~/kkct-schluessel.txt
# API auf freiem Port (Token zufällig, z. B. openssl rand -base64 48); den
# Code-Schlüssel liest der Dienst aus der .env von `pnpm env:lokal`:
TCMS_SERVICE_TOKENS=<token> TCMS_ACTOR_PUBLIC_KEYS=<kid>=<spki> \
  DATABASE_URL=postgresql://tcms_app:<passwort>@127.0.0.1:55432/tcms_kkct \
  HOST=127.0.0.1 PORT=<port> node_modules/.bin/tsx --env-file=.env apps/api/src/server.ts
# Vertragstest in der kanzleikonsole:
cd <kanzleikonsole>/packages/tcms-client
TCMS_CONTRACT_TESTS=1 TCMS_URL=http://127.0.0.1:<port> TCMS_SERVICE_TOKEN=<token> \
  TCMS_ACTOR_PRIVATE_KEY=<pkcs8> TCMS_ACTOR_KEY_ID=<kid> pnpm test:contract
```

Ab TCMS s8 startet der Dienst ohne gültigen `TCMS_CODE_SCHLUESSEL` nicht
(Format wie die Dienst-Tokens, kein Eintrag gleich einem Token; das Startlog
nennt nur die Anzahl). `pnpm env:lokal` lässt einen gültigen Schlüssel
unverändert; wird er neu erzeugt, laufen offene Bestätigungscodes der
Test-Datenbank ab, Daten gehen nicht verloren. Im
verwalteten Betrieb erzeugt und rotiert die Operator-CLI den Schlüssel
([Tax-CMS-Betrieb](../operations/tcms-betrieb.md), Abschnitte 4 und 5).

Die Gründe der Abweisungen stehen nur im Log des Dienstes (`grund`, z. B.
`SIGNATUR`, `KID_UNBEKANNT`, `DIENST_TOKEN`, `REQ_BODY`, `JTI_WIEDERHOLT`) und
lassen sich über die `requestId` zuordnen. Nach einer Aktualisierung des
vendored Vertrags (Abschnitt 1) gegen denselben TCMS-Stand ausführen.

## 7. Oberflächen (Stufe 3)

Fundament für alle Seiten und Aktionen; Anleitung mit Beispielen im
[Leitfaden Tax-CMS-Oberflächen](tcms-oberflaechen.md), fachliche Regeln
TCMS-AKTEUR-001 und TCMS-DIENST-001 (ungeprüfte Entwürfe).

| Baustein                                             | Aufgabe                                                                                                                                                                                                                            |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/tcms/seite.ts`                               | Einstiege `tcmsMandantSeite(id)`, `tcmsKanzleiSeite()`, `tcmsAdminSeite()`, `tcmsPortalSeite()`; Lesen mit `tcmsLesen`/`tcmsLesenOptional` (Akteur, Mandant und Mandantenliste aus der Seite), `tcmsTenantLesen`, `tcmsNamenLesen` |
| `server/tcms/aktion.ts`                              | `tcmsKanzleiAktion`/`tcmsPortalAktion`: Gate mit Modul `tcms`, eine Tenant-Transaktion für Aktivierung, Akteur und `vorbereiten`, Dienstaufruf außerhalb, feste Fehlerabbildung, Revalidierung nur des TCMS-Bereichs               |
| `server/tcms/route.ts`                               | Route-Handler-Einstiege `tcmsMandantRoute(id)`, `tcmsPortalRoute()` für Datei-Abrufe (Prüfkette wie die Seiten, feste JSON-Antworten); `tcmsRouteLesen` nur für GET mit Mandant im Pfad (Leitfaden, Abschnitt 11)                  |
| `server/tcms/zustand.ts`                             | einzige Abbildung von Fehlern auf Seitenzustände und `ActionResult` mit festen Texten (`TCMS_SEITEN_TEXTE`, `TCMS_KEIN_RECHT`, `TCMS_AKTION_TEXTE`); Protokoll ohne Inhalte des Dienstes                                           |
| `server/tcms/namen.ts`, `server/tcms/personen.ts`    | Namen zu Personen-IDs nur aus dem Tenant bzw. vom Mandanten; Personen aus Formularen gegen den Mandanten prüfen (`TcmsPersonUnzulaessig` als Feldfehler)                                                                           |
| `server/tcms/mandant.ts`, `server/tcms/portfolio.ts` | Mandantenanker (Name, Rechtsform, DATEV-Nr.) aus der kanzleikonsole; Portfolio-Zeilen mit Namen und Zuständigkeit aus der Mandantenliste                                                                                           |
| `components/tcms/*`                                  | gemeinsame Anzeige-Bausteine (Zustände, Badges, Phasen, Heatmap, Kopf mit Stichtag, Unternavigation mit 14 Bereichen, Pflichthinweis), Tokens der kanzleikonsole, Labels aus `@taxtronik/tcms-domain`                              |

**Seiten.** Unter `/staff/clients/[id]/tcms` das Cockpit (mit „Mandant im
Tax-CMS anlegen“ bzw. „Stammdaten übernehmen“) und die 13 Bereiche der
Unternavigation (Kontakte & Rollen, Einrichtung, Profil, Beschreibung,
Risiken, Kontrollen, Durchführungen, Feststellungen, Ereignisse, Länder,
Kalender, Prüfung, Kommunikation); `/staff/tcms` (Portfolio),
`/staff/tcms/arbeitskorb`, `/staff/tcms/katalog` und `/staff/tcms/audit`
(Admin/Partner); `/portal/tcms` mit Aufgaben, Ereignismeldung und Freigaben.
Datei-Abrufe laufen über Route Handler unter `/api/staff/…/tcms/…` und
`/api/portal/tcms/…` (Leitfaden, Abschnitt 11). Das Layout unter
`/staff/clients/[id]/tcms` ruft `tcmsMandantSeite` vor jedem Rendern.

**Regeln.**

- Jede Seite beginnt mit genau einem Einstieg; `requireClientPageAccess`
  läuft im Mandanten-Einstieg als erster Aufruf. Die Guards
  `client-page-authz`, `module-page-guard` und `staff-page-authz` erkennen die
  Einstiege nur als Import aus `@/server/tcms/seite`, `server-action-authz` und
  `server-action-style` die Aktions-Helfer nur aus `@/server/tcms/aktion`.
- Der Mandant eines Aufrufs stammt nur aus der geprüften Seite bzw. dem
  gebundenen Aktionsargument (Kanzlei) oder der Sitzung (Portal); eine Seite
  oder Aktion kann `mandantId`, Akteur und Mandantenliste nicht
  überschreiben. Lesepfade erlauben nur `GET` und die lesenden POSTs
  Portfolio und Arbeitskorb; Portalseiten und -aktionen nur Endpunkte, deren
  `akteure` `MANDANT` nennen, Kanzleiseiten und -aktionen nur solche mit
  `KANZLEI` (Stufe 4: der Postausgang des Systemakteurs ist so für beide
  gesperrt).
- Kein Dienstaufruf innerhalb einer Datenbank-Transaktion; keine
  Wiederholung schreibender Aufrufe; kein Caching über die Anfrage hinaus.
- Rechte, Vier-Augen-Prinzip, §-153-Würdigung, Vertraulichkeit und Status
  entscheidet der Dienst; die Oberfläche blendet nach seinen
  Rechte-Kennzeichen aus und bildet Ablehnungen über feste Texte ab.
- Testdaten: `apps/web/src/__tests__/tcms-fixtures` (gegen das
  `antwortSchema` geprüft). Live-Test der Seiten und Aktionen gegen einen
  laufenden Dienst: `server/tcms/__tests__/oberflaechen-live.test.tsx` mit
  `TCMS_LIVE_TESTS=1` und den Variablen aus Abschnitt 6.

## 8. Zustellung des Postausgangs (Stufe 4)

Das Tax-CMS versendet keine E-Mails. Es legt Mitteilungen ab – Freigabe
angefordert, Bestätigungscode und Neuadressierung an Mandantenkontakte,
gemeldetes Ereignis an Kanzleipersonen – und die kanzleikonsole stellt sie zu
(ADR 0001 §3.4 und §7 „Postausgang“ des TCMS-Repos). Fachliche Regel:
[MAIL-OUTBOX-001](../fachkatalog/regeln/mandat-und-zugriff/mail-outbox-001-mandantenmail-zustellung.md)
(ungeprüfter Entwurf).

**Systemakteur.** Abruf und Bestätigung laufen mit einem Akteur der Art
`SYSTEM`: `sub` ist eine feste, zufällige UUID je Tenant
(`tcms_systemakteur.akteur_id`, `gen_random_uuid` beim ersten Lauf, nicht aus
der Tenant-ID ableitbar, per Trigger unveränderlich, eindeutig), `nam` ist
„Zustellung kanzleikonsole“, ohne `rol` und `cli`. Eine erfundene Admin-Person
hätte im Tax-CMS den ganzen Tenant lesen dürfen. Nur der Worker bildet ihn
(`apps/worker/src/tcms/systemakteur.ts`); sein Client
(`apps/worker/src/tcms/dienst.ts`, `akteurArten: NUR_SYSTEMAKTEUR`) bestätigt
keine Person und erreicht über das Register nur `nachrichtenOffenLesen`,
`nachrichtZugestelltMelden` und `nachrichtUnzustellbarMelden`. Die App-Rolle hat auf `tcms_systemakteur` und
`tcms_nachricht_zustellung` keine Rechte; die Web-App kann ihn weder kennen
noch signieren (Abschnitt 3, Guards in Web und Worker).

**Job `tcms-nachrichten-zustellen`** (minütlich; Kern
`apps/worker/src/jobs/tcms-nachrichten.ts`). Je Tenant mit
`isWorkerTcmsActive` und nur, wenn kein anderer Lauf den Lease in
`tcms_systemakteur` hält (`lauf_halter`/`lauf_bis`, 2 Minuten, vor jeder
Mitteilung verlängert):

1. `GET /v1/nachrichten/offen?limit=50` (älteste zuerst). Der Vertrag
   erlaubt bis zu 100 je Antwort; eine Antwort mit mehr Mitteilungen als
   angefragt gilt als Protokollfehler (`SCHEMA`), nichts wird übernommen
   (`apps/worker/src/tcms/dienst.ts`, Hinweis aus RT3B). Bei 50 bleibt es
   bewusst: Ein Lauf je Minute und Tenant hält die Lease kurz, der Rest folgt
   im nächsten Lauf.
2. Je Mitteilung eine Tenant-Transaktion: Zustellzeile
   `tcms_nachricht_zustellung` (eindeutig je Tenant und Nachrichten-ID) sperren
   bzw. mit `ON CONFLICT DO NOTHING` anlegen, Empfänger prüfen, einplanen.
3. Nach dem Commit melden – „zugestellt“ erst, wenn zugestellt ist
   (kk-tcms-s11, Zustandsmaschine unten): angenommen →
   `POST /v1/nachrichten/:id/zugestellt`, gescheitert bzw. unzustellbar →
   `POST /v1/nachrichten/:id/unzustellbar` mit `{ grund }` (TCMS s6). 404 und
   409 (dort bereits zugestellt bzw. unzustellbar, auch mit anderem Grund)
   gelten als erledigt; jeder andere Fehler lässt die Zeile ungemeldet – jeder
   Lauf führt offene Zeilen nach und meldet nur, mit demselben Grund.
4. Nachführen (kk-tcms-s11): Nach dem Abruf geht der Lauf die übrigen
   Zeilen ohne Meldung durch (älteste zuerst, höchstens 50): Eine eingeplante
   Mail übernimmt den Endstatus ihres Versandauftrags, eine abgeschlossene
   wird gemeldet. So erreicht die Meldung das Tax-CMS auch für Mitteilungen,
   die der Abruf nicht mehr liefert (im Tax-CMS inzwischen verworfen; nach
   dem Ausliefern bleibt sie dort meldbar).

**Zustandsmaschine** von `tcms_nachricht_zustellung` (Migration
`20261021150100`, CHECKs `…_status_check`, `…_grund_check`,
`…_abschluss_check`, `…_mail_check`):

| Status            | Bedeutung                                                                                                                     | offen | Grund       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- | ----------- |
| `EINGEPLANT`      | Versandauftrag in der Mail-Outbox angelegt, Versand läuft (nur Mitteilungen an Kontakte)                                      | ja    | –           |
| `ANGENOMMEN`      | Auftrag `PROVIDER_ACCEPTED` (der Mailserver des Anbieters hat angenommen) bzw. In-App-Hinweis an die Kanzleiperson angelegt   | nein  | –           |
| `GESCHEITERT`     | Auftrag ohne Annahme beendet: `FAILED`, `NO_RECIPIENT`, `PARTIAL_FAILURE`, `UNKNOWN`, `SKIPPED` (auch nach Ablauf) oder fehlt | nein  | fester Code |
| `ZURUECKGESTELLT` | Empfängerprüfung vor der Einplanung gescheitert, nächster Lauf prüft erneut                                                   | ja    | fester Code |
| `UNZUSTELLBAR`    | Empfängerprüfung nach `TCMS_UNZUSTELLBAR_NACH_TAGEN` bzw. Fenster abgelaufen, nie eingeplant                                  | nein  | fester Code |

`gemeldet_am` setzt der Worker, sobald die Meldung angekommen ist (oder 404/409),
nur für abgeschlossene Zeilen. „Zugestellt“ heißt damit: Der Mailserver des
Anbieters hat die Mail angenommen – ob sie im Postfach ankam, ist ohne
Zustellbericht nicht feststellbar. Der Grund eines Scheiterns folgt fest aus
dem Endstatus (`auftragsAbschluss`): `FAILED`/`NO_RECIPIENT`/`PARTIAL_FAILURE`
→ `VERSAND_GESCHEITERT`, `UNKNOWN` → `VERSAND_UNKLAR`, fehlender Auftrag →
`AUFTRAG_FEHLT`, `SKIPPED` → der Grund der Aktualitätsprüfung
(`TCMS_VERWORFEN_TEXTE` in `packages/mail/src/outbox-relevance.ts`, aus dem
Vermerk `Nicht versendet: …` gelesen: abgelaufen → `ABGELAUFEN`, Empfänger
inaktiv bzw. unbestätigt → `KONTAKT_INAKTIV`/`KONTAKT_UNBESTAETIGT`, Adresse
ohne zustellbare Form → `KONTAKT_OHNE_EMAIL`, fremd →
`KONTAKT_ANDERER_MANDANT`, Mandat inaktiv → `MANDANT_INAKTIV`, sonst
`VERSAND_VERWORFEN`). Ob der Empfänger noch aktiven Portalzugang hat, prüft die
Aktualitätsprüfung seit kk-tcms-fix5 mit derselben Regel wie die Einplanung
(`@taxtronik/db/portal-zugang`: Mandant, Kontakt, Adressform, Anmeldung) und
verlangt zusätzlich, dass die Adresse noch die des Auftrags ist. Die Mail-Outbox entfernt Inhalt und Code bei jedem
Endstatus unverändert (`mail_outbox_tcms_content_check`).

Das Tax-CMS reserviert beim Abruf nichts. Doppelte schließen die eindeutige
Zustellzeile, ein partieller eindeutiger Index auf `mail_outbox`
(`tenant_id, resource_id` für `resource_type = 'tcms_nachricht'`) und der
Lease aus.

| Empfänger | Prüfung (allein Daten der kanzleikonsole)                                                                                                                                 | Zustellung                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KONTAKT` | Mandant im Tenant, zugelassen, nicht beendet, nicht anonymisiert; Kontakt dieses Tenants und **genau dieses** Mandanten, aktiv, gültige E-Mail, bestätigt (`lastLoginAt`) | `enqueueDirectMailTx`, Anlässe `tcms-freigabe-angefordert`, `tcms-freigabe-code`, `tcms-freigabe-neu-adressiert`, Vorgang `tcms_nachricht` = ID der Zustellzeile |
| `KANZLEI` | Mandant im Tenant, nicht anonymisiert; Person dieses Tenants, aktiv, mit Zugriff (`canStaffAccessClientTx`)                                                               | In-App-Hinweis `TCMS_EREIGNIS_GEMELDET` mit Nummer und Titel, Link `/staff/clients/<id>/tcms/ereignisse`                                                         |

Die Benachrichtigungs-Einstellung des Kontakts gilt nicht (Transaktionsmail
zu einem Vorgang, den er selbst ausgelöst hat oder der ihn nennt); verlangt
wird aber eine bestätigte Adresse. Adressen aus dem Tax-CMS gibt es nicht.

**Code.** Der Bestätigungscode geht nur als `secretVars.code` in die Outbox
(Secret-Box, an Tenant und Auftrag gebunden) und wird erst beim Versand
eingesetzt. Für Vorgänge `tcms_nachricht` entfernt jeder Endstatus Inhalt und
geheime Variablen, auch `FAILED`/`UNKNOWN` (DB-CHECK
`mail_outbox_tcms_content_check`); „Erneut senden“ gibt es dafür nicht
(`MAIL_OUTBOX_NO_RESEND_RESOURCE_TYPES`). `betreff` und `text` des Dienstes
(Rückfall, können den Code enthalten) werden nie übernommen; die Texte kommen
aus den System-Vorlagen bzw. dem gleichlautenden Ersatztext
(`packages/mail/src/tcms-vorlagen.ts`, Platzhalter dort und in der
Vorlagenverwaltung). Betreffzeilen nennen den Code nie.

**Gültigkeit.** Code bis `gueltigBis`; Anforderung und Neuadressierung
`TCMS_NACHRICHT_FENSTER_TAGE` (7, wie die Code-Lebensdauer) ab Anlage;
Ereignisse unbegrenzt. Außerhalb des Fensters: nicht zustellen, als
`UNZUSTELLBAR` (`ABGELAUFEN`) abschließen und als unzustellbar melden. Die Outbox prüft vor
jedem Versandversuch dasselbe Fenster und den Empfänger (aktiv, bestätigt,
dieser Mandant, unveränderte Adresse, Mandat aktiv) und verwirft sonst
(`SKIPPED`).

**Scheitert die Prüfung:** nicht einplanen, nicht melden, Status
`ZURUECKGESTELLT` mit festem Grund (z. B. `KONTAKT_UNBESTAETIGT`), einmal je
Mitteilung ein Hinweis `TCMS_ZUSTELLUNG_GESCHEITERT` an die aktiven
ADMIN/PARTNER (Anlass und Grund, keine Namen, kein Titel, kein Code). Jeder
Lauf prüft erneut; nach `TCMS_UNZUSTELLBAR_NACH_TAGEN` (7) ab der ersten
gescheiterten Prüfung `UNZUSTELLBAR` und als unzustellbar melden. Begründung
der 7 Tage: gleich der Code-Lebensdauer, danach ist jede Mitteilung inhaltlich
überholt; die Frist deckt ein Wochenende plus Abwesenheit ab; länger offene
Mitteilungen belegten den ältesten-zuerst-Abruf.

**Meldegrund.** Der Grund der Meldung „unzustellbar“ folgt fest aus dem
gespeicherten Grund der Zustellzeile (`TCMS_MELDEGRUND`, vollständig per
`satisfies`), steht also vor dem ersten Senden fest; eine Wiederholung prüft
nicht neu und sendet denselben Grund (das Tax-CMS nimmt ihn nur mit demselben
Grund idempotent an).

| Grund der Zustellzeile                                                                                      | Meldung an das Tax-CMS |
| ----------------------------------------------------------------------------------------------------------- | ---------------------- |
| `ABGELAUFEN`                                                                                                | `ABGELAUFEN`           |
| `KONTAKT_UNBESTAETIGT`, `KONTAKT_INAKTIV`, `KONTAKT_OHNE_EMAIL`                                             | `KEIN_PORTALZUGANG`    |
| `KONTAKT_UNBEKANNT`, `KONTAKT_ANDERER_MANDANT`, `PERSON_UNBEKANNT`, `PERSON_INAKTIV`, `PERSON_OHNE_ZUGRIFF` | `EMPFAENGER_UNGUELTIG` |
| `MANDANT_UNBEKANNT`, `MANDANT_INAKTIV`                                                                      | `SONSTIGES`            |
| `VERSAND_GESCHEITERT`, `VERSAND_UNKLAR`, `VERSAND_VERWORFEN`, `AUFTRAG_FEHLT` (kk-tcms-s11)                 | `SONSTIGES`            |

Das Tax-CMS zeigt den Zustellstatus an Freigabenhistorie, Beschreibung und
Risikoakzeptanz; die kanzleikonsole bietet dort die Neuadressierung an
(`components/tcms/zustellung.tsx`, „Nachricht zugestellt (vom Mailserver
angenommen)“). „Zugestellt“ heißt seit kk-tcms-s11: Der Mailserver des
Anbieters hat die Mail angenommen (bzw. der Hinweis an die Kanzleiperson ist
angelegt); bis dahin bleibt die Mitteilung im Tax-CMS offen, jeder andere
Endstatus des Versandauftrags wird als unzustellbar gemeldet.

**Logs** nennen Tenant, Nachrichten-ID, Zweck, Grund, Art der Meldung und die
Fehlerklasse des Clients (Status, Code, Request-ID); nie Code, Text, Betreff, Titel, Namen, Adressen, Mandanten- oder
Personen-IDs. Gemeldete Zustellzeilen (und lange nicht mehr gesehene
zurückgestellte) löscht der Job nach 30 Tagen.

**Meldevorgänge des Portals (kk-tcms-s10nach, TCMS s10).** Zu Beginn jedes
Laufs – vor der Prüfung, ob das Tax-CMS konfiguriert ist – löscht der Job
tenantübergreifend (Owner) die Meldevorgänge einer Portal-Meldung
(`tcms_portal_report`), deren Wiederholungsfenster abgelaufen ist: gesendet
vor mehr als `MELDUNG_WIEDERHOLUNG_FENSTER_MS` (23 h, 24 h des Tax-CMS minus
1 h Uhrenabstand) bzw. nie gesendet und älter als
`MELDUNG_UNGESENDET_AUFBEWAHRUNG_MS` (24 h), samt verschlüsseltem Inhalt
(`meldevorgaengeBereinigen`, echte Zeit, nie die Uhr des Laufs). Die Anlagen
fasst er nicht an: Sie bleiben gebunden und erscheinen der Kanzlei als
ungeklärte Anlage (TCMS-NACHWEIS-001). Zähler `meldungenBereinigt`; ein Fehler
zählt in `fehler` und hält den Lauf nicht an. Wiederholt wird nur in der
Web-App durch die meldende Person (`server/tcms/portal/meldevorgang.ts`), nie
im Worker: Der Schlüssel gilt im Tax-CMS nur für diese Person.

**Tests.** `apps/worker/src/jobs/__tests__/tcms-nachrichten-db.test.ts`
(PostgreSQL, In-Memory-Postausgang und echter Client gegen einen lokalen
Server, Zustandsmaschine und Nachführung, Bereinigung der Meldevorgänge nach
echter Zeit ohne Freigabe),
`apps/worker/src/jobs/__tests__/tcms-zustellung-e2e-db.test.ts` (Ende zu Ende
mit echter Mail-Outbox und lokaler SMTP-Senke auf 127.0.0.1:1025: Annahme,
Ablehnung bis FAILED, Verwerfen vor dem Versand),
`apps/worker/src/jobs/__tests__/tcms-nachrichten-meldegrund.test.ts`
(Abbildung der Endstatus und Gründe), `apps/worker/src/__tests__/tcms-systemakteur-guard.test.ts`,
`apps/worker/src/jobs/__tests__/mail-outbox.test.ts`,
`packages/mail/src/__tests__/outbox-relevance.test.ts`,
`packages/tcms-client/src/__tests__/nachrichten.test.ts`.
