# Prüfberichte als Checklisten

1. Zu Beginn jedes Prüf- oder Änderungsauftrags die einschlägigen früheren
   Prüf- und Nachberichte lesen. Ihre Befunde, offenen Punkte und zugesagten
   Nachprüfungen in die aktuelle Checkliste übernehmen und die Herkunft
   verlinken. Bei Änderungen an einem früher behobenen Fehler dessen
   Regressionstest erneut ausführen.
   Bei einem begrenzten Auftrag ausdrücklich festhalten, welche Punkte offen bleiben.
2. Zu jedem Fehler seine Ursache benennen und nach weiteren betroffenen
   Einstiegspunkten suchen. Bei einer falschen Datumsvorgabe gehören dazu
   auch die Anlage aus der Mandantenakte, verknüpfte Vorgänge und Feldgrenzen
   wie Mindest- und Höchstdatum. Für jeden anwendbaren Fall den Sollwert aus
   der Fachregel oder dem bestätigten Produktverhalten ableiten.
3. Einen Punkt erst abhaken, wenn ein tatsächlich ausgeführter Test oder eine
   dokumentierte Bedienprobe den Sollwert am betroffenen Einstieg bestätigt.
   Vorbelegungen vor der ersten Eingabe prüfen. Bei Tagesgrenzen die Uhr auf
   einen Zeitpunkt stellen, an dem UTC und Kanzleizeit verschiedene Daten
   ergeben. Ein Test der Pflichtfeldvalidierung belegt nur die Validierung.
4. Vor Abschluss jeden übernommenen Punkt mit dem Bericht abgleichen.
   Abgehakte Punkte erhalten einen konkreten Nachweis und den geprüften
   Stand. Offene Punkte behalten den Grund und die ausstehende Prüfung.
   Solange ein anwendbarer Punkt offen ist, bleibt der betreffende Bereich offen.
   Ist ein ähnlich aussehender Fall ausgenommen, die abweichende Regel belegen.
   Spätere Ergebnisse als datierten Nachtrag verlinken, damit erkennbar bleibt,
   was im ursprünglichen Lauf bekannt und geprüft war.
   Die Checkliste unter `docs/reviews/` im Repository ablegen, damit die
   nächste Aufgabe Befunde, Belege und offene Fragen wiederfindet.

# Arbeitsregeln für fachliche Logik

Diese Regeln gelten für Änderungen an steuerlicher, rechtlicher,
compliance-relevanter oder kanzleifachlicher Workflow-Logik.

1. Vor einer Änderung die passenden Einträge in
   `docs/fachkatalog/fachkatalog.json` suchen und die vollständigen Regeldateien
   lesen.
2. Regel-ID(s) in Tests und in der Änderungsdokumentation nennen, soweit eine
   bestehende Regel betroffen ist.
3. Ändert sich fachliches Verhalten, müssen Regel, Umsetzungshinweise und
   Nachweise im selben Commit aktualisiert werden. Ein fehlender Eintrag wird
   als ungeprüfter Entwurf ergänzt.
4. Rechtsquellen, Norminhalte und Freigaben niemals erfinden. Konflikte zwischen
   Katalog, Code, Test und Dokumentation ausdrücklich melden, nicht still
   zugunsten einer Quelle auflösen.
5. KI-Werkzeuge dürfen `professional_review.status` niemals auf `approved`
   setzen und weder `reviewer` noch `reviewed_at` als fachlichen Nachweis
   ausfüllen oder `reviewed_content_hash` für eine Freigabe eintragen. Das ist
   ausschließlich eine dokumentierte Entscheidung eines Berufsträgers.
   Der Hash bindet Inhalte, authentifiziert aber keine Person.
6. Vor Abschluss `pnpm fachkatalog:check` und `pnpm fachkatalog:diff`
   ausführen.

Der Fachkatalog ersetzt weder die Einzelfallprüfung noch die organisatorische
Fristenkontrolle der Kanzlei. Bedienungs- oder Layoutänderungen ohne fachliche
Auswirkung benötigen keinen neuen Katalogeintrag.

# Arbeitsregeln für Abhängigkeiten und Deployment

