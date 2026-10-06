import { Locator, Page, Request, Route, expect, test } from '@playwright/test';
import { StockCalculationPage, ownGroupName, squash } from './stock-calculation.page';
import { AdjustmentDialog, ConversionDialog, StockDialog, StockHistoryDialog, WarehouseDetailDialog } from './stock-dialogs.page';
import type { StockLang } from '@utils/stock.i18n';
import type { StockWorld, WorldSku, WorldWarehouse } from '@utils/stock.data';
import { DB_ACTOR, StockBuckets, newDbId, stockDb } from '@utils/stock-db';

/**
 * Nhóm [Adjustment] + [Stock History] của US134 — thao tác bổ sung trên màn 재고 관리 cho dialog 재고 조정 (`t8t`) và
 * 재고이력 (`s8t`) trong bundle 05/10/2026:
 *  - 저장 của dialog 조정 kiểm phía client: dòng thiếu 조정 수량 / 조정사유 → ô `is-invalid` + feedback dưới ô + alert
 *    "필수항목을 입력해주세요."; ô số lọc bỏ ký tự không phải số (`Ub`) và bỏ qua giá trị > 1e9; ô 비고 tối đa 100 ký tự,
 *    bỏ emoji, bộ đếm "n/100". Lỗi server hiện nguyên `message` trong `.modal-body .alert-danger`, dialog giữ nguyên.
 *  - Lưu thành công: dialog đóng, toast 등록되었습니다, bỏ chọn dòng, list gọi lại GET /stock-status.
 *  - Khung dialog ghi (`qF`) có backdrop static; dialog 재고이력 thì backdrop thường (bấm ngoài là đóng).
 *  - Nút 재고 조정 / 재고 전환 bị khoá khi chọn dòng kho 매출대기 / 이동중: nút disabled bọc trong span có tooltip.
 *  - Dialog 창고별 상세 dùng radio `#cs-<dòng>-MANAGED|UNMANAGED` (không phải select).
 */
export const ADJUST_URL = '/api/v1/adjustments';
export const CONVERT_URL = '/api/v1/stocks/conversions';
export const CS_URL = '/api/v1/stocks/cs-stock-management';

export const HISTORY_COLUMNS = ['date', 'refType', 'detailType', 'refId', 'note', 'before', 'change', 'after', 'operator', 'operatorIp'] as const;
export type HistoryLine = Record<(typeof HISTORY_COLUMNS)[number], string>;

/** Kết quả 1 lần bấm 저장 có gửi request ghi. */
export interface SaveOutcome {
  status: number;
  code: string;
  message: string;
  requestBody: unknown;
  reloaded: boolean;
}

/** Request ghi bị giữ lại trong browser (đếm số request + thả ra khi test đã đọc trạng thái nút). */
export interface HeldWrites {
  requests: Request[];
  release: () => void;
  dispose: () => Promise<void>;
}

export const IP_PATTERN = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;
export const HISTORY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Thời điểm UTC → chuỗi giờ Seoul `YYYY-MM-DD HH:mm:ss` (cách 재고이력 hiển thị). */
export function kstTimestamp(date: Date): string {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Thời điểm tròn giây cách hiện tại `minutesAgo` phút (mốc chèn lịch sử fixture). */
export function minutesAgo(minutes: number): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000 - minutes * 60_000);
}

export class StockAdjustmentPage extends StockCalculationPage {
  readonly adjustment: AdjustmentDialog;
  readonly conversion: ConversionDialog;
  readonly detail: WarehouseDetailDialog;
  readonly history: StockHistoryDialog;

  constructor(page: Page) {
    super(page);
    this.adjustment = new AdjustmentDialog(page);
    this.conversion = new ConversionDialog(page);
    this.detail = new WarehouseDetailDialog(page);
    this.history = new StockHistoryDialog(page);
  }

  /** Lọc list về nhóm SKU riêng của test (상품코드명 = `ownGroupName`). */
  async findGroup(world: StockWorld, label: string): Promise<void> {
    await this.search('SKU_GROUP_NAME', ownGroupName(world, label));
  }

