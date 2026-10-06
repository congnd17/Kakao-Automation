import { Page, Locator, expect, test } from '@playwright/test';
import { BasePage } from './base.page';
import { StockListPage, escapeRegex, iconButtonName } from './stock-list.page';
import { SkuFormKind, SkuMasterListPage } from './sku-form.page';
import { stx, StockLang, StockTextKey } from '@utils/stock.i18n';

/** Kết quả đo 1 ô bị cắt chữ: phần tử cắt (text-overflow), bề rộng, có dấu "…" không, chữ có bị cắt thật không, tooltip. */
export interface CellTruncation {
  width: number;
  ellipsis: boolean;
  truncated: boolean;
  title: string | null;
  text: string;
}

/** Tên mục menu SKU master theo loại (TC ghi tên tiếng Hàn — menu chưa có trên dev 05/10). */
export const SKU_MASTER_MENU: Record<SkuFormKind, string> = {
  physical: '현물 SKU 마스터 관리',
  digital: '디지털 SKU 마스터 관리',
  set: 'set SKU 마스터 관리',
};

/**
 * Phép đo / locator bổ sung cho nhóm [UI] của US134 (form SKU, dialog, list): nhãn trường của form, thanh nút cuối form,
 * đo cắt chữ + tràn ô của bảng 재고 목록, cuộn khung bảng, mở SKU master qua menu. Verify DOM 05/10/2026 (recon out/*).
 */
export class StockUiPage extends BasePage {
  readonly list: StockListPage;
  readonly master: SkuMasterListPage;
  readonly formCard = this.page.locator('.custom-card.card').first();
  /** Thanh nút cuối form SKU (목록으로 · 저장). */
  readonly formFooter = this.formCard.locator('.d-flex.justify-content-end.border-top').last();

  constructor(page: Page) {
    super(page);
    this.list = new StockListPage(page);
    this.master = new SkuMasterListPage(page);
  }

  /** Nhãn trường của form SKU khớp đúng text (bỏ dấu `*` bắt buộc). */
  formLabel(text: string): Locator {
    return this.formCard.locator('label.form-label', { hasText: new RegExp(`^${escapeRegex(text)}\\*?$`) });
  }

  /** Mọi nhãn trường của form SKU. */
  get formLabels(): Locator {
    return this.formCard.locator('label.form-label');
  }

  /** Text khối (không phải label) của form — VD tiêu đề mục 옵션 설정 / SET 설정 (có thể kèm `*`). */
  formSection(text: string): Locator {
    return this.formCard.locator('div.fw-semibold', { hasText: new RegExp(`^${escapeRegex(text)}\\*?$`) });
  }

  /** Nút trên toàn màn theo text (bỏ glyph icon). */
  pageButton(text: string): Locator {
    return this.page.getByRole('button', { name: iconButtonName(text) });
  }

  /** Text header bảng theo textContent (không bị text-transform), bỏ dấu `*` bắt buộc. */
  async headerTexts(headers: Locator): Promise<string[]> {
    return (await headers.allTextContents()).map((text) => text.replace(/\*$/, '').trim());
  }

  /** Text các option của select (textContent). */
  async optionTexts(select: Locator): Promise<string[]> {
    return (await select.locator('option').allTextContents()).map((text) => text.trim());
  }

  /** Text option đang chọn của select. */
  selectedOption(select: Locator): Locator {
    return select.locator('option:checked');
  }

  /** Ngày hôm nay YYYY-MM-DD theo giờ của trình duyệt (cùng nguồn với dialog 입고 요청). */
  async browserToday(): Promise<string> {
    return this.page.evaluate(() => {
      const now = new Date();
      const pad = (value: number) => String(value).padStart(2, '0');
      return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    });
  }

  /** Đo cắt chữ của 1 ô: phần tử mang text-overflow (hoặc chính ô), bề rộng, "…", chữ bị cắt, thuộc tính title. */
  async truncation(cell: Locator): Promise<CellTruncation> {
    return cell.evaluate((td) => {
      const nodes = [td, ...Array.from(td.querySelectorAll('*'))] as HTMLElement[];
      const clip = nodes.find((node) => getComputedStyle(node).textOverflow === 'ellipsis') ?? (td as HTMLElement);
      const style = getComputedStyle(clip);
      const titled = nodes.find((node) => node.hasAttribute('title'));
      return {
        width: clip.getBoundingClientRect().width,
        ellipsis: style.textOverflow === 'ellipsis' && style.overflowX !== 'visible',
        truncated: clip.scrollWidth > clip.clientWidth + 1,
        title: titled?.getAttribute('title') ?? null,
        text: (td.textContent ?? '').trim(),
      };
    });
  }

