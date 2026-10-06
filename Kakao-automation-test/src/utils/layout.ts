import { Locator, Page } from '@playwright/test';

/**
 * Phép đo bố cục cho TC responsive (automation_rules.md mục 6.1 — "fully visible / not clipped / does not overflow /
 * not pushed out of sight / no horizontal scrollbar"). Mỗi hàm trả boolean để dùng với Observations hoặc expect.
 */

/**
 * Nội dung bị cắt: phần tử (hoặc con của nó) có scroll lớn hơn vùng hiển thị theo chiều ngang. Bỏ qua phần tử chủ ý ẩn
 * cho screen reader (`visually-hidden` — rộng ~1px, luôn scroll > client) để không báo cắt giả.
 */
export async function isClipped(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) =>
    [el, ...Array.from(el.querySelectorAll('*'))]
      .filter((node) => node.clientWidth > 1 && !node.closest('.visually-hidden, .sr-only'))
      .some((node) => node.scrollWidth > node.clientWidth + 1),
  );
}

/** Trang có thanh cuộn ngang. */
export async function hasHorizontalPageScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

/** Phần tử nằm trọn trong bề ngang viewport (không bị đẩy ra ngoài tầm nhìn theo chiều ngang). */
export async function isWithinViewportWidth(locator: Locator, page: Page): Promise<boolean> {
  const [box, viewport] = [await locator.boundingBox(), page.viewportSize()];
  return !!box && !!viewport && box.x >= -1 && box.x + box.width <= viewport.width + 1;
}

/** Phần tử nằm trọn trong viewport cả 2 chiều. */
export async function isWithinViewport(locator: Locator, page: Page): Promise<boolean> {
  const [box, viewport] = [await locator.boundingBox(), page.viewportSize()];
  return (
    !!box && !!viewport && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1
  );
}

/** Phần tử không tràn ra ngoài khung chứa theo chiều ngang. */
export async function isInsideContainerWidth(locator: Locator, container: Locator): Promise<boolean> {
  const [box, outer] = [await locator.boundingBox(), await container.boundingBox()];
  return !!box && !!outer && box.x >= outer.x - 1 && box.x + box.width <= outer.x + outer.width + 1;
}

/** Vùng cuộn riêng của phần tử có cuộn theo chiều ngang / dọc (tràn được chứa trong chính nó). */
export async function scrollsInside(locator: Locator, axis: 'x' | 'y'): Promise<boolean> {
  return locator.evaluate(
    (el, direction) => (direction === 'x' ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight),
    axis,
  );
}

/** Giả lập zoom trình duyệt bằng CSS zoom trên <html> — Playwright không có API zoom thật. */
export async function setPageZoom(page: Page, percent: number): Promise<void> {
  await page.evaluate((value) => {
    document.documentElement.style.zoom = `${value}%`;
  }, percent);
}
