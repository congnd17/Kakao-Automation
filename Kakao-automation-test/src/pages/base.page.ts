import { Page, Locator, test, expect } from '@playwright/test';
import { logger } from '@utils/logger';

export class BasePage {
  constructor(protected readonly page: Page) {}

  async goto(path = '/'): Promise<void> {
    await test.step(`Open page ${path}`, async () => {
      logger.info(`Navigate to ${path}`);
      await this.page.goto(path);
    });
  }

  async click(locator: Locator, description: string): Promise<void> {
    await test.step(`Click ${description}`, async () => {
      await expect(locator, `${description} must be visible before clicking`).toBeVisible();
      await locator.click();
    });
  }

  async type(locator: Locator, text: string, description: string): Promise<void> {
    await test.step(`Type "${text}" into ${description}`, async () => {
      await expect(locator, `${description} must be visible before typing`).toBeVisible();
      await locator.fill(text);
    });
  }

  async getText(locator: Locator): Promise<string> {
    return (await locator.textContent())?.trim() ?? '';
  }

  async isVisible(locator: Locator): Promise<boolean> {
    return locator.isVisible();
  }
}