  /** Text hiện khi rê chuột vào ô: tooltip Bootstrap đang mở, nếu không có thì thuộc tính `title` của ô / phần tử con. */
  async hoverText(cell: Locator): Promise<string | null> {
    await test.step('Hover the cell and read the text that appears', async () => {
      await cell.hover();
    });
    const tooltip = this.page.locator('.tooltip.show, [role="tooltip"]').first();
    const { title } = await this.truncation(cell);
    if (title) return title;
    await tooltip.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => undefined);
    return (await tooltip.isVisible()) ? (await tooltip.innerText()).trim() : null;
  }

  /**
   * Chỉ số các ô của dòng có chữ tràn ra ngoài ô (không bị khung nào cắt) hoặc đè lên ô kế tiếp.
   * Text bên trong phần tử overflow ≠ visible được tính tới mép của phần tử đó (chữ bị cắt = không tràn).
   */
  async overflowingCells(row: Locator): Promise<number[]> {
    return row.evaluate((tr) =>
      Array.from(tr.children).flatMap((child, index) => {
        const cell = child as HTMLElement;
        const box = cell.getBoundingClientRect();
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        let right = box.left;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          let textRight = range.getBoundingClientRect().right;
          for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
            if (getComputedStyle(ancestor).overflowX !== 'visible') textRight = Math.min(textRight, ancestor.getBoundingClientRect().right);
            if (ancestor === cell) break;
          }
          right = Math.max(right, textRight);
        }
        const next = cell.nextElementSibling?.getBoundingClientRect();
        const spills = right > box.right + 1;
        const overlapsNext = !!next && box.right > next.left + 1;
        return spills || overlapsNext ? [index] : [];
      }),
    );
  }

  /** Khung cuộn ngang bao bảng (`.table-responsive`). */
  tableFrame(table: Locator): Locator {
    return table.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " table-responsive ")][1]');
  }

  /** Cuộn khung bảng sang hết bên phải. */
  async scrollFrameToEnd(frame: Locator): Promise<void> {
    await test.step('Scroll the table frame to the right end', async () => {
      await frame.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
    });
  }

  /** Đổi bề ngang cửa sổ (giữ tỉ lệ cao hợp lý cho màn mobile). */
  async resizeWidth(width: number): Promise<void> {
    await test.step(`Resize the window to ${width} wide`, async () => {
      await this.page.setViewportSize({ width, height: width < 500 ? 844 : 1080 });
    });
  }

  /**
   * Mở SKU master qua menu 물류 관리 › SKU 마스터 관리 › <mục>; menu chưa có mục → mở bằng URL. Trả về true khi mở được
   * qua menu (để assert theo TC).
   */
  async openMasterFromMenu(kind: SkuFormKind, lang: StockLang = 'ko'): Promise<boolean> {
    let viaMenu = false;
    await test.step(`Open the ${SKU_MASTER_MENU[kind]} list from the left menu`, async () => {
      await this.list.openFromSidebar();
      const group = this.list.sidebarLink('SKU 마스터 관리');
      if (await group.isVisible()) {
        await this.click(group, 'SKU 마스터 관리 group in the sidebar');
        const item = this.list.sidebarLink(SKU_MASTER_MENU[kind]);
        if (await item.isVisible()) {
          await this.click(item, `${SKU_MASTER_MENU[kind]} menu item`);
          viaMenu = true;
        }
      }
      if (!viaMenu || lang === 'en') {
        await this.master.open(kind, lang);
      } else {
        this.master.lang = lang;
        await expect(this.master.table, 'The SKU master list must load').toBeVisible({ timeout: 30_000 });
      }
    });
    return viaMenu;
  }

  /** Nút tạo SKU trên list SKU master theo loại. */
  masterCreateLink(kind: SkuFormKind, lang: StockLang): Locator {
    const key: Record<SkuFormKind, StockTextKey> = { physical: 'master.create.physical', digital: 'master.create.digital', set: 'master.create.set' };
    return this.master.card.getByRole('link', { name: iconButtonName(stx(key[kind], lang)) });
  }

  /** Bấm nút tạo SKU trên list SKU master và đợi form tải. */
  async clickMasterCreate(kind: SkuFormKind, lang: StockLang): Promise<void> {
    await this.click(this.masterCreateLink(kind, lang), `create button of the ${kind} SKU master list`);
    await this.page.waitForURL(new RegExp(`/commerce/product-stock/stock/${kind}/create`));
  }

  /** Nút / link trong nội dung form (không tính sidebar, header, breadcrumb) có tên kiểu "quay lại / về danh sách". */
  get formReturnActions(): Locator {
    return this.formCard.locator('a, button, [role="button"]').filter({ hasText: /목록|돌아가|뒤로|back|list|return/i });
  }

  /** Link "Back to stock management" (hoặc bản tiếng Hàn) ở bất kỳ đâu trên màn. */
  get backToStockLink(): Locator {
    return this.page.getByRole('link', { name: /back to stock management|재고 관리로|재고관리로/i });
  }
}