  /** Tick các dòng rồi bấm 재고 조정 — đợi dialog mở. */
  async openAdjustment(rows: Locator[]): Promise<void> {
    await test.step('Tick the rows and open 재고 조정 (Stock adjustment)', async () => {
      for (const row of rows) await this.checkbox(row).check();
      await this.clickToolbar('btn.adjustStock');
      await this.adjustment.waitOpen(this.lang);
    });
  }

  /** Tick các dòng rồi bấm 재고 전환 — đợi dialog mở. */
  async openConversion(rows: Locator[]): Promise<void> {
    await test.step('Tick the rows and open 재고 전환 (Stock conversion)', async () => {
      for (const row of rows) await this.checkbox(row).check();
      await this.clickToolbar('btn.convertStock');
      await this.conversion.waitOpen(this.lang);
    });
  }

  /** Tick các dòng rồi bấm 창고별 상세 — đợi dialog mở. */
  async openWarehouseDetail(rows: Locator[]): Promise<void> {
    await test.step('Tick the rows and open 창고별 상세 (Per-warehouse detail)', async () => {
      for (const row of rows) await this.checkbox(row).check();
      await this.clickToolbar('btn.warehouseDetail');
      await this.detail.waitOpen(this.lang);
    });
  }

  /** Bỏ tick mọi dòng đang chọn trên trang — luôn bỏ ô đầu tiên còn tick (locator `:checked` co lại sau mỗi lần bỏ). */
  async untickAll(): Promise<void> {
    await test.step('Untick every selected row', async () => {
      const checked = this.bodyRows.locator('input[type="checkbox"]:checked');
      while ((await checked.count()) > 0) await checked.first().uncheck();
    });
  }

  /** Ô tick đang chọn của các dòng dữ liệu — không tính ô "chọn tất cả" ở thead (tự tick khi mọi dòng được chọn). */
  tickedBoxes(): Locator {
    return this.bodyRows.locator('input[type="checkbox"]:checked');
  }

  /**
   * Tải lại màn rồi tìm lại SKU — list KHÔNG gọi lại GET /stock-status khi bấm 검색 với cùng từ khoá, nên sau khi tồn kho
   * đổi ngoài list (DB fixture, phiên khác, lưu bị cắt) phải tải lại trang mới đọc được số mới.
   */
  async refreshSku(sku: WorldSku): Promise<void> {
    await this.open(this.lang);
    await this.findSku(sku);
  }

