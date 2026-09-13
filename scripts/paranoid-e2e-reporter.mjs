// --list only collects tests: this reporter does not run browsers or services.
// Preserve RegExp metadata, which Playwright's standard JSON reporter drops.
export default class ParanoidDiscoveryReporter {
  errors = [];

  onBegin(config, suite) {
    this.report = {
      config: {
        rootDir: config.rootDir,
        forbidOnly: config.forbidOnly,
        shard: config.shard,
        maxFailures: config.maxFailures,
        projects: config.projects.map((project) => ({
          name: project.name,
          testDir: project.testDir,
          testMatch: project.testMatch,
          testIgnore: project.testIgnore,
          grep: project.grep,
          grepInvert: project.grepInvert,
        })),
      },
      tests: suite.allTests().map((test) => ({
        file: test.location.file,
        title: test.title,
        project: test.parent.project()?.name,
        expectedStatus: test.expectedStatus,
        annotations: test.annotations,
      })),
    };
  }

  onError(error) {
    this.errors.push(error.message ?? String(error));
  }

  onEnd() {
    process.stdout.write(
      JSON.stringify({ ...this.report, errors: this.errors }, (_key, value) =>
        value instanceof RegExp ? { source: value.source, flags: value.flags } : value,
      ),
    );
  }
}
