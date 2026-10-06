import { Locator, Page, Request, Route, expect, test } from '@playwright/test';
import { StockCalculationPage, squash } from './stock-calculation.page';
import { AdjustmentDialog, ConversionDialog, WarehouseDetailDialog } from './stock-dialogs.page';
import type { StockApi } from '@api/stock.api';
import type { StockWorld, WorldSku, WorldWarehouse } from '@utils/stock.data';
import { newDbId, stockDb } from '@utils/stock-db';

/**
 * Nhóm [Warehouse Detail] của US134 — dialog 창고별 상세 (`r8t` trong bundle 05/10/2026):
 *  - Guard toolbar (`mqt`): không chọn dòng → `guard.noSelection`; có dòng kho không thuộc 대구분 CJ_WAREHOUSE /
 *    CJ_DAEGU_WAREHOUSE (`hqt`) → `guard.nonCjWarehouse`; guard hiện `.alert-danger[role=alert]` phía trên bảng.
 *  - Bảng 5 cột: SKU 코드 · SKU명 · 창고 · CS재고(가용재고) (cờ tắt → chữ 관리안함, bật → số) · CS재고 관리여부 =
 *    cặp radio `#cs-<dòng>-MANAGED|UNMANAGED` (name `cs-<dòng>`), KHÔNG phải select.
 *  - 저장: client chặn khi dòng đang 관리함 chuyển sang 관리안함 mà CS재고 > 0 (`err.csUnmanageBlocked`, không gửi request);
 *    ngược lại gửi PATCH /stocks/cs-stock-management với MỌI dòng `{skuId, warehouseId, managed}`. Thành công → dialog
 *    đóng, toast 저장되었습니다, bỏ tick, list tải lại. Lỗi server → nguyên `message` trong `.modal-body .alert-danger`.
 *  - Đóng khi đã đổi radio → hộp xác nhận 확인 (`msg.closeWithoutSaving`).
 * Cột CS của list (`due`): cờ bật → số; cờ tắt + kho CJ → 관리안함; kho khác → "-".
 */
export const CS_PATH = '/api/v1/stocks/cs-stock-management';

/** Kết quả 1 lần bấm 저장 có gửi request PATCH. */
export interface CsSave {
  status: number;
  code: string;
  message: string;
  requestBody: { items?: Array<{ skuId: number | string; warehouseId: number | string; managed: boolean }> };
  responseBody: unknown;
}

export class StockWarehouseDetailPage extends StockCalculationPage {
  readonly detail: WarehouseDetailDialog;
  readonly adjustment: AdjustmentDialog;
  readonly conversion: ConversionDialog;

  constructor(page: Page) {
    super(page);
    this.detail = new WarehouseDetailDialog(page);
    this.adjustment = new AdjustmentDialog(page);
    this.conversion = new ConversionDialog(page);
  }

  /** Radio 관리함 / 관리안함 của dòng `index` trong dialog. */
  managedRadio(index: number, managed: boolean): Locator {
    return this.detail.rows.nth(index).locator(`#cs-${index}-${managed ? 'MANAGED' : 'UNMANAGED'}`);
  }

  /** Mọi radio CS재고 관리여부 của dòng `index`. */
  radios(index: number): Locator {
    return this.detail.rows.nth(index).locator('input[type="radio"]');
  }

  /** Nhãn các lựa chọn CS재고 관리여부 của dòng `index`. */
  async choiceLabels(index: number): Promise<string[]> {
    return (await this.detail.rows.nth(index).locator('label.form-check-label').allTextContents()).map((text) => text.trim());
  }

  /** Ô `column` (0 = SKU 코드 … 4 = CS재고 관리여부) của dòng dialog `index`. */
  dialogCell(index: number, column: number): Locator {
    return this.detail.rows.nth(index).locator('td').nth(column);
  }

  async dialogCellText(index: number, column: number): Promise<string> {
    return ((await this.dialogCell(index, column).textContent()) ?? '').trim();
  }

  /** Vị trí dòng trong dialog theo SKU 코드 + tên kho. */
  async dialogRowIndex(skuCode: string, warehouseName: string): Promise<number> {
    const count = await this.detail.rows.count();
    for (let index = 0; index < count; index += 1) {
      const cells = (await this.detail.rows.nth(index).locator('td').allTextContents()).map((text) => text.trim());
      if (cells[0] === skuCode && cells[2] === warehouseName) return index;
    }
    throw new Error(`The per-warehouse detail dialog has no line for ${skuCode} @ ${warehouseName}`);
  }

