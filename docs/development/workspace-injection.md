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

Das Web-Image enthält keine Workspace-Pakete: Next.js transpiliert und bündelt
sie (`transpilePackages`) in den Standalone-Server.
