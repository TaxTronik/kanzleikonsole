# Release- und Update-Prozess

Wie kommt ein Stand aus Git zum Kunden — und wie kommt man zurück, wenn etwas
schiefgeht?

## 1. Release erstellen (Vendor-Seite)

Releases sind Git-Tags nach SemVer (`vMAJOR.MINOR.PATCH`):

```bash
git tag v1.4.0
git push forgejo v1.4.0
```

Der Tag-Push löst `.forgejo/workflows/release.yml` aus:

1. Baut `web` + `worker` mit `APP_VERSION=1.4.0` und dem Commit-SHA als
   Build-Args (sichtbar in Admin-UI und `/api/health/detail`).
2. Trivy-Scan: CRITICAL-CVEs mit verfügbarem Fix brechen das Release ab,
   HIGH wird rapportiert.
3. Push in die Forgejo-Container-Registry:
   `git.hirschmann-koxha.de/taxtronik/web:1.4.0` (+ `:latest`, analog
   `worker`).

Vorher sollte der normale CI-Lauf (Quality, DB, Restore-Roundtrip,
Upgrade-Pfad, E2E) auf dem getaggten Commit grün sein — taggen heißt
freigeben.

**Einmaliges Forgejo-Setup:** Actions-Runner mit Docker-Zugriff (existiert für
build-images.yml bereits). Falls der Actions-Auto-Token keine Pakete schreiben
darf, einen PAT mit `write:package` als Secrets `REGISTRY_USER` +
`REGISTRY_TOKEN` im Repo hinterlegen. Optional Repo-Variable `REGISTRY`, wenn
der Registry-Host von der Instanz-URL abweicht.

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

Das Skript zieht Code (`git ff-only`) und Images, macht ein Backup, migriert
über den One-Shot-`migrate`-Container und startet App/Worker/n8n neu. Die
Images werden gepullt, **bevor** die alten Container stoppen — die Downtime
ist der reine Container-Neustart.

Private Registry: einmalig `docker login git.hirschmann-koxha.de` auf dem
Server (Token mit `read:package` genügt).

Ohne Registry-Zugriff (`TAXTRONIK_IMAGE_PREFIX` ohne Slash bzw. ungesetzt)
baut `./taxtronik deploy`/`update` lokal aus dem Checkout — dann braucht
der Server weiterhin die Build-Toolchain, und es läuft nicht das in CI
getestete Artefakt.

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
`./taxtronik rollback` (setzt `TAXTRONIK_VERSION` auf den vorherigen Stand aus
`.taxtronik.state` zurück und startet App/Worker neu). Alternativ den Tag in der
`.env` von Hand pinnen und `./taxtronik deploy`. Da Images versioniert in der
Registry liegen, ist das ein reiner Re-Pin.

**Rollback über Migrationen hinweg:** Prisma-Migrationen sind forward-only.
`./taxtronik deploy`/`update` legen deshalb **vor** jeder Migration ein Backup an.
Pfad zurück: Backup einspielen (siehe
[disaster-recovery.md](disaster-recovery.md), Abschnitt 9), dann den
vorherigen Tag pinnen und `./taxtronik deploy`. Achtung: Daten, die nach dem
Backup entstanden sind, gehen dabei verloren — Rollback über Migrationen ist
die letzte Option, nicht der Standardweg.

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
   `UPDATE_MANIFEST_REPO`. Solange die Variable fehlt, überspringt die
   Pipeline den Manifest-Job.
3. Kunden-.env: `UPDATE_MANIFEST_URL` auf die Raw-URL des Manifests +
   `UPDATE_PUBLIC_KEY` setzen (siehe `.env.example`).

Release-Notes pflegen heißt: **annotierte Tags** verwenden —
`git tag -a v1.4.0 -m "Kurzbeschreibung fürs Admin-Panel"`.

## 6. Welcher Stand läuft gerade?

- Admin-UI zeigt `APP_VERSION` (Seite „Administration").
- `/api/health/detail` (admin-gated) liefert `version.app` + `version.commit`.
- `docker image inspect` zeigt die OCI-Labels
  (`org.opencontainers.image.version` / `.revision`).