  /**
   * Bấm 저장 của dialog và đợi request ghi (`urlPart`) trả về; lưu thành công thì đợi thêm lượt list gọi lại
   * GET /stock-status (`reloaded`).
   */
  async save(dialog: StockDialog, urlPart: string): Promise<SaveOutcome> {
    const reload = this.page
      .waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && res.request().method() === 'GET', { timeout: 30_000 })
      .then(() => true, () => false);
    const response = this.page.waitForResponse((res) => res.url().includes(urlPart) && res.request().method() !== 'GET', { timeout: 60_000 });
    await dialog.clickSave();
    const res = await response;
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; detail?: string };
    const outcome: SaveOutcome = { status: res.status(), code: body.code ?? '', message: body.message ?? body.detail ?? '', requestBody: res.request().postDataJSON(), reloaded: false };
    if (outcome.status < 300) {
      outcome.reloaded = await reload;
      await this.waitForList();
    }
    return outcome;
  }

  /** Mọi request ghi (không phải GET) tới `urlPart` gửi đi từ lúc gọi — mảng được điền dần. */
  writeRequests(urlPart: string): Request[] {
    const requests: Request[] = [];
    this.page.on('request', (request) => {
      if (request.url().includes(urlPart) && request.method() !== 'GET') requests.push(request);
    });
    return requests;
  }

  /** Giữ mọi request ghi tới `urlPart` trong browser cho tới khi `release()` — thay cho throttling mạng. */
  async holdWrites(urlPart: string): Promise<HeldWrites> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: Request[] = [];
    const pattern = `**${urlPart}`;
    const handler = async (route: Route) => {
      if (route.request().method() === 'GET') {
        await route.fallback();
        return;
      }
      requests.push(route.request());
      await gate;
      await route.continue();
    };
    await this.page.route(pattern, handler);
    return { requests, release, dispose: () => this.page.unroute(pattern, handler) };
  }

  /**
   * Bấm đúp 저장 trong lúc request ghi đầu tiên bị giữ lại: đọc trạng thái nút ngay sau cú bấm đầu, rồi thả request,
   * đợi server trả lời và list tải lại. Trả về số request ghi đã gửi.
   */
  async doubleClickSave(dialog: StockDialog, urlPart: string): Promise<{ disabledAfterFirst: boolean; requestCount: number }> {
    const held = await this.holdWrites(urlPart);
    const reload = this.page
      .waitForResponse((res) => res.url().includes('/api/v1/stock-status?') && res.request().method() === 'GET', { timeout: 60_000 })
      .then(() => true, () => false);
    const answered = this.page.waitForResponse((res) => res.url().includes(urlPart) && res.request().method() !== 'GET', { timeout: 60_000 });
    try {
      await dialog.saveButton.dblclick();
      await expect.poll(() => held.requests.length, { message: 'The save request must be sent' }).toBeGreaterThan(0);
      const disabledAfterFirst = await dialog.saveButton.isDisabled();
      held.release();
      await answered;
      await reload;
      await this.waitForList();
      return { disabledAfterFirst, requestCount: held.requests.length };
    } finally {
      held.release();
      await held.dispose();
    }
  }

  /** Request ghi tới server rồi cắt kết nối trước khi trình duyệt nhận câu trả lời. */
  async cutAnswerOf(urlPart: string): Promise<() => Promise<void>> {
    const pattern = `**${urlPart}`;
    const handler = async (route: Route) => {
      if (route.request().method() === 'GET') {
        await route.fallback();
        return;
      }
      await route.fetch().catch(() => undefined);
      await route.abort('internetdisconnected');
    };
    await this.page.route(pattern, handler);
    return () => this.page.unroute(pattern, handler);
  }

  /** Vị trí dòng trong dialog theo SKU코드 + tên kho (cột 1 và 3 của dialog). */
  async dialogRowIndex(dialog: StockDialog, skuCode: string, warehouseName: string): Promise<number> {
    const count = await dialog.rows.count();
    for (let index = 0; index < count; index += 1) {
      const cells = (await dialog.rows.nth(index).locator('td').allTextContents()).map((text) => text.trim());
      if (cells[0] === skuCode && cells[2] === warehouseName) return index;
    }
    throw new Error(`The dialog has no line for ${skuCode} @ ${warehouseName}`);
  }

  /** 4 ô ánh xạ (SKU 코드 · SKU명 · 창고 · 전체 재고) của dòng dialog. */
  async dialogMappedCells(index: number): Promise<string[]> {
    return (await this.adjustment.rows.nth(index).locator('td').allTextContents()).slice(0, 4).map((text) => text.trim());
  }

  /** Số control nhập được trong 4 ô ánh xạ của dòng dialog. */
  async editableInMappedCells(index: number): Promise<number> {
    let count = 0;
    for (let cell = 0; cell < 4; cell += 1) {
      count += await this.adjustment.rows.nth(index).locator('td').nth(cell).locator('input, select, textarea, [contenteditable="true"]').count();
    }
    return count;
  }

  /** Feedback lỗi hiện dưới ô của dòng dialog (text đúng câu `text`). */
  lineFeedback(index: number, text: string): Locator {
    return this.adjustment.rows.nth(index).locator('.invalid-feedback', { hasText: text });
  }

  /** Bộ đếm ký tự "n/100" dưới ô 비고. */
  noteCounter(index = 0): Locator {
    return this.adjustment.rows.nth(index).locator('.text-muted.small');
  }

  /** Lựa chọn của select 조정사유 (gồm placeholder). */
  async reasonOptions(index = 0): Promise<Array<{ value: string; label: string }>> {
    return this.adjustment.reasonSelect(index).locator('option').evaluateAll((options) =>
      options.map((option) => ({ value: (option as HTMLOptionElement).value, label: (option.textContent ?? '').trim() })),
    );
  }

  /** Radio 관리함 / 관리안함 của dòng dialog 창고별 상세. */
  managedRadio(index: number, managed: boolean): Locator {
    return this.detail.rows.nth(index).locator(`#cs-${index}-${managed ? 'MANAGED' : 'UNMANAGED'}`);
  }

  /** Rê chuột lên nút đang khoá (qua span bọc ngoài) và đọc tooltip. */
  async lockTooltip(button: Locator): Promise<string> {
    await button.locator('xpath=..').hover();
    const tip = this.page.locator('.tooltip.show .tooltip-inner').last();
    await expect(tip, 'A tooltip must appear on the locked button').toBeVisible();
    const text = squash(await tip.innerText());
    await this.page.mouse.move(0, 0);
    return text;
  }

  /** Bấm 재고이력 của dòng và đợi bảng lịch sử tải xong. */
  async openHistoryOf(row: Locator, lang: StockLang = this.lang): Promise<void> {
    await this.openHistory(row);
    await this.history.waitOpen(lang);
    await this.history.waitLoaded();
  }

  async closeHistory(): Promise<void> {
    await this.history.close();
    await this.history.expectClosed();
  }

  /** Các dòng biến động đang hiển thị trong dialog 재고이력 (bỏ dòng "검색 결과가 없습니다."), mới nhất trước. */
  async historyLines(): Promise<HistoryLine[]> {
    const lines: HistoryLine[] = [];
    for (const row of await this.history.rows.all()) {
      const cells = (await row.locator('td').allTextContents()).map((text) => text.trim());
      if (cells.length !== HISTORY_COLUMNS.length) continue;
      lines.push(Object.fromEntries(HISTORY_COLUMNS.map((key, index) => [key, cells[index]])) as HistoryLine);
    }
    return lines;
  }

  async historyContext(): Promise<string> {
    return squash(await this.history.contextLine.textContent());
  }

  /** Trang đang sáng của pager trong dialog 재고이력 (bỏ chữ ẩn "(current)" react-bootstrap gắn vào trang đang chọn). */
  async historyActivePage(): Promise<string> {
    return pageNumber(await this.history.pagination.locator('li.active, li[aria-current="page"]').first().textContent());
  }

  /** Chuyển trang của pager trong dialog 재고이력 và đợi lịch sử tải lại. */
  async historyGoToPage(name: string): Promise<void> {
    const response = this.page.waitForResponse((res) => res.url().includes('/api/v1/stock-usages?') && res.request().method() === 'GET', { timeout: 30_000 });
    await this.click(this.history.pagination.getByRole('button', { name, exact: true }), `history page button ${name}`);
    await response;
    await this.history.waitLoaded();
  }

  /** Trang đang sáng của pager list. */
  async listActivePage(): Promise<string> {
    return pageNumber(await this.activePage.first().textContent());
  }
}

