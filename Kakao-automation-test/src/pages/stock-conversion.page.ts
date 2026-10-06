import { Locator, Page, Request, Response, expect, test } from '@playwright/test';
import type { RowDataPacket } from 'mysql2/promise';
import { BasePage } from './base.page';
import { ConversionDialog } from './stock-dialogs.page';
import { StockCalculationPage, squash } from './stock-calculation.page';
import type { ConversionPolicy } from '@api/stock.api';
import { stockDb } from '@utils/stock-db';
import type { WorldSku } from '@utils/stock.data';

/** Path của call ghi 재고 전환 (POST). */
export const CONVERSION_PATH = '/api/v1/stocks/conversions';

/** Kết quả 1 lần bấm 저장 đã gửi call POST /stocks/conversions. */
export interface ConversionSave {
  status: number;
  body: Record<string, unknown>;
  payload: { policy?: string; items?: Array<{ skuId: number; warehouseId: number; quantity: number; memo?: string }> };
}

/** Ngăn tồn kho đọc từ bảng `stock` (보류재고 không phải cột của list). */
export interface StoredBuckets {
  available: number;
  hold: number;
  cs: number;
  physical: number;
}

/**
 * Nhóm [Conversion] của US134 (TC_US134_228–272) — thao tác bổ sung cho dialog 재고 전환 (`ConversionDialog` dùng chung,
 * không sửa file đó): mở dialog cho các dòng, đọc 3 ô số của dòng (전환 전 / 전환 후 현재수량, 전환 후 수량), bắt call
 * POST /stocks/conversions, đếm call ghi, dòng bị đánh dấu lỗi (`is-invalid` trên ô 전환수량), bộ đếm ký tự của 메모,
 * đóng dialog không lưu. Hành vi verify theo bundle frontend (`n8t`, `B_`, `uv`, `P4`, `qM`, `Ub`) ngày 05/10/2026.
 */
export class StockConversionPage extends BasePage {
  constructor(
    page: Page,
    readonly list: StockCalculationPage,
    readonly dialog: ConversionDialog,
  ) {
    super(page);
  }

  /** Ô (전환 전 구분) 현재수량 của dòng `index`. */
  fromCell(index = 0): Locator {
    return this.dialog.rows.nth(index).locator('td').nth(3);
  }

  /** Ô (전환 후 구분) 현재수량 của dòng `index`. */
  toCell(index = 0): Locator {
    return this.dialog.rows.nth(index).locator('td').nth(4);
  }

  /** Ô (전환 후 구분) 전환 후 수량 của dòng `index`. */
  afterCell(index = 0): Locator {
    return this.dialog.rows.nth(index).locator('td').nth(6);
  }

  /**
   * Vị trí (0-based) của từng SKU trong bảng dialog. Dialog xếp dòng theo thứ tự của list (`ie = rows.filter(selected)`
   * trong bundle), KHÔNG theo thứ tự tick — nên dòng "row 1" của TC phải tìm theo SKU코드 (ô đầu tiên của dòng).
   */
  async lineIndexes(skus: WorldSku[]): Promise<number[]> {
    await expect(this.dialog.rows, `The dialog lists ${skus.length} row(s)`).toHaveCount(skus.length);
    const codes = (await this.dialog.rows.locator('td:first-child').allInnerTexts()).map((text) => text.trim());
    return skus.map((sku) => {
      const index = codes.indexOf(sku.skuCode);
      if (index < 0) throw new Error(`SKU ${sku.skuCode} is not a row of the stock conversion dialog (rows: ${codes.join(', ')})`);
      return index;
    });
  }

  /** Bộ đếm `n/100` ngay dưới ô 메모 của dòng `index`. */
  memoCounter(index = 0): Locator {
    return this.dialog.memoInput(index).locator('xpath=..').locator('div.text-muted').filter({ hasText: /^\s*\d+\s*\/\s*\d+\s*$/ }).first();
  }

  /** Dòng lỗi validate / lỗi server hiện trong dialog. */
  message(text: string): Locator {
    return this.dialog.body.locator('.alert-danger').filter({ hasText: squash(text) }).first();
  }

