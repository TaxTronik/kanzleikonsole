# Dependency-Audit 3733

Technischer Prüfstand: 7. Oktober 2026, Ausgangscommit `6dd2890d`.
Keine fachliche Freigabe und keine Änderung an fachlicher Workflow-Logik.

## Befunde und Fixstände

Der Log `security-Dependency_Audit-3733.log` meldet im blockierenden
Produktionsaudit (Stufe `high`) vier Schwachstellen, zwei hohe und zwei
mittlere; der nicht blockierende Gesamtaudit meldet fünf. Alle Befunde stammen
aus neuen Advisories, nicht aus geänderten Abhängigkeiten.

| Paket                                 | Bisher         | Fixstand       | Pfad                                        | Advisory                                                                                           |
| ------------------------------------- | -------------- | -------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| sharp samt `@img/sharp-*` und libvips | 0.35.4 / 1.3.3 | 0.35.5 / 1.3.4 | Next.js (Bildoptimierung), Produktionsgraph | [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), librsvg (CVE-2026-96889) |
| source-map-js                         | 1.2.1          | 1.2.2          | postcss über Next.js und Vite               | [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q), Event-Loop-DoS           |
| fast-copy                             | 4.0.3          | 4.1.1          | pino-pretty in Web und Worker               | [GHSA-jggr-w7fw-pc2j](https://github.com/advisories/GHSA-jggr-w7fw-pc2j), Stack-Erschöpfung        |

Die Fixstände sind wie die bisherigen Sicherheitsstände als exakte Overrides in
`pnpm-workspace.yaml` gepinnt. Der Lockfile ändert sich nur für diese Pakete.

Ohne veröffentlichten Fixstand bleiben zwei Befunde:

- braces 3.0.3, hoch
  ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)):
  nur im Entwicklungsgraphen über `@next/eslint-plugin-next > fast-glob >
micromatch`. Die Muster stammen aus dem Repository; der Gesamtaudit ist
  nicht blockierend.
- sprintf-js 1.1.3, mittel
  ([GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)):
  über `mammoth > argparse`. argparse lädt nur die Kommandozeile
  `bin/mammoth`; die Textextraktion (`apps/web/src/server/risk/extract-text.ts`)
  nutzt die Bibliotheks-API aus `lib/index.js`, die argparse nicht lädt. Der
  Befund liegt unter der blockierenden Stufe `high`.

## Prüfung der Installations-Hooks und der Mindestwartezeit

Die Registry-Manifeste von sharp 0.35.5, `@img/sharp-linux-x64` und
`@img/sharp-linuxmusl-x64` 0.35.5, `@img/sharp-libvips-linux-x64` 1.3.4,
source-map-js 1.2.2 und fast-copy 4.1.1 enthalten weder `preinstall`,
`install`, `postinstall` noch `prepare` und keine `binding.gyp`. sharp und die
`@img`-Pakete sind über GitHub Trusted Publishing mit Provenance veröffentlicht;
source-map-js und fast-copy ohne Provenance wie ihre Vorgängerstände, die
`no-downgrade`-Trust-Policy lässt die Installation zu. `allowBuilds` braucht
keine neue Entscheidung.

sharp und die `@img`-Pakete (27. September) sowie fast-copy 4.1.1
(2. September) erfüllen die siebentägige Mindestwartezeit. source-map-js 1.2.2
erschien am 30. September um 14:08 UTC und erreicht sie erst am 7. Oktober.
Dafür steht die versionsgebundene Ausnahme `source-map-js@1.2.2` in
`minimumReleaseAgeExclude` und in der Soll-Liste von
`scripts/check-pnpm-supply-chain.sh`; das Paket hat keine Abhängigkeiten und
keine Hooks.

## Technische Nachweise

Geprüft im Linux-Prüfcontainer mit Node 24 und pnpm 12.4.1:

- `pnpm install` mit den Supply-Chain-Regeln aus `pnpm-workspace.yaml`:
  bestanden; anschließend `pnpm install --frozen-lockfile --offline`: bestanden.
- `pnpm audit --prod --audit-level high`: Exit 0, verbleibend nur sprintf-js
  (mittel).
- `pnpm audit --audit-level low`: verbleibend braces (hoch, dev) und sprintf-js
  (mittel), beide ohne Fixstand.
- `pnpm guard:supply-chain`: bestanden.
- Produktionsbuild von Web (Next.js samt postcss, Standalone-Trace mit sharp
  0.35.5) und Worker samt `pnpm deploy --prod` und Laufzeitprüfung:
  bestanden. sharp erzeugt mit libvips 8.18.7 ein PNG; pino-pretty formatiert
  verschachtelte Logobjekte mit fast-copy 4.1.1.

Docker-Images wurden nicht gebaut; der Prüfcontainer erreicht Docker Hub und
die Alpine-Spiegel nicht. Der entfernte CI-Lauf ist dadurch nicht nachgewiesen.
