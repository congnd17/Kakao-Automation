import { test, Page } from '@playwright/test';
import type { ApiExchange } from '@api/payment-method-policy.api';

/**
 * Bọc test.step() và tự đính kèm screenshot ngay sau khi step chạy xong.
 * Dùng cho step Arrange/Act/Assert ở tầng test — KHÔNG dùng trong BasePage.click()/type()
 * để tránh phình report với ảnh chụp từng thao tác nhỏ lẻ.
 */
export function makeStep(page: Page) {
  return async function step(name: string, fn: () => Promise<void>): Promise<void> {
    await test.step(name, async () => {
      await fn();
      const screenshot = await page.screenshot({ fullPage: true });
      await test.info().attach(name, { body: screenshot, contentType: 'image/png' });
    });
  };
}

/**
 * Bản API của makeStep() — thay screenshot bằng các request/response gọi trong step, đính kèm dạng JSON
 * ngay sau khi step chạy xong.
 */
export function makeApiStep(api: { exchanges: ApiExchange[] }) {
  return async function step(name: string, fn: () => Promise<void>): Promise<void> {
    await test.step(name, async () => {
      const firstExchange = api.exchanges.length;
      await fn();
      const exchanges = api.exchanges.slice(firstExchange);
      await test.info().attach(name, { body: JSON.stringify(exchanges, null, 2), contentType: 'application/json' });
    });
  };
}
