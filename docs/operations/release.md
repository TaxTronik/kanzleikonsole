# Release- und Update-Prozess

Wie kommt ein Stand aus Git zum Kunden — und wie kommt man zurück, wenn etwas
schiefgeht?

## 1. Release erstellen (Vendor-Seite)

Das Release bildet einen durchgängigen Vertrag aus Tag-Commit, Web-Digest und
Worker-Digest. Die Betreiber-CLI löst Registry-Releases ausschließlich über das
gültig signierte Manifest auf und prüft die gezogenen Images gegen beide
Digests.

Releases sind Git-Tags nach SemVer (`vMAJOR.MINOR.PATCH`):

```bash
git tag -a v1.4.0 -m "Release 1.4.0"
git push forgejo v1.4.0
```

Der Tag-Push löst `.forgejo/workflows/release.yml` aus:

1. Verifiziert einen annotierten, strikten SemVer-Tag, den exakten Event-SHA
   und dass der Commit Bestandteil von `main` ist.
2. Ruft im selben Release-DAG die vollständigen Workflows `ci.yml` und
   `security.yml` auf genau diesem Tag-Commit auf. Damit sind Quality, DB/RLS,
   Backup→Restore, Upgrade-Pfad ab dem vorherigen Tag, Smoke- und Paranoid-E2E,
   KoSIT-XRechnung, Deploy-Readiness, Dependency-Audit und Gitleaks zwingende
   Promotion-Gates.
3. Baut erst danach `web` + `worker` mit `APP_VERSION=1.4.0` und dem Commit-SHA als
   Build-Args (sichtbar in Admin-UI und `/api/health/detail`).
4. Trivy-Scan: CRITICAL-CVEs mit verfügbarem Fix brechen das Release ab,
   HIGH wird rapportiert.
5. Push in die Forgejo-Container-Registry:
   `git.hirschmann-koxha.de/taxtronik/web:1.4.0` und
   `git.hirschmann-koxha.de/taxtronik/worker:1.4.0`. Ein veränderbares
   `:latest` wird bewusst nicht als Release- oder Deployment-Vertrag
   publiziert.
6. Ermittelt die Registry-Digests beider Images und publiziert erst danach das
   signierte Manifest mit Tag-Commit, Web-Digest und Worker-Digest.

Der Image-Job besitzt die harte Abhängigkeit
`needs: [preflight, full-ci, security-gate]` und hat keinen
`if`-/`continue-on-error`-Bypass. Schlägt irgendeine Prüfung fehl oder passt
Tag, Checkout, Event-SHA beziehungsweise `main`-Historie nicht exakt, werden
weder Images gebaut noch Registry-Tags gepusht. Der Build-Job prüft den Tag-SHA
vor dem Image-Build ein zweites Mal. Die Promotion verlässt sich nicht auf eine
Status-API oder einen älteren Workflow-Lauf, sondern führt die unveränderten
normalen CI-/Security-Workflows im selben Tag-Lauf erneut aus.

**Verbleibende Betriebsgrenze:** Registry-Push und Manifest-Publikation sind
keine gemeinsame Transaktion. Scheitert der Worker-Push nach einem erfolgreichen
Web-Push oder scheitert anschließend das Manifest-Repo, können bereits
hochgeladene SemVer-Images beziehungsweise -Tags in der Registry zurückbleiben.
Ohne gültig publiziertes Manifest gelten sie im verifizierten Update-Pfad
**nicht als promotet** und werden von der Operator-CLI nicht als Release
aufgelöst. Weil Versions-Tags absichtlich write-once sind, muss das Release-Team
solche Teilpublikationen vor einem erneuten Lauf prüfen und gegebenenfalls
manuell bereinigen; Registry-Retention und Garbage Collection sind ein eigener
Betreiberprozess.

Vor dem ersten echten Produkt-Release und vor größeren Releases wird zusätzlich
das [Release-Rehearsal](release-rehearsal.md) auf einem frischen
Wegwerf-System durchgeführt.

**Einmaliges Forgejo-Setup:** Actions-Runner mit Docker-Zugriff (existiert für
build-images.yml bereits). Falls der Actions-Auto-Token keine Pakete schreiben
darf, einen PAT mit `write:package` als Secrets `REGISTRY_USER` +
`REGISTRY_TOKEN` im Repo hinterlegen. Optional Repo-Variable `REGISTRY`, wenn
der Registry-Host von der Instanz-URL abweicht. Zusätzlich Release-Tags mit dem
Muster `v*` schützen und ihre Erstellung auf das Release-Team begrenzen; der
Promotion-Job selbst erhält nur `contents: read`, erst der nachgelagerte
Image-Job bekommt `packages: write`.