  /** Chọn radio 관리함 / 관리안함 của dòng `index`. */
  async setManaged(index: number, managed: boolean): Promise<void> {
    await test.step(`Set CS stock managed of line ${index + 1} to ${managed ? '관리함 (Managed)' : '관리안함 (Not managed)'}`, async () => {
      await this.managedRadio(index, managed).check();
    });
  }

  /** Tick các dòng rồi bấm 창고별 상세 — đợi dialog mở. */
  async openDetail(rows: Locator[]): Promise<void> {
    await test.step('Tick the rows and click 창고별 상세 (Per-warehouse detail)', async () => {
      for (const row of rows) await this.checkbox(row).check();
      await this.clickToolbar('btn.warehouseDetail');
      await this.detail.waitOpen(this.lang);
    });
  }

  /** Bấm 창고별 상세 (không đợi dialog) — dùng khi guard được kỳ vọng chặn. */
  async clickDetail(): Promise<void> {
    await this.clickToolbar('btn.warehouseDetail');
  }

  /** Text guard đang hiện (đã gộp khoảng trắng / xuống dòng). */
  async guardText(): Promise<string> {
    await expect(this.guardAlert, 'A guard message must appear above the table').toBeVisible();
    return squash(await this.guardAlert.innerText());
  }

  /** Bỏ tick mọi dòng đang chọn trên trang. */
  async untickAll(): Promise<void> {
    await test.step('Untick every selected row', async () => {
      for (const box of await this.table.locator('tbody input[type="checkbox"]:checked').all()) await box.uncheck();
    });
  }

  get tickedBoxes(): Locator {
    return this.table.locator('input[type="checkbox"]:checked');
  }

  /** Bấm 저장 và đợi PATCH CS trả về; thành công thì đợi list tải lại. */
  async saveDetail(): Promise<CsSave> {
    const reload = this.page
      .waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && res.request().method() === 'GET', { timeout: 30_000 })
      .then(() => true, () => false);
    const response = this.page.waitForResponse((res) => res.url().includes(CS_PATH) && res.request().method() === 'PATCH', { timeout: 60_000 });
    await this.detail.clickSave();
    const res = await response;
    const responseBody = (await res.json().catch(() => null)) as unknown;
    const body = (responseBody ?? {}) as { code?: string; message?: string; detail?: string };
    const outcome: CsSave = {
      status: res.status(),
      code: body.code ?? '',
      message: body.message ?? body.detail ?? '',
      requestBody: (res.request().postDataJSON() ?? {}) as CsSave['requestBody'],
      responseBody,
    };
    if (outcome.status < 300) {
      await reload;
      await this.waitForList();
    }
    return outcome;
  }

  /** Đợi response PATCH CS kế tiếp của tab này — trả về status + code + message. */
  async nextCsResponse(timeout = 60_000): Promise<{ status: number; code: string; message: string }> {
    const res = await this.page.waitForResponse((r) => r.url().includes(CS_PATH) && r.request().method() === 'PATCH', { timeout });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as { code?: string; message?: string; detail?: string };
    return { status: res.status(), code: body.code ?? '', message: body.message ?? body.detail ?? '' };
  }

  /** Giữ PATCH CS của tab này trong browser cho tới `release()` — để 2 phiên gửi lưu cùng lúc. */
  async holdCsWrite(): Promise<{ seen: Promise<Request>; release: () => void; dispose: () => Promise<void> }> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markSeen!: (request: Request) => void;
    const seen = new Promise<Request>((resolve) => {
      markSeen = resolve;
    });
    const pattern = `**${CS_PATH}`;
    const handler = async (route: Route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      markSeen(route.request());
      await gate;
      await route.continue();
    };
    await this.page.route(pattern, handler);
    return { seen, release, dispose: () => this.page.unroute(pattern, handler) };
  }

  /** Ảnh toàn trang của tab này (phiên thứ 2 của TC đồng thời). */
  async screenshotPng(): Promise<Buffer> {
    return this.page.screenshot({ fullPage: true });
  }

  /** Bắt đầu đếm request PATCH CS — mảng được điền dần (kiểm "không gửi request"). */
  csWrites(): string[] {
    const urls: string[] = [];
    this.page.on('request', (request) => {
      if (request.url().includes(CS_PATH) && request.method() === 'PATCH') urls.push(request.url());
    });
    return urls;
  }

  /** Đóng dialog bằng 취소 — nếu hiện hộp xác nhận thì chọn 닫기; đợi dialog đóng hẳn. */
  async closeDetail(): Promise<void> {
    await test.step('Close the per-warehouse detail dialog without saving', async () => {
      await this.detail.clickCancel();
      await expect(async () => {
        if (await this.detail.confirmClose.isVisible()) await this.detail.confirmDiscard();
        await expect(this.detail.root).toHaveCount(0, { timeout: 1_000 });
      }, 'The dialog closes (after confirming when asked)').toPass({ timeout: 15_000 });
    });
  }

  /** Mọi dialog `.modal.show` đang mở trên trang. */
  get openDialogs(): Locator {
    return this.page.locator('.modal.show[role="dialog"]');
  }
}