/** Số trang của mục pager đang sáng — bỏ chữ ẩn "(current)" cho screen reader. */
function pageNumber(text: string | null): string {
  return squash((text ?? '').replace(/\(current\)/i, ''));
}

/** Tạo 1 현물 SKU riêng (Partner A · M1, 1 dòng) và dựng tồn kho của nó ở `warehouseId` bằng DB. */
export async function ownStockSku(world: StockWorld, label: string, warehouseId: number, buckets: StockBuckets, option?: string): Promise<WorldSku> {
  const [sku] = await world.createPhysicalSku(label, {
    partner: world.partners.A,
    manufacturer: world.manufacturers.M1,
    groupName: ownGroupName(world, label),
    lines: [option ? { option } : {}],
  });
  await stockDb.upsertStock(sku.skuId, warehouseId, buckets);
  return sku;
}

/** Tạo 1 nhóm 현물 riêng có `count` dòng SKU (옵션 "Line n") — nhãn ≤ 4 ký tự để mã ≤ 20 ký tự không bị cắt trùng. */
export async function ownSkuLines(world: StockWorld, label: string, count: number): Promise<WorldSku[]> {
  return world.createPhysicalSku(label, {
    partner: world.partners.A,
    manufacturer: world.manufacturers.M1,
    groupName: ownGroupName(world, label),
    lines: Array.from({ length: count }, (_, index) => ({ option: `Line ${index + 1}` })),
  });
}

/** Kho CJ Daegu của world — dev không dựng được kênh CJ_LOGISTICS_DT thì dùng kho General automation. */
export function daeguOf(world: StockWorld): WorldWarehouse {
  return world.warehouses.DAEGU ?? world.warehouses.GENERAL;
}

export interface UsageSeed {
  refType: 'INCOMING' | 'OUTGOING' | 'ADJUSTMENT';
  type: string;
  refId?: number;
  before: number;
  delta: number;
  after: number;
  memo?: string | null;
  createdBy?: string;
  createdIp?: string;
  createdAt?: Date;
}

