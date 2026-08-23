#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const IGNORED_SCHEMES = /^(?:https?:|mailto:|tel:|data:|javascript:)/i;
const SKIP_DIRS = new Set(['.git', '.next', 'node_modules', 'playwright-report', 'test-results']);

function markdownFiles(rootDir) {
  const result = [];
  const docsDir = join(rootDir, 'docs');

  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        result.push(join(dir, entry.name));
      }
    }
  }

  walk(docsDir);
  for (const name of ['README.md', 'FEATURES.md', 'CHANGELOG.md', 'SECURITY.md']) {
    const path = join(rootDir, name);
    if (existsSync(path)) result.push(path);
  }
  return result.sort();
}

function withoutFencedCode(markdown) {
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  return lines
    .map((line) => {
      const marker = line.match(/^\s*(```+|~~~+)/)?.[1];
      if (marker) {
        if (!fence) fence = marker[0];
        else if (marker[0] === fence) fence = null;
        return '';
      }
      return fence ? '' : line;
    })
    .join('\n');
}

function linkTargets(markdown) {
  const text = withoutFencedCode(markdown);
  const targets = [];
  const reference = /^\s*\[[^\]\n]+\]:\s*(\S+)/gm;
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('](', cursor);
    if (open === -1) break;
    const start = open + 2;
    if (text[start] === '<') {
      const close = text.indexOf('>', start + 1);
      if (close !== -1) targets.push(text.slice(start, close + 1).trim());
      cursor = close === -1 ? start + 1 : close + 1;
      continue;
    }

    let depth = 1;
    let escaped = false;
    let end = start;
    for (; end < text.length; end += 1) {
      const char = text[end];
      if (char === '\n') break;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth === 0) targets.push(text.slice(start, end).trim());
    cursor = end + 1;
  }

  let match;
  while ((match = reference.exec(text))) targets.push(match[1].trim());
  return targets;
}

function bareTarget(raw) {
  if (raw.startsWith('<')) {
    const end = raw.indexOf('>');
    return end === -1 ? raw : raw.slice(1, end);
  }
  return raw.split(/\s+["']/)[0];
}

function githubSlug(heading) {
  return heading
    .replace(/<[^>]*>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function markdownAnchors(path) {
  const anchors = new Set();
  const counts = new Map();
  const text = withoutFencedCode(readFileSync(path, 'utf8'));
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (heading) {
      const base = githubSlug(heading);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/gi)) {
      anchors.add(match[1]);
    }
  }
  return anchors;
}

function exactCaseExists(rootDir, target) {
  if (!existsSync(target)) return false;
  const rel = relative(rootDir, target);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return existsSync(target);

  let current = rootDir;
  for (const segment of rel.split(sep)) {
    const entries = readdirSync(current);
    if (!entries.includes(segment)) return false;
    current = join(current, segment);
  }
  return true;
}

export function checkDocLinks(rootDir) {
  const errors = [];
  const anchorCache = new Map();
  for (const source of markdownFiles(rootDir)) {
    const markdown = readFileSync(source, 'utf8');
    for (const raw of linkTargets(markdown)) {
      const target = bareTarget(raw);
      if (!target || IGNORED_SCHEMES.test(target) || target.startsWith('//')) continue;

      const hashAt = target.indexOf('#');
      const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
      const rawFragment = hashAt === -1 ? '' : target.slice(hashAt + 1);
      const queryFreePath = pathPart.split('?')[0];
      let decodedPath;
      let fragment;
      try {
        decodedPath = decodeURIComponent(queryFreePath);
        fragment = decodeURIComponent(rawFragment);
      } catch {
        errors.push(`${relative(rootDir, source)}: ungültiges URL-Encoding in „${target}“`);
        continue;
      }

      let resolved = decodedPath ? resolve(dirname(source), decodedPath) : source;
      if (!exactCaseExists(rootDir, resolved)) {
        errors.push(
          `${relative(rootDir, source)}: Ziel fehlt oder Groß-/Kleinschreibung weicht ab: „${target}“`,
        );
        continue;
      }

      if (statSync(resolved).isDirectory()) {
        const readme = join(resolved, 'README.md');
        if (fragment && exactCaseExists(rootDir, readme)) resolved = readme;
        else continue;
      }

      if (fragment && extname(resolved).toLowerCase() === '.md') {
        let anchors = anchorCache.get(resolved);
        if (!anchors) {
          anchors = markdownAnchors(resolved);
          anchorCache.set(resolved, anchors);
        }
        if (!anchors.has(fragment)) {
          errors.push(
            `${relative(rootDir, source)}: Anker fehlt in ${relative(rootDir, resolved)}: „#${fragment}“`,
          );
        }
      }
    }
  }
  return errors;
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = resolve(scriptDir, '..');
  const errors = checkDocLinks(rootDir);
  if (errors.length) {
    console.error(`Dokumentationslinks fehlerhaft (${errors.length}):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }
  console.log('Dokumentationslinks gültig.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