/**
 * Pre-condition "CS재고 해제 (CS재고 → 가용재고) N" của TC: dựng dòng có CS = N rồi gọi 재고 전환 RELEASE_CS N qua API;
 * server từ chối → dựng thẳng trạng thái sau khi giải phóng bằng DB (CS 0, cộng N vào 가용). Trả về cách đã dùng.
 */
export async function releasedCsRow(
  world: StockWorld,
  stockApi: StockApi,
  sku: WorldSku,
  warehouse: WorldWarehouse,
  buckets: { available: number; cs: number; reserved?: number },
): Promise<'conversion' | 'db'> {
  await world.seedStock(sku, warehouse, { available: buckets.available, cs: buckets.cs, reserved: buckets.reserved, csManaged: true });
  const released = await stockApi.convert({ policy: 'RELEASE_CS', items: [{ skuId: sku.skuId, warehouseId: warehouse.id, quantity: buckets.cs, memo: `release ${world.tag}` }] });
  const after = await stockDb.stock(sku.skuId, warehouse.id);
  if (released.status < 300 && after && Number(after.cs_quantity) === 0) return 'conversion';
  await world.seedStock(sku, warehouse, { available: buckets.available + buckets.cs, cs: 0, reserved: buckets.reserved, csManaged: true });
  return 'db';
}

/**
 * DB fixture "1 CS 재배송 출고 đang mở" = 1 dòng `stock_reservation` (ref OUTGOING · RESERVED · quantity_type CS) của SKU.
 * Bảng không có cột kho — reservation gắn theo SKU (server kiểm trên mọi kho của SKU). Trả về id để xoá ở `finally`.
 */
export async function seedCsReservation(skuId: number, quantity = 1): Promise<number> {
  const id = newDbId();
  await stockDb.exec(
    `INSERT INTO stock_reservation (id, ref_id, ref_item_id, sku_id, ref_type, status, quantity, version, quantity_type)
     VALUES (?, ?, ?, ?, 'OUTGOING', 'RESERVED', ?, 0, 'CS')`,
    [id, newDbId(), newDbId(), skuId, quantity],
  );
  return id;
}

export async function deleteReservation(id: number): Promise<void> {
  await stockDb.exec('DELETE FROM stock_reservation WHERE id = ?', [id]);
}

/** Số reservation CS đang mở (RESERVED) của SKU — pre-condition "không có CS 재배송 출고". */
export async function openCsReservations(skuId: number): Promise<number> {
  const rows = await stockDb.query("SELECT COUNT(*) AS n FROM stock_reservation WHERE sku_id = ? AND quantity_type = 'CS' AND status = 'RESERVED'", [skuId]);
  return Number(rows[0]?.n ?? 0);
}

/** Cờ CS đã lưu của cặp SKU × kho (undefined = không có bản ghi tồn kho). */
export async function storedManaged(skuId: number, warehouseId: number): Promise<boolean | undefined> {
  const row = await stockDb.stock(skuId, warehouseId);
  return row ? Number(row.cs_stock_managed) === 1 : undefined;
}

/** Tạo `count` 현물 SKU riêng trong các nhóm ≤ 20 dòng; tên nhóm `<prefix> G<n>` để 1 từ khoá `prefix` lọc ra đủ. */
export async function bulkPhysicalSkus(world: StockWorld, labels: string[], prefix: string, count: number): Promise<WorldSku[]> {
  const skus: WorldSku[] = [];
  for (let group = 0; skus.length < count; group += 1) {
    const size = Math.min(20, count - skus.length);
    const lines = Array.from({ length: size }, (_, index) => ({ option: `L${index + 1}` }));
    skus.push(...(await world.createPhysicalSku(labels[group], { partner: world.partners.A, manufacturer: world.manufacturers.M1, groupName: `${prefix} G${group + 1}`, lines })));
  }
  return skus;
}

/**
 * Bố cục khung host (template admin dùng chung) cho nhóm [Responsive] — DOM lấy từ recon 05/10/2026
 * (`recon/out/pg-stock_lang_en.html`): thanh trên `header.app-header`; khối thông tin phụ = đồng hồ 로그인 만료
 * (`.header-content-right > .header-element.me-3`); khối người dùng `.mainuserProfile`; thanh điều hướng trên
 * (Common | Account | … , `.header-content-left > .header-element.d-xl-flex`); nút 3 gạch `a.sidemenu-toggle`; menu trái
 * `aside.app-sidebar`; nền mờ khi menu trượt vào `#responsive-overlay`.
 */