1. Bei Änderungen an Abhängigkeiten oder pnpm die Installations-Hooks neuer
   und aktualisierter Pakete prüfen. Jede Entscheidung in `allowBuilds` in
   `pnpm-workspace.yaml` und der Soll-Liste in
   `scripts/check-pnpm-supply-chain.sh` gemeinsam dokumentieren. Nicht benötigte
   Hooks ausdrücklich mit `false` sperren; Entscheidungen möglichst an die
   geprüfte Version binden.
2. `strictDepBuilds: true` und `dangerouslyAllowAllBuilds: false` beibehalten.
   `ERR_PNPM_IGNORED_BUILDS` durch eine begründete Entscheidung zum konkreten
   Hook beheben. `--ignore-scripts`, pauschale Freigaben oder das Abschalten
   von `strictDepBuilds` sind dafür kein Ersatz.
3. Vor Abschluss einen frischen Linux-Installationslauf mit
   `pnpm install --frozen-lockfile --prod=false` ohne `--ignore-scripts`
   nachweisen, mit leerem `node_modules` und einem separaten, leeren pnpm-Store.
   Dafür einen isolierten Checkout oder Container verwenden. Bestehende lokale
   Abhängigkeiten nicht dafür löschen. Das Quality-CI-Gate muss denselben
   Installationsfall prüfen; ein gezieltes `pnpm rebuild` allein reicht nicht.
   Scheitert der Nachweis an externen Diensten, die konkrete Ursache und die
   noch offene CI-Prüfung ausdrücklich nennen; keinen erfolgreichen Build
   behaupten.
4. Den pnpm-Versionspin in `packageManager` (`package.json`; beide Dockerfiles
   beziehen ihn per Corepack), dem Host-Setup in `scripts/ops-lib.sh` sowie
   zugehörigen Guards und Tests synchron halten; ebenso die Node-Version in
   `.nvmrc` und `HOST_NODE_VERSION`.
   `pnpm guard:supply-chain`, `pnpm test:ops`, `pnpm fachkatalog:check` und
   `pnpm fachkatalog:diff` ausführen.

# Arbeitsregeln für Tests und CI

1. Der CI-Job `e2e-paranoid` führt die vollständige Playwright-Suite ohne
   Dateiliste oder Testfilter aus. Neue Specs unter `apps/e2e/tests` werden
   automatisch aufgenommen; keine zweite Spec-Liste im Workflow pflegen.
2. Vor Commit und Push `pnpm lint` im Repository-Root ausführen. Darin läuft
   auch `pnpm guard:paranoid-e2e`: Der Guard prüft den tatsächlichen CI-Aufruf,
   die Playwright-Testerkennung und unerlaubte Fokus-/Skip-Marker. Er braucht
   installierte Workspace-Abhängigkeiten, aber weder Browser noch laufende
   Dienste und funktioniert auch unter Windows ohne zusätzliche Shell.
3. Gezieltes ESLint für einzelne Dateien und isolierte Browsertests ersetzen
   diesen strukturellen Check nicht. Neue oder geänderte Tests zusätzlich
   passend zur Änderung ausführen. Ein erfolgreicher Discovery-Check ist kein
   bestandener E2E-Lauf; fehlende Dienste und offene CI-Prüfungen ausdrücklich
   nennen.

# Arbeitsregeln für den Changelog

1. Neue Änderungen ausschließlich unter `[Unreleased]` in die vorhandenen
   Kategorien `Hinzugefügt`, `Geändert`, `Behoben` oder `Sicherheit` einordnen.
   Keine zusätzlichen Abschnitte pro Task oder Commit anlegen.
2. Datierte Versionsabschnitte nur im tatsächlichen Release-Schritt erstellen.
   Weder die Version in `package.json` noch ein Entwicklungsdatum belegt eine
   Veröffentlichung. Vor einer Release-Zuordnung die Git-Tags prüfen.
3. Historische Kandidaten nicht als eigenständige Releases führen.
   Bei redaktioneller Neuordnung vorhandene Änderungen, Scope-Markierungen
   und Regelverweise erhalten.
