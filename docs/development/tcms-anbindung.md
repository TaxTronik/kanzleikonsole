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
  der Nutzer des Vertrags laufen lassen. Die
  Aktualisierung ist ein eigener Commit mit dem Quell-Commit im Text.