export class ResponsiveLayout {
  readonly topBar: Locator;
  readonly extraInfo: Locator;
  readonly userBlock: Locator;
  readonly topNav: Locator;
  readonly hamburger: Locator;
  readonly leftMenu: Locator;
  readonly backdrop: Locator;

  constructor(private readonly page: Page) {
    this.topBar = page.locator('header.app-header');
    this.extraInfo = this.topBar.locator('.header-content-right > .header-element.me-3').first();
    this.userBlock = this.topBar.locator('.mainuserProfile');
    this.topNav = this.topBar.locator('.header-content-left > .header-element.d-xl-flex');
    this.hamburger = this.topBar.locator('a.sidemenu-toggle');
    this.leftMenu = page.locator('aside.app-sidebar');
    this.backdrop = page.locator('#responsive-overlay');
  }

  async resize(width: number): Promise<void> {
    await test.step(`Resize the window to ${width} px wide`, async () => {
      await this.page.setViewportSize({ width, height: width < 500 ? 844 : 1080 });
    });
  }

  /** Phần tử hiển thị và (ít nhất 1 phần) nằm trong bề ngang viewport — "trượt ra ngoài màn" = false. */
  async onScreen(locator: Locator): Promise<boolean> {
    if (!(await locator.isVisible())) return false;
    const [box, viewport] = [await locator.boundingBox(), this.page.viewportSize()];
    return !!box && !!viewport && box.width > 0 && box.x + box.width > 1 && box.x < viewport.width - 1;
  }

  async width(locator: Locator): Promise<number> {
    return (await locator.isVisible()) ? ((await locator.boundingBox())?.width ?? 0) : 0;
  }

  /** Cuộn tới phần tử rồi kiểm nó hiển thị trọn trong bề ngang viewport ("can be reached"). */
  async reachable(locator: Locator): Promise<boolean> {
    if ((await locator.count()) === 0) return false;
    await locator.scrollIntoViewIfNeeded();
    if (!(await locator.isVisible())) return false;
    const [box, viewport] = [await locator.boundingBox(), this.page.viewportSize()];
    return !!box && !!viewport && box.x >= -1 && box.x + box.width <= viewport.width + 1;
  }

  /** Khung nằm trong viewport, cách mỗi cạnh trái/phải ít nhất `margin` px. */
  async fitsWithMargin(locator: Locator, margin: number): Promise<boolean> {
    const [box, viewport] = [await locator.boundingBox(), this.page.viewportSize()];
    return !!box && !!viewport && box.x >= margin - 1 && box.x + box.width <= viewport.width - margin + 1;
  }

  /** Số phần tử trên mỗi dòng hiển thị (gom theo toạ độ y đỉnh, sai số 4 px), theo thứ tự từ trên xuống. */
  async lineCounts(items: Locator[]): Promise<number[]> {
    const tops: number[] = [];
    for (const item of items) tops.push(Math.round((await item.boundingBox())?.y ?? -9999));
    const lines: Array<{ y: number; n: number }> = [];
    for (const y of [...tops].sort((a, b) => a - b)) {
      const line = lines.find((entry) => Math.abs(entry.y - y) <= 4);
      if (line) line.n += 1;
      else lines.push({ y, n: 1 });
    }
    return lines.map((line) => line.n);
  }

  /** Có cặp phần tử nào chồng lên nhau (giao nhau quá 1 px) không. */
  async anyOverlap(items: Locator[]): Promise<boolean> {
    const boxes = [];
    for (const item of items) boxes.push(await item.boundingBox());
    for (let a = 0; a < boxes.length; a += 1) {
      for (let b = a + 1; b < boxes.length; b += 1) {
        const [p, q] = [boxes[a], boxes[b]];
        if (p && q && p.x + p.width > q.x + 1 && q.x + q.width > p.x + 1 && p.y + p.height > q.y + 1 && q.y + q.height > p.y + 1) return true;
      }
    }
    return false;
  }

  /** Tỉ lệ bề rộng phần tử so với khung chứa (0–1). */
  async widthRatio(item: Locator, container: Locator): Promise<number> {
    const [box, outer] = [await item.boundingBox(), await container.boundingBox()];
    return box && outer && outer.width > 0 ? box.width / outer.width : 0;
  }

  async flexDirection(locator: Locator): Promise<string> {
    return locator.evaluate((element) => getComputedStyle(element).flexDirection);
  }

  /** Cuộn khung cuộn ngang tới mép phải. */
  async scrollToEnd(frame: Locator): Promise<void> {
    await frame.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
  }
}
