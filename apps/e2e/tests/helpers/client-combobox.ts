import { expect, type Locator, type Page } from '@playwright/test';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Wählt einen Mandanten in der ClientCombobox (Serversuche statt <select>):
 * Namen tippen, die Option zum Namen anklicken und warten, bis die Auswahl
 * übernommen und die Liste geschlossen ist. Die Mandanten-ID steht danach im
 * versteckten Formularfeld der Komponente.
 */
export async function chooseClient(
  scope: Page | Locator,
  combobox: Locator,
  name: string,
): Promise<void> {
  await combobox.fill(name);
  const option = scope.getByRole('option', { name: new RegExp(`^${escapeRegExp(name)}`) }).first();
  await expect(option, `Mandant ${name} muss in der Serversuche erscheinen`).toBeVisible();
  await option.click();
  await expect(combobox).toHaveValue(name);
  await expect(combobox).toHaveAttribute('aria-expanded', 'false');
}