  /** Text các lựa chọn policy (bỏ placeholder). */
  async policyOptions(): Promise<string[]> {
    return (await this.dialog.policySelect.locator('option:not([value=""])').allTextContents()).map((text) => text.trim());
  }

  /** Text đang hiện của select 전환 구분. */
  selectedPolicyText(): Locator {
    return this.dialog.policySelect.locator('option:checked');
  }

  /** Tick các dòng (bỏ qua dòng đã tick) rồi bấm 재고 전환 và đợi dialog mở. */
  async openFor(rows: Array<{ row: Locator; label: string }>): Promise<void> {
    await test.step(`Open 재고 전환 for ${rows.map((r) => r.label).join(', ')}`, async () => {
      for (const { row, label } of rows) {
        if (!(await this.list.checkbox(row).isChecked())) await this.list.tick(row, label);
      }
      await this.list.clickToolbar('btn.convertStock');
      await this.dialog.waitOpen(this.list.lang);
    });
  }

  /** Lọc list theo SKU코드 của SKU riêng của test. */
  async showSku(sku: WorldSku): Promise<void> {
    await this.list.search('SKU_CODE', sku.skuCode);
  }

  /** Lọc list theo 상품코드 (mọi dòng của nhóm SKU riêng của test). */
  async showGroup(sku: WorldSku): Promise<void> {
    await this.list.search('SKU_GROUP_CODE', sku.groupCode);
  }

  async choose(policy: ConversionPolicy): Promise<void> {
    await this.dialog.choosePolicy(policy);
  }

  /** Bấm 저장 và đợi call POST /stocks/conversions trả về. */
  async save(): Promise<ConversionSave> {
    const response = this.page.waitForResponse((res) => isConversionPost(res.request()), { timeout: 60_000 });
    await this.dialog.clickSave();
    return readSave(await response);
  }

  /** Bấm 저장 (lưu thành công) và đợi list tải lại. */
  async saveAndReload(): Promise<ConversionSave> {
    let result!: ConversionSave;
    await this.list.waitForListReload(async () => {
      result = await this.save();
    });
    return result;
  }

