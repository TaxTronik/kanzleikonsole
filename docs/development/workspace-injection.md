# Workspace-Injektion: veraltete Klone nach Quelländerung

`pnpm-workspace.yaml` setzt `injectWorkspacePackages: true` (zusammen mit
`nodeLinker: hoisted`). pnpm legt dadurch von jedem workspace-internen Paket,
das ein anderes workspace-internes Paket als Dependency zieht, eine **echte
Kopie** (Hardlink-Copy, kein Symlink) unter dessen verschachteltem
`node_modules/@taxtronik/<pkg>` an — z. B.:

```
node_modules/@taxtronik/storage/node_modules/@taxtronik/config
node_modules/@taxtronik/evidence/node_modules/@taxtronik/http-utils
```

## Die Falle

Ein **inkrementelles** `pnpm install` (auch `--force`) synchronisiert diese
Klone **nicht** neu, wenn sich nur der Quellcode des Pakets geändert hat (die
Paket-Version/`package.json` aber gleich blieb). pnpm meldet „Already up to
date", während der injizierte Klon den **alten** Stand behält.

Folge lokal: Code, der z. B. `@taxtronik/storage` importiert, sieht eine
veraltete `@taxtronik/config`-Kopie. Symptome reichen von „ein neu exportiertes
Symbol fehlt" bis zu unerwartetem ENV-Validierungsverhalten in Vitest, weil der
Klon ein anderes Modul (anderer Pfad) ist als die Quelle — `vi.mock('@taxtronik/
config')` greift dann nicht auf den Klon-Pfad.

## Der Fix (lokal)

Nach einer Quelländerung an einem workspace-internen Paket, das von einem
anderen konsumiert wird, die Klone erzwungen neu erzeugen:

```sh
rm -rf node_modules && pnpm install
```

Nur ein **sauberer** Install erstellt die injizierten Kopien aus dem aktuellen
Quellstand neu. `pnpm install --force` allein genügt nicht.

## Warum CI nicht betroffen ist

CI läuft auf frischen Runnern immer mit sauberem `pnpm install --frozen-lockfile`
— dort entstehen die Klone genau einmal aus dem eingecheckten Stand. Das Problem
ist ausschließlich ein Cache-Artefakt lokaler, inkrementeller Installs.

## Test-Hermetik (Empfehlung)

Damit Unit-Tests unabhängig vom Injektionsstand sind, kann eine `resolve.alias`
in der jeweiligen `vitest.config.ts` die `@taxtronik/*`-Specifier direkt auf die
Workspace-`src` mappen (dedupliziert die Modul-Identität). Wo Tests ihre
Workspace-Abhängigkeiten ohnehin per `vi.mock(...)` ersetzen (Muster in
`apps/web`), ist das nicht nötig — der Mock hat Vorrang. Für Tests, die ein
echtes Workspace-Paket transitiv laden (z. B. `poa/actions` → `@taxtronik/
storage`), sollte die Abhängigkeit gemockt oder per Alias auf `src` gezogen
werden, statt sich auf den injizierten Klon zu verlassen.
