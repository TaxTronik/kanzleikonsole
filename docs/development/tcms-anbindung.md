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
  der Nutzer des Vertrags laufen lassen. Die Aktualisierung ist ein eigener
  Commit mit dem Quell-Commit im Text.

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
