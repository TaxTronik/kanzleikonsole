# Dependency-Audit 4230

Technischer Prüfstand: 5. November 2026, Ausgangscommit `05568c4d`.
Keine fachliche Freigabe und keine Änderung an fachlicher Workflow-Logik.

## Befunde und Fixstände

Der Log `security-Dependency Audit-4230.log` (geplanter Lauf vom 4. November)
meldet im blockierenden Produktionsaudit 19 Schwachstellen, sechs hohe, elf
mittlere und zwei niedrige. Der nicht blockierende Gesamtaudit meldet zusätzlich
minimatch, zusammen 20. Alle Befunde stammen aus neuen Advisories, nicht aus
geänderten Abhängigkeiten.

| Paket                                        | Bisher          | Fixstand        | Pfad                                                  | Advisories                                                                                                                                                                           |
| -------------------------------------------- | --------------- | --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Undici                                       | 8.11.2          | 8.12.3          | `@taxtronik/http-utils` (`safeFetch`), jsdom in Tests | hoch: GHSA-2m5v-pch6-74hx, GHSA-4w7w-5xrc-9h26, GHSA-qrxm-fqhp-jwvm, GHSA-xjj6-f33q-929c; mittel: GHSA-4qv8-2p9j-2685, GHSA-55wc-3pg8-jfw6, GHSA-9fm3-97px-rjf6, GHSA-f72v-6w45-q472 |
| zod                                          | 4.4.3           | 4.6.7           | Web und Pakete, Eingabevalidierung                    | hoch: [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)                                                                                                       |
| `@azure/msal-node` samt `@azure/msal-common` | 5.6.0 / 16.13.0 | 7.1.2 / 16.15.0 | `@taxtronik/mail`, Microsoft-365-Postfach             | hoch: [GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5)                                                                                                       |
| Nodemailer                                   | 10.0.10         | 10.2.1          | Worker, Mail, Mailparser, Auth.js                     | mittel: GHSA-85x2-q946-cp5h, GHSA-8c8m-p3m8-cjg8, GHSA-m943-m63m-w62w, GHSA-g73g-hqqh-jr95, GHSA-4ffr-jq9g-5ffx                                                                      |
| fast-uri                                     | 3.1.8           | 3.1.9           | Prisma über `@prisma/streams-local` und ajv           | mittel: GHSA-w74x-v6f9-j3xg, GHSA-wjr9-j795-jxcr; niedrig: GHSA-xhq7-xmqj-769h, GHSA-333x-w4r6-6crp                                                                                  |
| minimatch                                    | 10.2.5          | 11.0.3          | nur Entwicklung, ESLint und typescript-estree         | mittel: [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)                                                                                                     |

Undici und Nodemailer sind wie bisher exakt gepinnt und als Override auch
transitiv erzwungen, fast-uri als exakter Override. zod bekommt einen Bereichs-
Override (`^4.6.7`), weil sonst `eslint-plugin-react-hooks` die alte Kopie hält;
die Manifeste verwenden denselben Bereich. Ein `pnpm dedupe` hätte weitere,
vom Audit nicht betroffene Pakete verschoben und wurde deshalb nicht verwendet.
Der Lockfile ändert sich nur für die genannten Pakete, `zod-validation-error`
(Peer-Suffix) und `@isaacs/nonrecursive-glob-match` als einzige neue Abhängigkeit.
pnpm berechnet außerdem das Peer-Suffix von `@prisma/client` neu; die Version und
die eine installierte Prisma-Kopie bleiben.

## Einordnung

**Nodemailer:** Die Lücke war real erreichbar. Mit 10.0.10 ging die Envelope von
`Victim (x(y) <evil@evil.example>) <v@victim.example>` tatsächlich an
`evil@evil.example`. `nodemailer-compat.test.ts` prüft nun ausgehende Envelope und
eingehenden Mailparser-Absender; gegen 10.0.10 scheiterten alle fünf neuen
Regressionen. Für den SMTP-DoS (GHSA-4ffr-jq9g-5ffx) gibt es bewusst keinen
Zeittest; er ist nur über den Versionsstand abgedeckt. 10.3.x lag beim Prüfstand
noch innerhalb der siebentägigen Mindestreife, 10.2.1 enthält alle Fixes.

**MSAL:** Der einzige Major-Sprung; die Advisory nennt erst 7.1.0 als Fixstand. Die
Migrationsleitfäden zu v6 und v7 betreffen nur `acquireTokenInteractive` und den
Loopback-Server öffentlicher Clients; Confidential-Client und `getAuthCodeUrl`
bleiben laut v7-Leitfaden unverändert. Die OAuth-Route übergibt nur `code`,
`codeVerifier`, `scopes` und `redirectUri` und keinen Auth-Code-Payload, was dem
Workaround der Advisory entspricht. Der neue `msal-compat.test.ts` (`MAIL-INBOX-001`)
ersetzt nur den Netzwerk-Client und lief gegen 5.6.0 und 7.1.2 gleich: Der von
5.6.0 geschriebene Cache liefert Konto und Token, Refresh und PKCE-Codefluss
bleiben, die Antwort kommt weiter per Query am GET-Callback an. Die reale
Microsoft-365-Abnahme ist damit weiterhin nicht erbracht.

**Undici:** `safeFetch` übergibt dem Agent nur den gepinnten `connect.lookup`,
keine TLS-Optionen. Die bestehenden Tests ersetzen undici vollständig, deshalb
prüft `safe-fetch-transport.test.ts` Pinning, Redirect-Sperre und SSRF-Abweisung
nun über eine echte Verbindung gegen einen lokalen Server.

