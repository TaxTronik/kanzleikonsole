import { URLSearchParams } from 'node:url';

// NVD prüft die exakte CPE gegen seine Versionsbereiche. Die Antwort kann
// auch CVEs für ClamAV in Verbindung mit einer bestimmten Appliance enthalten.
const cpePrefix = 'cpe:2.3:a:clamav:clamav:';
const stableTag = /^clamav-(\d+\.\d+)\.(\d+)$/;

export function nvdUrl(version) {
  const cpe = cpePrefix + version + ':*:*:*:*:*:*:*';
  return (
    'https://services.nvd.nist.gov/rest/json/cves/2.0?' +
    new URLSearchParams({ cpeName: cpe, resultsPerPage: '2000' }) +
    '&isVulnerable'
  );
}

function compare(left, right) {
  if (!/^\d+(?:\.\d+){1,2}$/.test(right)) return NaN;
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - (b[2] ?? 0);
}

function matchesEngine(match, actual) {
  if (typeof match?.vulnerable !== 'boolean' || typeof match.criteria !== 'string')
    throw new Error('Unvollständiges NVD-CPE-Kriterium');
  if (match.vulnerable !== true || !match.criteria.startsWith(cpePrefix)) return false;
  const [version, update, edition, language, swEdition, sw, hw, other] = match.criteria
    .slice(cpePrefix.length)
    .split(':');
  if (
    ![update, edition, language, swEdition, other].every((v) => ['*', '-'].includes(v)) ||
    !['*', '-', 'linux'].includes(sw) ||
    !['*', '-', 'x86_64', 'amd64'].includes(hw)
  )
    return false;
  return (
    (version === '*' || compare(actual, version) === 0) &&
    (!match.versionStartIncluding || compare(actual, match.versionStartIncluding) >= 0) &&
    (!match.versionStartExcluding || compare(actual, match.versionStartExcluding) > 0) &&
    (!match.versionEndIncluding || compare(actual, match.versionEndIncluding) <= 0) &&
    (!match.versionEndExcluding || compare(actual, match.versionEndExcluding) < 0)
  );
}

// Nur eine hinreichende Kombination aus passenden, positiven Engine-Kriterien
// blockiert. Zusätzliche Produkt- oder Betriebsbedingungen bleiben im Bericht.
function combines(entry, values) {
  if (
    !values.length ||
    (entry.negate !== undefined && typeof entry.negate !== 'boolean') ||
    !['OR', 'AND', undefined].includes(entry.operator) ||
    (entry.operator === undefined && values.length !== 1)
  ) {
    throw new Error('Unvollständige NVD-Konfiguration');
  }
  if (entry.negate) return false;
  return entry.operator === 'AND' ? values.every(Boolean) : values.some(Boolean);
}

export function applyAdvisories(engine, feed, nvd) {
  if (
    nvd.version !== '2.0' ||
    !Number.isFinite(Date.parse(nvd.timestamp)) ||
    nvd.startIndex !== 0 ||
    !Array.isArray(nvd.vulnerabilities) ||
    nvd.vulnerabilities.length !== nvd.totalResults
  ) {
    throw new Error('Unvollständige NVD-Antwort für die installierte ClamAV-Engine');
  }
  const affected = [];
  const conditional = [];
  for (const { cve } of nvd.vulnerabilities) {
    if (!/^CVE-\d{4}-\d{4,}$/.test(cve.id) || !cve.configurations?.length)
      throw new Error('NVD-Treffer ohne auswertbare Konfiguration');
    const applicable = cve.configurations.filter((config) =>
      combines(
        config,
        config.nodes.map((node) =>
          combines(
            node,
            node.cpeMatch.map((match) => matchesEngine(match, engine.actual)),
          ),
        ),
      ),
    );
    if (applicable.length) affected.push({ cve: cve.id, configurations: applicable });
    else conditional.push({ cve: cve.id, configurations: cve.configurations });
  }

  const series = engine.actual.split('.').slice(0, 2).join('.');
  const stable = feed.filter(
    (r) => r.draft === false && r.prerelease === false && stableTag.test(r.tag_name),
  );
  const first = stable.find((r) => r.tag_name === `clamav-${series}.0`);
  const published = first ? Date.parse(first.published_at) : -Infinity;
  if (Number.isNaN(published))
    throw new Error('Veröffentlichungsdatum der installierten ClamAV-Linie fehlt');
  const ownCves = new Set(affected.map(({ cve }) => cve));
  const foreign = [];
  for (const release of stable) {
    const ownSeries = stableTag.exec(release.tag_name)[1] === series;
    if (!ownSeries) {
      const date = Date.parse(release.published_at);
      if (!Number.isFinite(date))
        throw new Error('ClamAV-Sicherheitsrelease ohne Veröffentlichungsdatum');
      if (date < published) continue;
    }
    if (typeof release.body !== 'string' || !release.body.trim())
      throw new Error(`Fehlender Herstellerhinweis für ${release.tag_name}`);
    const ids = [...new Set(release.body.match(/\bCVE-\d{4}-\d{4,}\b/g) ?? [])];
    if (!ids.length) continue;
    if (ownSeries) {
      for (const id of ids) ownCves.add(id);
    } else {
      foreign.push({ tag: release.tag_name, ids });
    }
  }
  const crossLineReview = foreign.flatMap(({ tag, ids }) => {
    const cves = ids.filter((id) => !ownCves.has(id));
    return cves.length ? [{ tag, cves }] : [];
  });
  return {
    ...engine,
    status: affected.length && engine.status === 'passed' ? 'vulnerable' : engine.status,
    nvd: { source: nvdUrl(engine.actual), timestamp: nvd.timestamp, affected, conditional },
    crossLineReview,
  };
}
