# Dependency-Audit 2026-11-17

Technischer Prüfstand: 17. November 2026, Ausgangscommit `97d73a99`.
Keine fachliche Freigabe und keine Änderung an fachlicher Workflow-Logik.

## Befunde und Fixstände

`pnpm audit --prod --audit-level low` meldete auf `main` drei Schwachstellen im
Produktionsgraphen, zwei mittlere und eine niedrige; der blockierende Audit mit
`audit.level: high` zeigte sie nicht an. Der Gesamtaudit meldet zusätzlich
picomatch (hoch, nur Entwicklung). Alle Befunde stammen aus neuen Advisories.

| Paket                      | Bisher         | Fixstand | Pfad                                                               | Advisories                                                                                                                                                 |
| -------------------------- | -------------- | -------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js                    | 16.4.1         | 16.4.6   | Web, Auth.js                                                       | mittel: [GHSA-mfr8-8qww-v76h](https://github.com/advisories/GHSA-mfr8-8qww-v76h), [GHSA-vc7v-qv4w-wrv8](https://github.com/advisories/GHSA-vc7v-qv4w-wrv8) |
| `@next/eslint-plugin-next` | 16.4.1         | 16.4.6   | nur Entwicklung, folgt Next.js                                     | –                                                                                                                                                          |
| fast-xml-parser            | 5.11.0 / 5.7.3 | 5.12.0   | `@taxtronik/tax` (EU-Liste), `@aws-sdk/xml-builder` (S3-Antworten) | niedrig: [GHSA-474x-hrwr-fgx4](https://github.com/advisories/GHSA-474x-hrwr-fgx4)                                                                          |
| picomatch                  | 2.3.2 / 4.0.x  | offen    | nur Entwicklung (Vite, Vitest, ESLint, fast-glob)                  | hoch: [GHSA-fc5q-39xc-vjpf](https://github.com/advisories/GHSA-fc5q-39xc-vjpf), kein Fixstand veröffentlicht                                               |

Next.js und das ESLint-Plugin sind wie bisher exakt gepinnt. fast-xml-parser ist im
Tax-Paket exakt gepinnt und zusätzlich als exakter Override erzwungen, weil
`@aws-sdk/xml-builder` 3.972.25 den verwundbaren Stand 5.7.3 exakt pinnt. Der
Lockfile ändert sich nur für Next.js samt `@next/*`, fast-xml-parser und dessen
Abhängigkeiten (`@nodable/entities` 3.1.0, `fast-xml-builder` 1.3.1, `is-unsafe`
2.0.3, `strnum` 2.5.1, `xml-naming` 0.3.0) sowie das Peer-Suffix von `next-auth`.
pnpm trägt außerdem den Registry-Hinweis „deprecated“ an `node-abort-controller`
3.1.1 nach; Version und Integrität bleiben.

## Einordnung

**Next.js:** Beide Advisories betreffen Cache-Einträge von `'use cache'`-Funktionen
über Root-Parameter. Die Konsole nutzt weder `'use cache'` noch `unstable_cache`
(`apps/web/src/server/tcms/seite.ts` hält das ausdrücklich fest); die Lücken waren
hier nicht erreichbar. Das Update erfolgt trotzdem, damit der Audit sauber bleibt.
Der Produktions-Build läuft mit 16.4.6 durch.

**fast-xml-parser:** Die Advisory betrifft die Suche nach dem Ende nicht
geschlossener Stop-Node-Tags. Weder `packages/tax/src/screening/source.ts` noch
`@aws-sdk/xml-builder` konfigurieren `stopNodes`; erreichbar war die Lücke also
nicht. Der Sprung des AWS-Pfads von 5.7.3 auf 5.12.0 berührt aber jede XML-Antwort
des Object Stores. Ein Vergleich von `parseXML` aus `@aws-sdk/xml-builder` mit beiden
Ständen an elf typischen S3-Antworten (Versionslisten mit `&amp;`, `&lt;`, `&apos;`,
`&quot;`, numerischen Zeichenreferenzen und Umlauten im Schlüssel, Object-Lock-Frist
und -Konfiguration, Multipart-Upload, Fehler, `DeleteResult`, CDATA, Kommentar)
ergab elfmal dasselbe Ergebnis. Der neue `s3-xml-compat.test.ts`
(`DOC-OBJECT-LOCK-001`) schickt dieselben Antworten durch den echten
`S3Client` und ersetzt nur die Netzwerkschicht. Alternativ hätte ein neueres
`@aws-sdk/xml-builder` (ab 3.972.36 ohne fast-xml-parser) die Abhängigkeit
beseitigt, aber einen anderen XML-Parser für alle S3-Antworten eingeführt; das ist
für eine niedrige, nicht erreichbare Lücke das größere Risiko.

**picomatch:** Nur Entwicklung und nicht blockierend. Für GHSA-fc5q-39xc-vjpf ist
noch kein Fixstand veröffentlicht; die Muster stammen aus dem Repository. Offen
bis zu einem Release.

## Prüfung der Installations-Hooks und der Mindestwartezeit

Die installierten Manifeste aller neuen Stände enthalten weder `preinstall`,
`install`, `postinstall` noch `prepare`, und keines enthält eine `binding.gyp`.
`allowBuilds` und seine Soll-Liste in `scripts/check-pnpm-supply-chain.sh`
brauchen keine neue Entscheidung; `strictDepBuilds: true`,
`dangerouslyAllowAllBuilds: false` und der pnpm-Pin 12.14.0 bleiben. Alle neuen
Stände erfüllen die Mindestwartezeit, es gibt keine neue Ausnahme. Am knappsten
sind Next.js 16.4.6 samt `@next/*` vom 9. November, gefolgt von fast-xml-parser
5.12.0 und `is-unsafe` 2.0.3 vom 3. November. fast-xml-parser 5.12.1 und Next.js-
Stände ab 16.4.7 liegen noch in der Mindestreife.

## Technische Nachweise

Geprüft in einem isolierten Linux-Container (`node:24.22.1-bookworm`, glibc wie
die CI-Runner) mit pnpm 12.14.0 aus `packageManager` und dem Env-Block aus
`.forgejo/workflows/ci.yml`. Quelle war ein frischer Klon von `main` (`97d73a99`)
mit LF-Zeilenenden, auf den die Änderungen als Patch angewendet wurden; im
Container existierte vor der Installation kein `node_modules`, der separate Store
war leer.

- `pnpm install --frozen-lockfile --prod=false --store-dir <leerer Store>` ohne
  `--ignore-scripts`: bestanden. Die erlaubten Hooks von Prisma, esbuild und
  msgpackr-extract liefen.
- `pnpm audit --prod --audit-level high`: keine bekannten Schwachstellen.
  `pnpm audit --audit-level low`: nur picomatch (siehe oben).
- `pnpm guard:supply-chain`, `pnpm format:check`, `pnpm docs:check` und die
  Prisma-Client-Generierung (`scripts/ci/setup.sh prisma`): bestanden.
- `pnpm lint`: bestanden.
- `pnpm typecheck`: 19 von 19 Turbo-Aufgaben.
- `pnpm exec turbo run test --filter='!@taxtronik/db'`: 16 von 16 Aufgaben, 8581
  Tests bestanden, darunter 6560 im Web-Paket; dort 42 ohne Dienste übersprungen.
  Darunter `s3-xml-compat.test.ts` (6), das Tax-Paket (183) und Storage (92).
- `pnpm test:ops`: 207 Tests bestanden, keiner gescheitert. `sudo` war im Container
  (root) durch einen Stub ersetzt; das betrifft nur `ci-apt.test.sh`. Ohne
  `CI=true`, weil die Compose-Tests in `tcms-compose.test.mjs` die Docker-CLI
  brauchen, die im Container fehlt; diese fünf Tests übersprangen sich und laufen
  im CI-Runner.
- `pnpm fachkatalog:check` (86 Regeln gültig und aktuell) und
  `pnpm fachkatalog:diff` (zwei Fachpfad-Änderungen zugeordnet): bestanden.
  `DOC-OBJECT-LOCK-001` erhält den neuen Testverweis, `GWG-SCREENING-001` einen
  technischen Nachweis zum Tax-Paket; beide Regeln und ihr Prüfstatus bleiben
  unverändert.
- Docker-Builds von `infra/docker/Dockerfile.web` und `Dockerfile.worker` aus
  demselben sauberen Klon: bestanden. Das Web-Image enthält Next.js 16.4.6, beide
  Images fast-xml-parser 5.12.0 neben `@aws-sdk/xml-builder` 3.972.25. Die Images
  wurden nur lokal gebaut, weder veröffentlicht noch gestartet.

Unter Windows (eigener Worktree, Node 24.15.0) liefen dieselben Unit-Tests mit zwei
roten Fällen, die unter Linux grün sind und auch ohne diese Änderung auftreten:
`server/backup/__tests__/runner.test.ts` (Windows-Pfad) und
`bulk-download-stream.test.ts` › „Client-Disconnect (req.signal)“. Letzterer
scheiterte in einem frisch installierten, unveränderten `main`-Worktree zehnmal
von zehn; ein Vergleich von `NextRequest#signal` in 16.4.1 und 16.4.6 zeigte
gleiches Verhalten (Abbruch synchron, Grund weitergereicht).

Nicht nachgewiesen und dem anschließenden CI-Lauf vorbehalten sind die
Compose-Tests von `test:ops`, die datenbankgestützten Integrationsjobs und die
vollständige Playwright-Suite. Ein Deployment wird aus diesem Prüfstand nicht
behauptet.

**Nachtrag vom 21. November 2026.** Der erneute Abgleich mit dem
Renovate-Dashboard enthält die beiden Lockfile-Audits und die gesondert
gemessenen Paket- und Engine-Befunde für das ClamAV-Image.
[Nachprüfung von Renovate und Container-Images](2026-11-21-tcms-integration-und-imagepflege.md#renovate-und-container)