## 2. Update einspielen (Betreiber-Seite)

In der `.env` des Servers einmalig den Registry-Modus aktivieren und pro
Update die Version pinnen:

```ini
TAXTRONIK_IMAGE_PREFIX=git.hirschmann-koxha.de/taxtronik
TAXTRONIK_VERSION=1.4.0
```

Dann:

```bash
./taxtronik update
```

Im Registry-Modus löst die CLI die Zielversion zunächst aus dem signierten
Manifest auf. Web und Worker werden anschließend als getrennte
`image:tag@sha256:…`-Referenzen gezogen; Versions- und Revision-Label müssen zum
Manifest passen. Die Digest-Suffixe werden von der CLI verwaltet und dürfen
nicht von Hand auf einen bloßen Versions-Tag zurückgesetzt werden.

Das Skript erstellt zuerst ein verpflichtendes Datenbank-Backup vollständig
mit dem **bisher installierten Checkout und Prisma-Client**. Erst wenn dieses
Backup erfolgreich abgeschlossen ist, führt es `git fetch` und den
`git merge --ff-only` aus. Ein Backup-Fehler lässt Code und Arbeitsbaum
unverändert. Danach vervollständigt es die Konfiguration aus dem neuen Stand,
baut oder zieht Images, migriert über den One-Shot-`migrate`-Container und
startet App/Worker/n8n neu. Die Images werden gepullt, **bevor** die alten
Container stoppen — die Downtime ist der reine Container-Neustart.

Private Registry: einmalig `docker login git.hirschmann-koxha.de` auf dem
Server (Token mit `read:package` genügt).

Ohne Registry-Zugriff (`TAXTRONIK_IMAGE_PREFIX` ohne Slash bzw. ungesetzt)
baut `./taxtronik deploy`/`update` lokal aus dem Checkout — dann braucht
der Server weiterhin die Build-Toolchain, und es läuft nicht das in CI
getestete Artefakt. Nach erfolgreichen lokalen Builds löscht die Operator-CLI
ungenutzten Docker-BuildKit-Cache älter als 7 Tage (`until=168h`), damit der
Server nicht langsam volläuft. Steuerung: `TAXTRONIK_BUILD_CACHE_PRUNE=off`
oder `TAXTRONIK_BUILD_CACHE_PRUNE_UNTIL=336h`.

### 2.1 Erstinstallation: Provisionierung (ohne Demodaten)

Eine frische Produktiv-Installation enthält nach den Migrationen **keinerlei
Daten** — der Dev-Seed (Demomandant, Beispieldaten) verweigert bei
`NODE_ENV=production` bewusst den Dienst. Die Grundausstattung (Kanzlei-Tenant,
Default-Dokumenttypen, ein Admin-Konto) legt das Provisionierungs-Skript an:

```bash
TENANT_NAME="Kanzlei Müller" ADMIN_EMAIL="admin@kanzlei-mueller.de" \
  pnpm --filter @taxtronik/db provision
```

