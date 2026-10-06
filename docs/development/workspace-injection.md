# pnpm-Workspace-Layout: Symlinks statt injizierter Kopien

`pnpm-workspace.yaml` setzt `nodeLinker: hoisted` und
`injectWorkspacePackages: false`. Workspace-Pakete (`@taxtronik/*`) liegen
damit nicht mehr als Hardlink-Kopien im Root-`node_modules`, sondern als
Symlink im `node_modules` jedes Pakets, das sie deklariert, z. B.:

```
apps/web/node_modules/@taxtronik/config -> ../../../../packages/config
packages/mail/node_modules/@taxtronik/storage -> ../../../storage
```

## Folgen für die Entwicklung

- Quelländerungen in `packages/*` wirken sofort in Web, Worker, Vitest und
  `tsc`. Das frühere `rm -rf node_modules && pnpm install` nach einer
  Quelländerung, ein Paket-`build` zum Synchronisieren oder ein
  Abgleichskript für injizierte Kopien entfallen.
- Vitest sieht jedes Workspace-Paket unter genau einem Pfad. `vi.mock(...)`
  trifft damit dasselbe Modul wie der Code unter Test.
- Ein `@taxtronik/*`-Import ohne Eintrag im `package.json` des importierenden
  Pakets scheitert (Modul nicht gefunden). Fix: das Paket mit `workspace:*`
  unter `dependencies` (Laufzeit, auch reine Typen in exportierten
  Signaturen) oder `devDependencies` (Tests, Skripte) eintragen und
  `pnpm install` ausführen.

## Was der flache Baum weiterhin verdeckt

Drittpakete werden weiter flach ins Root-`node_modules` gelegt. Ein Import
eines nicht deklarierten Drittpakets funktioniert deshalb lokal und in CI,
solange irgendein Workspace-Paket es zieht. Jedes Paket deklariert daher alle
Pakete, die es selbst importiert, und keine Pakete, die es nicht importiert.
Eine automatische Prüfung dafür (z. B. knip) gibt es noch nicht.
`shamefullyHoist` ist entfallen, weil es unter `nodeLinker: hoisted` keine
Wirkung hat.

## Umstellung bestehender Checkouts

Ein einmaliges `pnpm install` nach dem Update ersetzt die alten Kopien durch
Symlinks. Das gilt auch für die Host-Werkzeuge der Betriebs-CLI: deren
`pnpm install --frozen-lockfile` stellt das Layout ohne Rückfrage um.

## Produktions-Images

Beide Dockerfiles laden die Pakete per `pnpm fetch` nur anhand von Lockfile,
`pnpm-workspace.yaml` und `.npmrc` in eine eigene Store-Schicht; Quell- und
Doku-Änderungen invalidieren sie nicht. `pnpm guard:docker-bases` prüft, dass
jede Quelle dieser COPY-Schritte im Repository existiert und nicht per
`.dockerignore` ausgeschlossen ist. Danach folgen Quell-COPY und
`pnpm install --offline`.

- Web: Next.js transpiliert und bündelt die Workspace-Pakete
  (`transpilePackages`) in den Standalone-Server; das Image enthält keine
  Workspace-Quellen.
- Worker: `apps/worker/scripts/build.mjs` bündelt `src/index.ts` samt
  Workspace-Paketen per esbuild nach `dist/index.js` (Source Maps ohne
  Quelltext); Drittpakete bleiben extern. `pnpm deploy --prod` befüllt das
  Laufzeit-`node_modules` ohne devDependencies, `scripts/verify-runtime.mjs`
  prüft, dass jeder externe Import dort zur beim Bündeln gesehenen Version
  auflöst. Löst ein Workspace-Paket ein Drittpaket in einer anderen Version
  auf als das Bundle (im flachen Baum verschachtelt, z. B. `fast-xml-parser`
  von `@taxtronik/tax`), wird es eingebunden statt extern geladen.
