import { Locator, Page, Request, expect, test } from '@playwright/test';
import { StockColumnKey, StockListPage } from './stock-list.page';
import type { StockLang } from '@utils/stock.i18n';
import type { StockWorld, WorldSku, WorldWarehouse } from '@utils/stock.data';
import { DB_ACTOR, newDbId, stockDb } from '@utils/stock-db';

/**
 * Nhóm [Stock Quantity Calculation] + [Integration] của US134 — thao tác bổ sung trên màn 재고 관리 dùng cho kiểm số liệu:
 * 10 cột số (render `qo()` = toLocaleString, class `text-end`; không có bản ghi tồn kho → "-"), 2 cột CS (`due()`:
 * cờ CS bật → số; tắt + kho CJ / CJ 대구 → 관리안함; kho khác → "-"), tooltip tiêu đề = thuộc tính `title`. Bundle 05/10/2026.
 */
export const NUMERIC_COLUMNS: readonly StockColumnKey[] = [
  'col.totalQuantity', 'col.reservedQuantity', 'col.availableQuantity', 'col.csQuantity', 'col.csOrderableQuantity',
  'col.pendingAllocationQuantity', 'col.orderableQuantity', 'col.incomingQuantity', 'col.insufficientQuantity', 'col.unconfirmedQuantity',
];

/** Thu gọn khoảng trắng (tooltip lưu `\n` giữa 2 câu, TC viết liền 1 dòng). */
export const squash = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/** Ô số âm thật sự (dấu trừ + chữ số) — "-" đứng một mình là ô không có bản ghi, không phải số âm. */
export const isNegativeNumber = (text: string): boolean => /^[-−]\s*\d/.test(text.trim());

/** Số đã format (VD "1,234,567") → number. */
export const toNumber = (text: string): number => Number(text.replace(/,/g, ''));

/** 1 request API màn này gửi — dùng cho TC kiểm host / header / tham số. */
export interface CapturedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
}

export class StockCalculationPage extends StockListPage {
  constructor(page: Page) {
    super(page);
  }

  /** Mở list, lọc 상품코드명 = tag run (12 dòng world) và hiện 20 dòng/trang để thấy đủ 12 dòng. */
  async openWorld(world: StockWorld, lang: StockLang = 'ko'): Promise<void> {
    await test.step('Open the stock list filtered to the demo world (20 rows per page)', async () => {
      await this.open(lang);
      await this.search('SKU_GROUP_NAME', world.keyword);
      await this.choosePageSize(20);
    });
  }

  /** Tìm 1 SKU theo SKU코드 (mã duy nhất của suite). */
  async findSku(sku: WorldSku): Promise<void> {
    await this.search('SKU_CODE', sku.skuCode);
  }

  async tooltipText(column: StockColumnKey): Promise<string> {
    return squash(await this.headerTooltip(column).getAttribute('title'));
  }

  /** Text 10 ô số của dòng theo đúng thứ tự cột. */
  async numericTexts(row: Locator): Promise<string[]> {
    const values: string[] = [];
    for (const column of NUMERIC_COLUMNS) values.push(await this.cellText(row, column));
    return values;
  }

  /** text-align thực tế (computed) của 10 ô số. */
  async numericAlignments(row: Locator): Promise<string[]> {
    const values: string[] = [];
    for (const column of NUMERIC_COLUMNS) values.push(await this.cell(row, column).evaluate((el) => getComputedStyle(el).textAlign));
    return values;
  }

  /** Mọi dòng dữ liệu đang hiển thị (bỏ dòng "검색 결과가 없습니다."). */
  async dataRows(): Promise<Locator[]> {
    const rows: Locator[] = [];
    for (const row of await this.bodyRows.all()) if ((await row.locator('td').count()) > 1) rows.push(row);
    return rows;
  }

  /** Tên các lựa chọn của select 대구분 (gồm 전체). */
  async warehouseGroupOptions(): Promise<string[]> {
    return (await this.warehouseGroupSelect.locator('option').allInnerTexts()).map((text) => text.trim());
  }

  /** Mục sidebar đang sáng: class `active` trên link hoặc trên `li` chứa nó. */
  async isSidebarLit(name: string): Promise<boolean> {
    return this.sidebarLink(name).evaluate((link) => /\bactive\b|mm-active/.test(`${link.className} ${link.closest('li')?.className ?? ''}`));
  }

  /** Nhóm sidebar đang mở (danh sách con hiển thị). */
  async isSidebarGroupOpen(name: string): Promise<boolean> {
    return this.sidebarLink(name).locator('xpath=ancestor::li[1]/ul').isVisible();
  }