Optional: `TENANT_SLUG` (Login-Feld „Kanzlei", Default `default`) und
`ADMIN_PASSWORD` (sonst zufällig generiert, einmalig angezeigt und in
`.admin-credentials.txt` abgelegt — nach Erstlogin + TOTP-Setup löschen).
Das Skript ist gegen Doppelausführung geschützt: Hat der Tenant bereits
Mitarbeiter, bricht es ab und verändert nichts.

## 3. Rollback

**App-Rollback (keine neuen Migrationen seit dem letzten Update):**
`./taxtronik rollback` verwendet den vollständigen vorherigen Last-Good-Vertrag
aus `.taxtronik.state` (Version, Commit sowie Web- und Worker-Digest) und startet
App/Worker neu. Bei einem explizit angegebenen anderen Ziel löst die CLI dessen
signiertes Manifest erneut auf. Ein bloßes manuelles Zurücksetzen des
Versions-Tags ist im Registry-Modus kein gültiger Rollback-Vertrag.

**Rollback über Migrationen hinweg:** Prisma-Migrationen sind forward-only.
`./taxtronik deploy`/`update` legen deshalb **vor** jeder Migration ein Backup an.
Pfad zurück: Backup einspielen (siehe
[disaster-recovery.md](disaster-recovery.md), Abschnitt 9), dann im
Registry-Modus `./taxtronik rollback <vorherige-version>` ausführen. Dieser Pfad
löst den signierten früheren Image-Vertrag auf und startet bewusst **keine**
Migration. Im Lokalbuild-Modus müssen die früheren Images bereits vorhanden
sein oder aus dem exakten früheren Checkout gebaut werden. Achtung: Daten, die
nach dem Backup entstanden sind, gehen dabei verloren — Rollback über
Migrationen ist die letzte Option, nicht der Standardweg.

## 4. Migrations-Konvention: Expand/Contract

Damit App-Rollbacks (der häufige Fall) ohne DB-Restore möglich bleiben,
sollten destruktive Schema-Änderungen nie im selben Release passieren wie der
Code, der sie erzwingt:

- **Expand (Release N):** Neue Spalten/Tabellen anlegen, alte parallel
  weiterbedienen. Spalten nullable oder mit Default einführen.
- **Contract (Release N+1 oder später):** Alte Spalten/Tabellen erst
  entfernen, wenn kein unterstützter Rollback-Stand sie mehr liest.

Konkret: Nach einem Update auf `1.5.0` muss die Datenbank von `1.5.0` noch
mit dem Image `1.4.x` funktionieren. Der CI-Job `upgrade-path` testet die
Hinrichtung (alter Migrationsstand → HEAD); die Rückwärts-Verträglichkeit ist
Review-Disziplin beim Schreiben der Migration.

## 5. Update-Benachrichtigung (signiertes Manifest)

Jedes Release publiziert zusätzlich ein **Ed25519-signiertes Update-Manifest**
(`manifest.json` + detached `manifest.json.sig`). Installationen mit
konfiguriertem `UPDATE_MANIFEST_URL` + `UPDATE_PUBLIC_KEY` zeigen dann in der
Admin-UI „Update verfügbar" — inklusive Release-Notes (Tag-Annotation) und
`migrationsRequired` (automatisch aus dem Migrations-Diff zum Vortag-Release).
Die Signaturprüfung ist fail-closed: ohne gültige Signatur wird kein Update
angezeigt. Es gibt bewusst **kein Auto-Update** — einspielen bleibt
`./taxtronik update`.

**Einmaliges Vendor-Setup:**

1. Schlüsselpaar erzeugen: `node scripts/release/generate-update-key.mjs`
   - privater Schlüssel → Forgejo-Repo-Secret `UPDATE_MANIFEST_PRIVATE_KEY`
   - öffentlicher Schlüssel → an Kunden verteilen (`UPDATE_PUBLIC_KEY`)
2. **Öffentliches** Repo für das Manifest anlegen (z. B. `TaxTronik/updates`),
   Schreib-Token als Secret `UPDATE_MANIFEST_TOKEN`, Repo-URL als Variable
   `UPDATE_MANIFEST_REPO`. Alle drei Werte sind Release-Pflicht: Der Preflight
   validiert URL und Ed25519-Key, klont das Ziel und prüft das Schreibrecht per
   `git push --dry-run`. Fehlt ein Wert oder ist das Ziel nicht beschreibbar,
   starten weder die teuren Gates noch der Image-Build.
3. Kunden-.env: `UPDATE_MANIFEST_URL` auf die Raw-URL des Manifests +
   `UPDATE_PUBLIC_KEY` setzen (siehe `.env.example`).

Release-Tags **müssen annotiert sein**; Lightweight-Tags blockiert das
Promotion-Gate. Die Annotation wird zugleich als Release-Note verwendet:
`git tag -a v1.4.0 -m "Kurzbeschreibung fürs Admin-Panel"`.

Das Manifest-Schema bindet den Commit-SHA sowie Web- und Worker-Image jeweils
an einen SHA-256-Digest. Der Manifest-Job ist nicht optional und macht den
Release-Lauf bei einem Publikationsfehler rot. Da Registry und Manifest-Repo
zwei getrennte Systeme sind, können Images in diesem Fehlerfall bereits in der
Registry liegen; sie gelten ohne erfolgreich publiziertes Manifest nicht als
freigegeben. Vor dem Wiederholen müssen vorhandene Teilpublikationen wie in
Abschnitt 1 beschrieben geprüft und gegebenenfalls bereinigt werden.

## 6. Welcher Stand läuft gerade?

- Admin-UI zeigt `APP_VERSION` (Seite „Administration").
- `/api/health/detail` (admin-gated) liefert `version.app` + `version.commit`.
- `docker image inspect` zeigt die OCI-Labels
  (`org.opencontainers.image.version` / `.revision`).