/**
 * Chèn 1 dòng 재고이력 (`stock_usage`) bằng DB cho tồn kho của SKU riêng — biến động màn này không tạo được (입고 /
 * 출고 do hệ thống khác ghi). Trả về `ref_id` (số chứng từ). Teardown `purgeSkus` xoá theo SKU.
 */
export async function seedUsage(sku: WorldSku, warehouseId: number, usage: UsageSeed): Promise<number> {
  const stock = await stockDb.stock(sku.skuId, warehouseId);
  if (!stock) throw new Error(`Test data setup failed — SKU ${sku.skuCode} has no stock row in warehouse ${warehouseId}`);
  const refId = usage.refId ?? newDbId();
  const createdAt = usage.createdAt ?? new Date();
  await stockDb.exec(
    `INSERT INTO stock_usage (id, ref_id, sku_id, stock_id, ref_type, type, after_quantity, before_quantity, delta, created_at, updated_at,
       created_by, created_ip, updated_by, updated_ip, memo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newDbId(), refId, sku.skuId, stock.id, usage.refType, usage.type, usage.after, usage.before, usage.delta, createdAt, createdAt,
      usage.createdBy ?? DB_ACTOR.by, usage.createdIp ?? DB_ACTOR.ip, DB_ACTOR.by, DB_ACTOR.ip, usage.memo ?? null],
  );
  return refId;
}

/**
 * Gắn mã tham chiếu ngoài (`incoming.external_ref_id`) và memo dòng SKU (`incoming_item.memo`) cho phiếu 입고 fixture.
 * Server tự ghép 비고 của biến động 입고 thành "입고외부연동ID:{mã ngoài}/{…}" (verify GET /stock-usages 05/10: memo của
 * `stock_usage` luôn rỗng ở dữ liệu thật), nên memo phải nằm trên phiếu chứ không nằm trên dòng lịch sử.
 */
export async function annotateIncoming(incomingId: number | string, skuId: number, externalRefId: string, memo: string): Promise<void> {
  await stockDb.exec('UPDATE incoming SET external_ref_id = ? WHERE id = ?', [externalRefId, incomingId]);
  await stockDb.exec('UPDATE incoming_item SET memo = ? WHERE incoming_id = ? AND sku_id = ?', [memo, incomingId, skuId]);
}

/**
 * Chèn phiếu 출고 (`outgoing`, id = `ref_id` của biến động 출고 fixture) để server ghép 비고 "배송/현장수령ID:{shipping_id}"
 * như dữ liệu thật. Trả về mã giao hàng (shipping id) và hàm xoá phiếu (gọi trong `finally`).
 */
export async function seedOutgoing(sku: WorldSku, warehouseId: number, outgoingId: number | string): Promise<{ shippingId: string; remove: () => Promise<void> }> {
  const shippingId = newDbId();
  await stockDb.exec(
    `INSERT INTO outgoing (id, biz_partner_id, shipping_id, warehouse_id, fulfillment_type, method, ref_type, status, type, note, version,
       created_at, updated_at, created_by, created_ip, updated_by, updated_ip)
     VALUES (?, ?, ?, ?, 'B2C', 'PARCEL', 'ORDER_BUNDLE', 'COMPLETED', 'ORDER', '', 0, NOW(6), NOW(6), ?, ?, ?, ?)`,
    [outgoingId, sku.partner.id, shippingId, warehouseId, DB_ACTOR.by, DB_ACTOR.ip, DB_ACTOR.by, DB_ACTOR.ip],
  );
  return { shippingId: String(shippingId), remove: async () => { await stockDb.exec('DELETE FROM outgoing WHERE id = ? AND created_by = ?', [outgoingId, DB_ACTOR.by]); } };
}

/** Chèn `count` biến động 조정완료 cách nhau 1 phút (đủ để lịch sử sang trang 2). */
export async function seedAdjustmentUsages(sku: WorldSku, warehouseId: number, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await seedUsage(sku, warehouseId, { refType: 'ADJUSTMENT', type: 'ADJUSTMENT_COMPLETED', before: index, delta: 1, after: index + 1, memo: `ADJUSTMENT/fixture ${index + 1}`, createdAt: minutesAgo(count - index) });
  }
}
