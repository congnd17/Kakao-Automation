import { expect, test, Locator, Page } from '@playwright/test';

export type Labeled = { name: string; locator: Locator };

/**
 * Ghi nhận kết quả đo tại từng màn hình trong step `Act: Step N`, rồi assert toàn bộ trong `Assert: Expected N`.
 * Dùng khi 1 dòng TC đi qua nhiều màn hình/dialog không cùng hiển thị được — giữ số step Act/Assert đúng bằng
 * số dòng Steps/Expected của TC (xem reporting_rules.md mục 2).
 */
export class Observations {
  private readonly records: Array<{ name: string; ok: boolean }> = [];

  constructor(private readonly page: Page) {}

  /** Probe lỗi (element không tồn tại, detached…) được ghi nhận là FAIL, không làm vỡ step Act. */
  async record(name: string, probe: () => Promise<boolean>): Promise<void> {
    const ok = await probe().catch(() => false);
    this.records.push({ name, ok });
  }

  async recordVisible(items: Labeled[], tag: string): Promise<void> {
    for (const { name, locator } of items) {
      await this.record(`${tag} ${name} is visible`, () => locator.isVisible());
    }
  }

  /** Ảnh của màn hình trung gian — step Act chỉ tự chụp màn hình cuối cùng. */
  async screenshot(name: string): Promise<void> {
    const body = await this.page.screenshot({ fullPage: true });
    await test.info().attach(name, { body, contentType: 'image/png' });
  }

  /** Soft assert để report liệt kê ĐỦ mọi ý fail, không dừng ở ý đầu tiên. */
  assertAll(): void {
    expect(this.records.length, 'At least one observation was recorded in the Act step').toBeGreaterThan(0);
    for (const { name, ok } of this.records) {
      expect.soft(ok, name).toBe(true);
    }
  }
}
