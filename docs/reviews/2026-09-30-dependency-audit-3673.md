# Dependency-Audit 3673

Technischer Prüfstand: 30. September 2026, Ausgangscommit `16fb0436`.
Keine fachliche Freigabe und keine Änderung an fachlicher Workflow-Logik.

## Befunde und Fixstände

Der bereitgestellte Log `security-Dependency Audit-3673.log` meldet
27 Schwachstellen: neun hohe, 15 mittlere und drei niedrige. Die Aktualisierung
schließt die betroffenen Paketstände im Produktions- und Entwicklungsgraphen.
Der erneute Registry-Audit meldete zusätzlich den am 30. September in die
GitHub-Advisory-Datenbank aufgenommenen kritischen Next.js-Befund; auch dessen
Fix ist enthalten.

| Paket                                   | Bisher         | Fixstand        | Begründung / Primärquelle                                                                                                                                                    |
| --------------------------------------- | -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nodemailer                              | 9.1.1          | 10.0.10         | [Empfängerparser](https://github.com/advisories/GHSA-g57g-f23g-4646), [zusätzliche SMTP-/DKIM-Korrekturen](https://github.com/nodemailer/nodemailer/releases/tag/v10.0.10)   |
| Undici                                  | 8.9.0          | 8.10.2          | [WebSocket-DoS](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) und weitere im Log aufgeführte TLS-, Cache- und Ressourcenbefunde                                         |
| fast-uri                                | 3.1.6          | 3.1.8           | [Hostnormalisierung](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) und Authority-/Host-Verwechslung                                                                     |
| ip-address                              | 10.5.0         | 10.7.1          | [IP-Familien bei Subnetzprüfungen](https://github.com/advisories/GHSA-j6r3-76f7-8jcv), Diagnose-DoS und lokale IPv6-Bereiche                                                 |
| brace-expansion                         | 1.1.18 / 5.0.9 | 1.1.21 / 5.0.12 | [CPU-DoS](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr) und Rekursions-DoS; API-Zweige für minimatch getrennt halten                                                    |
| Next.js samt ESLint-Plugin, env und SWC | 16.3.3         | 16.3.6          | [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j): RCE bei bestimmten nicht vertrauenswürdigen SVG-Eingaben an die Node-ImageResponse-Implementierung |

Nodemailer 10 benötigt Node ab 20; die vorgegebene Node-24-Linie erfüllt das.
Die exakten Overrides erfassen Mailparsers Nodemailer-Kopie sowie die
Auth.js-Peer-Abhängigkeit. Der bestehende Peer-Kompatibilitätseintrag folgt
Nodemailer 10. Die neue Regression verwendet echte Bibliotheken ohne SMTP-
Versand: MIME mit Umlauten, HTML und binärem Anhang wird erzeugt und wieder
eingelesen; ein Kommentar hinter einem quotierten Empfänger darf nicht in die
Envelope-Adresse geraten. Gegen 9.1.1 schlug genau diese Sicherheitsregression
erwartungsgemäß fehl, während der normale MIME-Roundtrip bereits bestand.

pnpm 12.4.1 normalisiert beim Neuberechnen außerdem die Workspace-Importer auf
die bereits konfigurierte physische Injektion. `pg@8.22.0` war schon im
injizierten DB-Snapshot enthalten; der direkte Importer wird daran angeglichen,
die nicht mehr benötigten Einträge für 8.21.0 entfallen.

## Prüfung der Installations-Hooks

Die veröffentlichten Registry-Manifeste und die Paketarchive der sechs
ursprünglichen Fixstände wurden geprüft. Keiner dieser Stände enthält
`preinstall`, `install`, `postinstall` oder eine native `binding.gyp`-Datei.
Nodemailer, Undici, ip-address und brace-expansion 5 enthalten `prepare` für
Entwicklung beziehungsweise Veröffentlichung; dieser Hook läuft bei der
Installation ihrer Registry-Tarballs nicht. Sie benötigen keine Build-Freigabe.
Next.js 16.3.6 und seine aktualisierten Begleitpakete enthalten ebenfalls keine
Installations-Hooks.

Alle neuen Paketstände wurden spätestens am 22. September veröffentlicht und
erfüllen die siebentägige Mindestwartezeit. `allowBuilds` und dessen Soll-Liste
in `scripts/check-pnpm-supply-chain.sh` benötigen keine neue Entscheidung.
`strictDepBuilds: true`, `dangerouslyAllowAllBuilds: false`, die vorhandenen
versionsgebundenen Ausnahmen und der pnpm-Pin 12.4.1 bleiben bestehen.

## Technische Nachweise

Der finale Stand wird im isolierten Linux-Checkout `/audit/final` des lokalen
Prüfcontainers mit Node 24.18.0 und pnpm 12.4.1 geprüft. Vor der Installation
existierte dort kein `node_modules`; der separate Store
`/audit/pnpm-final-store-yc3Czy` war nachweislich leer. Der erfolgreiche Aufruf
lautete `pnpm install --frozen-lockfile --prod=false --store-dir <leerer Store>`
ohne `--ignore-scripts`. Die erlaubten Prisma-, esbuild- und msgpackr-Hooks
wurden ausgeführt. Das bestehende Quality-CI-Gate prüft denselben Fall mit
`--store-dir "$(mktemp -d)"`.

- Produktionsaudit auf Stufe `low`: keine bekannten Schwachstellen.
- Vollständiger Audit einschließlich Entwicklungsabhängigkeiten auf Stufe
  `low`: keine bekannten Schwachstellen.
- Prisma-Client-Generierung: bestanden.
- `pnpm lint`: bestanden, null Fehler und 66 Warnungen in unveränderten
  Quelldateien. Der integrierte Paranoid-Guard bestätigt 222 erkannte
  Playwright-Tests in 28 Specs und den vollständigen CI-Aufruf.
- `pnpm typecheck`: 22 von 22 Turbo-Aufgaben erfolgreich.
- `pnpm exec turbo run test --filter='!@taxtronik/db'`: 22 von 22 Aufgaben
  erfolgreich, einschließlich der neuen Nodemailer-Regression und aller
  Mail-/HTTP-/Worker-Tests. Im Web-Paket bestanden 3268 Tests; 20 bestehende
  DB-/Redis-Integrationstests sind ohne zugehörige Dienste übersprungen.
- `pnpm guard:supply-chain` und `pnpm test:ops`: bestanden.
- `pnpm fachkatalog:check`: 33 Tests bestanden, 81 Regeln gültig und aktuell.
- `pnpm fachkatalog:diff`: bestanden; keine Fachpfad-Änderungen.

Die vollständige Playwright-Ausführung und die datenbankgestützten
Integrationsjobs bleiben dem anschließenden CI-Lauf vorbehalten. Die
Playwright-Testerkennung ist kein bestandener E2E-Lauf. Es wird kein
Produktionsbuild oder Deployment aus diesem Prüfstand behauptet.