  /** Bấm 저장 và theo dõi list có tải lại sau đó không (`reloaded` = true khi GET /stock-status chạy lại trong 30 s). */
  async saveWatchingReload(): Promise<{ save: ConversionSave; reloaded: Promise<boolean> }> {
    const reloaded = this.page
      .waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && res.request().method() === 'GET', { timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    const save = await this.save();
    return { save, reloaded };
  }

  /** Trọn 1 lượt: tick dòng → 재고 전환 → chọn policy → nhập số lượng (+ memo) → 저장 → đợi list tải lại. */
  async runConversion(row: Locator, label: string, policy: ConversionPolicy, quantity: string, memo?: string): Promise<ConversionSave> {
    let result!: ConversionSave;
    await test.step(`Convert ${quantity} with ${policy} on ${label}`, async () => {
      await this.openFor([{ row, label }]);
      await this.choose(policy);
      await this.dialog.fillLine(0, { quantity, memo });
      const { save, reloaded } = await this.saveWatchingReload();
      result = save;
      if (save.status < 300) {
        await reloaded;
        await this.list.waitForList();
      }
    });
    return result;
  }

  /** Bấm 저장 khi validate phía client có thể chặn: null khi không có call nào trong `timeout` ms. */
  async trySave(timeout = 10_000): Promise<ConversionSave | null> {
    const response = this.page.waitForResponse((res) => isConversionPost(res.request()), { timeout }).catch(() => null);
    await this.dialog.clickSave();
    const res = await response;
    return res ? readSave(res) : null;
  }

  /**
   * Bấm 저장 khi validate phía client phải chặn: đếm call POST trong lúc bấm và đợi dòng lỗi trong dialog — trả về số
   * call đã gửi (0 = bị chặn ở client).
   */
  async blockedSave(): Promise<number> {
    let count = 0;
    const listener = (request: Request) => {
      if (isConversionPost(request)) count += 1;
    };
    this.page.on('request', listener);
    try {
      await this.dialog.clickSave();
      await expect(this.dialog.errorAlert, 'A message appears in the dialog').toBeVisible();
    } finally {
      this.page.off('request', listener);
    }
    return count;
  }

  /** Ô 전환수량 của dòng `index` mang class lỗi (is-invalid) — false khi dialog đã đóng (không còn dòng). */
  async lineHighlighted(index: number): Promise<boolean> {
    if ((await this.dialog.rows.nth(index).count()) === 0) return false;
    return this.dialog.rows.nth(index).evaluate((tr) =>
      [tr, ...Array.from(tr.querySelectorAll('*'))].some((node) => /is-invalid/.test((node as HTMLElement).className?.toString() ?? '')),
    );
  }

  /** Ô tick đang được tick trên bảng 재고 목록. */
  get checkedRowBoxes(): Locator {
    return this.list.table.locator('tbody input[type="checkbox"]:checked');
  }

  /** Bấm 취소 và — nếu hiện hộp xác nhận (dialog đã nhập liệu) — chọn 닫기; đợi dialog đóng hẳn. */
  async discard(): Promise<void> {
    await test.step('Close the stock conversion dialog without saving', async () => {
      await this.dialog.clickCancel();
      const confirm = this.dialog.confirmClose;
      await expect(async () => {
        if (await confirm.isVisible()) await this.dialog.confirmDiscard();
        await expect(this.dialog.root).toHaveCount(0, { timeout: 1_000 });
      }, 'The dialog closes (after confirming when asked)').toPass({ timeout: 15_000 });
    });
  }

  /** Thử gõ vào ô — ô bị tắt (disabled) không nhận phím nào; trả về giá trị ô sau khi thử. */
  async tryType(input: Locator, text: string): Promise<string> {
    await test.step(`Try to type "${text}"`, async () => {
      if (await input.isEnabled()) await input.pressSequentially(text);
    });
    return input.inputValue();
  }
}

export function isConversionPost(request: Request): boolean {
  return request.method() === 'POST' && new URL(request.url()).pathname === CONVERSION_PATH;
}

async function readSave(response: Response): Promise<ConversionSave> {
  let body: Record<string, unknown> = {};
  try {
    body = ((await response.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status(), body, payload: (response.request().postDataJSON() ?? {}) as ConversionSave['payload'] };
}

/** Ngăn tồn kho lưu trong bảng `stock` của 1 dòng (SKU × kho) — null khi không có bản ghi. */
export async function storedBuckets(skuId: number, warehouseId: number): Promise<StoredBuckets | null> {
  const row = await stockDb.stock(skuId, warehouseId);
  if (!row) return null;
  return { available: Number(row.available_quantity), hold: Number(row.hold_quantity), cs: Number(row.cs_quantity), physical: Number(row.physical_quantity) };
}

/** Số bản ghi `stock_conversion` của 1 SKU (mọi kho). */
export async function conversionCount(skuId: number): Promise<number> {
  return (await stockDb.conversions(skuId)).length;
}

/** Id bucket DEFECTIVE (kho ảo con) của 1 kho — null khi kho không có. */
export async function defectiveBucketId(parentId: number): Promise<number | null> {
  const rows = await stockDb.query<RowDataPacket>("SELECT id FROM warehouse WHERE location_warehouse_id = ? AND logistics_type = 'DEFECTIVE'", [parentId]);
  return rows.length > 0 ? Number(rows[0].id) : null;
}

/**
 * Tách / gắn lại bucket DEFECTIVE khỏi kho cha của 1 kho automation do test tự tạo (TC "source warehouse has no defective
 * bucket"): `location_warehouse_id` = null làm kho cha không còn bucket DEFECTIVE; gọi lại với `parentId` để khôi phục.
 */
export async function setBucketParent(bucketId: number, parentId: number | null): Promise<void> {
  await stockDb.exec('UPDATE warehouse SET location_warehouse_id = ? WHERE id = ?', [parentId, bucketId]);
}