  /** Mở nhóm sidebar nếu đang đóng. */
  async expandSidebarGroup(name: string): Promise<void> {
    if (!(await this.isSidebarGroupOpen(name))) await this.click(this.sidebarLink(name), `${name} group in the sidebar`);
  }

  /** Bắt đầu ghi mọi request `/api/` của trang (host, method, header) — trả về mảng được điền dần. */
  captureApiCalls(): CapturedCall[] {
    const calls: CapturedCall[] = [];
    this.page.on('request', (request: Request) => {
      if (!request.url().includes('/api/')) return;
      calls.push({ method: request.method(), url: request.url(), headers: request.headers() });
    });
    return calls;
  }

  /** Text guard hiện phía trên bảng sau khi bấm 1 nút toolbar (đợi guard hiện). */
  async guardTextAfter(key: 'btn.incomingRequest' | 'btn.adjustStock' | 'btn.convertStock' | 'btn.warehouseDetail'): Promise<string> {
    await this.clickToolbar(key);
    await expect(this.guardAlert, `A guard message must appear after clicking ${this.t(key)}`).toBeVisible();
    return squash(await this.guardAlert.innerText());
  }
}

/** Tên nhóm SKU riêng của test — KHÔNG chứa nguyên tag run để không lọt vào bộ lọc 12 dòng world (`world.keyword`). */
export function ownGroupName(world: StockWorld, label: string): string {
  return `${label} run ${world.tag.slice(4)}`;
}

/** Tạo 1 현물 SKU riêng (Partner A · M1) cho test cần ghi dữ liệu. */
export async function ownPhysicalSku(world: StockWorld, label: string, manufacturer = world.manufacturers.M1): Promise<WorldSku> {
  const [sku] = await world.createPhysicalSku(label, { partner: world.partners.A, manufacturer, groupName: ownGroupName(world, label) });
  return sku;
}

/** Dạng WorldWarehouse cho kho không thuộc world (kho test tự tạo / kho ảo). */
export function asWorldWarehouse(warehouse: { id: number; name: string; category?: string | null }): WorldWarehouse {
  return { id: warehouse.id, name: warehouse.name, category: warehouse.category ?? '', buckets: [] };
}

export type IncomingSeedType = 'PURCHASE_ORDER' | 'TRANSFER' | 'ASSEMBLY';
export type IncomingSeedStatus = 'REQUESTED' | 'REGISTERED';

/**
 * Chèn 1 phiếu 입고 (header + 1 dòng) bằng DB cho SKU của suite — dựng đúng trạng thái/loại TC cần (UI chỉ tạo REQUESTED,
 * không tạo ASSEMBLY / REGISTERED). Teardown `purgeSkus` xoá theo SKU.
 */
export async function seedIncoming(
  sku: WorldSku,
  warehouseId: number,
  line: { type: IncomingSeedType; status: IncomingSeedStatus; quantity: number },
): Promise<number> {
  const incomingId = newDbId();
  await stockDb.exec(
    `INSERT INTO incoming (id, biz_partner_id, warehouse_id, ref_type, status, transport_type, type, request_date, note, version,
       created_at, updated_at, created_by, created_ip, updated_by, updated_ip)
     VALUES (?, ?, ?, 'NONE', ?, 'NORMAL', ?, DATE_ADD(CURDATE(), INTERVAL 7 DAY), ?, 0, NOW(6), NOW(6), ?, ?, ?, ?)`,
    [incomingId, sku.partner.id, warehouseId, line.status, line.type, `${DB_ACTOR.by} ${sku.skuCode}`, DB_ACTOR.by, DB_ACTOR.ip, DB_ACTOR.by, DB_ACTOR.ip],
  );
  await stockDb.exec(
    `INSERT INTO incoming_item (id, incoming_id, sku_id, ref_type, requested_quantity, purchase_currency, purchase_price,
       created_at, updated_at, created_by, created_ip, updated_by, updated_ip)
     VALUES (?, ?, ?, 'NONE', ?, 'KRW', 1000, NOW(6), NOW(6), ?, ?, ?, ?)`,
    [newDbId(), incomingId, sku.skuId, line.quantity, DB_ACTOR.by, DB_ACTOR.ip, DB_ACTOR.by, DB_ACTOR.ip],
  );
  return incomingId;
}

/** Ngày YYYY-MM-DD sau hôm nay `days` ngày (ngày dự kiến nhập kho). */
export function futureDate(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  return date.toISOString().slice(0, 10);
}