**minimatch:** Nur Entwicklung und nicht blockierend. Die Muster stammen aus dem
Repository, ein Angriffsweg besteht hier nicht. Der Override liegt außerhalb der
von ESLint und typescript-estree erlaubten `^10`; auch ESLint 10.14 erlaubt 11
noch nicht. ESLint nutzt nur `Minimatch`/`.match`, typescript-estree `minimatch()`,
keine der in 11 entfernten APIs. Der Override ist vertretbar, weil ein Fehler
sofort im Lint sichtbar wird; der Vergleich unten belegt gleiche Ergebnisse.
minimatch@3 (`eslint-plugin-jsx-a11y`, eslintrc) liegt außerhalb des betroffenen
Bereichs und bleibt getrennt.

## Prüfung der Installations-Hooks und der Mindestwartezeit

Die installierten Manifeste aller neuen Stände enthalten weder `preinstall`,
`install` noch `postinstall`, und keines der Pakete enthält eine `binding.gyp`.
Undici, Nodemailer, minimatch und `@isaacs/nonrecursive-glob-match` haben nur
`prepare`, das bei der Installation von Registry-Tarballs nicht läuft. `allowBuilds`
und seine Soll-Liste in `scripts/check-pnpm-supply-chain.sh` brauchen keine neue
Entscheidung; `strictDepBuilds: true`, `dangerouslyAllowAllBuilds: false` und der
pnpm-Pin 12.14.0 bleiben.

Alle neuen Stände erfüllen die Mindestwartezeit, es gibt keine neue Ausnahme. Am
knappsten sind minimatch 11.0.3 und `@isaacs/nonrecursive-glob-match` 1.0.3 vom 28. Oktober, gefolgt von MSAL 7.1.2 und `msal-common` 16.15.0 vom 27. Oktober.
Provenance bleibt bei Undici, zod und Nodemailer erhalten und kommt bei fast-uri
hinzu; MSAL und minimatch haben wie ihre Vorgängerstände keine, die
`no-downgrade`-Trust-Policy lässt die Installation zu.

## Technische Nachweise

Geprüft im isolierten Linux-Klon (WSL Ubuntu) mit Node 24.22.1, pnpm 12.14.0 und
dem Env-Block aus `.forgejo/workflows/ci.yml`. Vor der Installation existierte dort
kein `node_modules`, der separate Store war leer.

- `pnpm install --frozen-lockfile --prod=false --store-dir <leerer Store>` ohne
  `--ignore-scripts`: bestanden, 946 Pakete. Die erlaubten Hooks von Prisma,
  esbuild und msgpackr-extract liefen. Das Quality-CI-Gate prüft denselben Fall.
- `pnpm audit --prod --audit-level high` und `pnpm audit --audit-level low`: keine
  bekannten Schwachstellen.
- `pnpm lint`: bestanden. Der Paranoid-Guard bestätigt 236 erkannte
  Playwright-Tests in 30 Specs und den vollständigen CI-Aufruf; das ist kein
  bestandener E2E-Lauf.
- ESLint-Vergleich vor und nach minimatch 11 (Windows): dieselben 2736 Dateien plus
  genau die zwei neuen Tests, jeweils null Fehler und null Warnungen.
- `pnpm typecheck`: 19 von 19 Turbo-Aufgaben.
- `pnpm exec turbo run test --filter='!@taxtronik/db'`: 16 von 16 Aufgaben, 8557
  Tests bestanden, darunter 6560 im Web-Paket; dort 42 ohne Dienste übersprungen.
- `pnpm test:ops`: bestanden. WSL verlangt für `sudo` ein Passwort, die CI nicht;
  `sudo` war deshalb durch einen Stub ersetzt. Das betrifft nur
  `ci-apt.test.sh`, das `apt-get` ohnehin durch eine Attrappe ersetzt.
- `pnpm guard:supply-chain`, `pnpm format:check`, `pnpm docs:check` und
  Prisma-Client-Generierung: bestanden.
- `pnpm fachkatalog:check`: 34 Tests, 86 Regeln gültig und aktuell.
  `pnpm fachkatalog:diff`: bestanden, keine Fachpfad-Änderungen. Der
  `MAIL-INBOX-001`-Eintrag erhält nur den neuen Testverweis und einen technischen
  Nachweis; die Regel und ihr Prüfstatus bleiben unverändert.
- Docker-Builds von `infra/docker/Dockerfile.web` und `Dockerfile.worker` aus dem
  sauberen Git-Stand des Klons: bestanden. Das Worker-Image enthält undici 8.12.3,
  zod 4.6.7, Nodemailer 10.2.1, fast-uri 3.1.9 und MSAL 7.1.2, aber kein minimatch.
  Das Web-Image bündelt MSAL 7.1.2. Die Images wurden nur lokal gebaut, weder
  veröffentlicht noch gestartet.
- TLS-Probe mit der Agent-Konfiguration von `safeFetch` gegen ein selbstsigniertes
  Zertifikat: abgewiesen mit `DEPTH_ZERO_SELF_SIGNED_CERT`.

Nicht nachgewiesen und dem anschließenden CI-Lauf vorbehalten sind die
vollständige Playwright-Suite und die datenbankgestützten Integrationsjobs. Die
Live-Abnahme mit Microsoft 365 aus `MAIL-INBOX-001` bleibt offen. Ein Deployment
wird aus diesem Prüfstand nicht behauptet.
