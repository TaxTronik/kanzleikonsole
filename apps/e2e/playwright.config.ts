import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadRootEnv(): void {
  const envPath = resolve(__dirname, '../../.env');
  let raw = '';
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    process.env[key] ??= value;
  }
}

loadRootEnv();

function canonicalizeBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (url.hostname === '127.0.0.1') {
    url.hostname = 'localhost';
  }
  return url.toString().replace(/\/$/, '');
}

const BASE_URL = canonicalizeBaseUrl(process.env['E2E_BASE_URL'] ?? 'http://localhost:3000');
process.env['E2E_BASE_URL'] = BASE_URL;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,        // Auth-Tests sequenziell (nur 1 Admin-Account)
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
