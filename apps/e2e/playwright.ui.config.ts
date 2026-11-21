import { defineConfig, devices } from '@playwright/test';
import fullSuite from './playwright.config';

const desktop = { width: 1440, height: 960 };
const narrow = { width: 390, height: 844 };

export default defineConfig({
  ...fullSuite,
  testDir: './tests/ui',
  outputDir: './ui-contract/test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'ui-contract/playwright-report' }]],
  projects: [
    {
      name: 'chromium-utc',
      use: { ...devices['Desktop Chrome'], timezoneId: 'UTC', viewport: desktop },
    },
    {
      name: 'chromium-new-york',
      use: { ...devices['Desktop Chrome'], timezoneId: 'America/New_York', viewport: narrow },
    },
    {
      name: 'firefox-berlin',
      use: { ...devices['Desktop Firefox'], timezoneId: 'Europe/Berlin', viewport: desktop },
    },
    {
      name: 'firefox-new-york',
      use: { ...devices['Desktop Firefox'], timezoneId: 'America/New_York', viewport: narrow },
    },
  ],
});
