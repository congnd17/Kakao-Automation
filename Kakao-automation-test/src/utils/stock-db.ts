import mysql, { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import * as dotenv from 'dotenv';
import * as path from 'path';

/**
 * MySQL schema `settlement` (dev) — bảng tồn kho của US134 (`stock`, `sku`, `sku_group`, `stock_usage`, `adjustment`,
 * `stock_conversion`, `incoming`, `incoming_item`, `manufacturer`, `bundled_sku`; cột verify 05/10/2026).
 * Người dùng cho phép ghi DB (05/10) CHỈ trên dữ liệu suite tự tạo: dựng đúng các ngăn tồn kho (가용 / 보류 / CS / 할당)
 * mà UI không tạo được, ép trạng thái cho TC phía server, và dọn sạch ở teardown.
 * Thông tin kết nối đọc từ `.env` — KHÔNG log, KHÔNG đính kèm report.
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
    if (!DB_HOST || !DB_USER || !DB_PASSWORD) throw new Error('MySQL connection is not configured (DB_HOST / DB_USER / DB_PASSWORD missing in .env)');
    pool = mysql.createPool({ host: DB_HOST, port: Number(DB_PORT ?? 3306), database: DB_NAME ?? 'settlement', user: DB_USER, password: DB_PASSWORD, connectionLimit: 3, connectTimeout: 15_000, timezone: 'Z', supportBigNumbers: true });
  }
  return pool;
}

export function hasStockDb(): boolean {
  return !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD);
}

/** Người tạo/IP ghi vào bản ghi do DB fixture dựng — nhìn vào DB biết ngay dòng nào là của automation. */
export const DB_ACTOR = { by: 'automation-US134', ip: '127.0.0.1' } as const;

let idCounter = 0;

/** ID 15 chữ số cho bản ghi chèn trực tiếp (bảng không AUTO_INCREMENT) — dải 8xx… không đụng ID app sinh (4xx…). */
export function newDbId(): number {
  idCounter = (idCounter + 1) % 1000;
  return 800_000_000_000_000 + (Date.now() % 100_000_000_000) * 1000 + idCounter;
}

export interface StockBuckets {
  available: number;
  hold?: number;
  reserved?: number;
  cs?: number;
  csManaged?: boolean;
}

export interface StockDbRow {
  id: number;
  sku_id: number;
  warehouse_id: number;
  available_quantity: number;
  hold_quantity: number;
  physical_quantity: number;
  reserved_quantity: number;
  cs_quantity: number;
  cs_stock_managed: number;
  version: number;
}

export interface StockUsageDbRow {
  id: number;
  ref_id: number;
  sku_id: number;
  stock_id: number;
  ref_type: string;
  type: string;
  before_quantity: number;
  delta: number;
  after_quantity: number;
  memo: string | null;
  created_by: string;
  created_ip: string;
  created_at: Date;
}

export const stockDb = {
  /** SELECT tuỳ ý (TC đọc trường không có trên API). */
  async query<T extends RowDataPacket = RowDataPacket>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await getPool().query<T[]>(sql, params);
    return rows;
  },

  /** INSERT/UPDATE/DELETE tuỳ ý — CHỈ trên dữ liệu suite tự tạo. */
  async exec(sql: string, params: unknown[] = []): Promise<number> {
    const [result] = await getPool().query<ResultSetHeader>(sql, params);
    return result.affectedRows;
  },

  /**
   * Dựng / ghi đè bản ghi tồn kho (SKU × kho) với đúng các ngăn yêu cầu. 전체재고 (physical) = 가용 + 보류 + 할당 + CS.
   * Trả về id bản ghi `stock`.
   */
  async upsertStock(skuId: number, warehouseId: number, buckets: StockBuckets): Promise<number> {
    const hold = buckets.hold ?? 0;
    const reserved = buckets.reserved ?? 0;
    const cs = buckets.cs ?? 0;
    const physical = buckets.available + hold + reserved + cs;
    const existing = await this.stock(skuId, warehouseId);
    if (existing) {
      await getPool().query(
        `UPDATE stock SET available_quantity = ?, hold_quantity = ?, reserved_quantity = ?, cs_quantity = ?, physical_quantity = ?,
           cs_stock_managed = ?, version = version + 1, updated_at = NOW(6), updated_by = ?, updated_ip = ? WHERE id = ?`,
        [buckets.available, hold, reserved, cs, physical, buckets.csManaged ? 1 : 0, DB_ACTOR.by, DB_ACTOR.ip, existing.id],
      );
      return existing.id;
    }
    const id = newDbId();
    await getPool().query(
      `INSERT INTO stock (id, sku_id, warehouse_id, available_quantity, hold_quantity, physical_quantity, reserved_quantity, version,
         created_at, updated_at, created_by, created_ip, updated_by, updated_ip, cs_quantity, cs_stock_managed)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, NOW(6), NOW(6), ?, ?, ?, ?, ?, ?)`,
      [id, skuId, warehouseId, buckets.available, hold, physical, reserved, DB_ACTOR.by, DB_ACTOR.ip, DB_ACTOR.by, DB_ACTOR.ip, cs, buckets.csManaged ? 1 : 0],
    );
    return id;
  },

  async stock(skuId: number, warehouseId: number): Promise<StockDbRow | undefined> {
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT * FROM stock WHERE sku_id = ? AND warehouse_id = ?', [skuId, warehouseId]);
    return rows[0] as StockDbRow | undefined;
  },

  async stocksOfSku(skuId: number): Promise<StockDbRow[]> {
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT * FROM stock WHERE sku_id = ? ORDER BY id', [skuId]);
    return rows as StockDbRow[];
  },

  /** Xoá bản ghi tồn kho (TC "record deleted after the dialog opens") — kèm lịch sử của nó. */
  async deleteStock(skuId: number, warehouseId: number): Promise<void> {
    const row = await this.stock(skuId, warehouseId);
    if (!row) return;
    await getPool().query('DELETE FROM stock_usage WHERE stock_id = ?', [row.id]);
    await getPool().query('DELETE FROM stock WHERE id = ?', [row.id]);
  },

  /** Lịch sử biến động (재고이력) của 1 cặp SKU × kho, mới nhất trước. */
  async usages(skuId: number, warehouseId: number): Promise<StockUsageDbRow[]> {
    const [rows] = await getPool().query<RowDataPacket[]>(
      'SELECT u.* FROM stock_usage u JOIN stock s ON s.id = u.stock_id WHERE s.sku_id = ? AND s.warehouse_id = ? ORDER BY u.created_at DESC, u.id DESC',
      [skuId, warehouseId],
    );
    return rows as StockUsageDbRow[];
  },

  async adjustments(skuId: number, warehouseId?: number): Promise<RowDataPacket[]> {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT * FROM adjustment WHERE sku_id = ?${warehouseId === undefined ? '' : ' AND warehouse_id = ?'} ORDER BY created_at DESC, id DESC`,
      warehouseId === undefined ? [skuId] : [skuId, warehouseId],
    );
    return rows;
  },

  async conversions(skuId: number, warehouseId?: number): Promise<RowDataPacket[]> {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT * FROM stock_conversion WHERE sku_id = ?${warehouseId === undefined ? '' : ' AND warehouse_id = ?'} ORDER BY created_at DESC, id DESC`,
      warehouseId === undefined ? [skuId] : [skuId, warehouseId],
    );
    return rows;
  },

  /** Phiếu 입고 (header + dòng) của 1 SKU, mới nhất trước. */
  async incomingsOfSku(skuId: number): Promise<RowDataPacket[]> {
    const [rows] = await getPool().query<RowDataPacket[]>(
      `SELECT i.id AS incoming_id, i.status, i.type, i.warehouse_id, i.request_date, i.note, i.biz_partner_id, ii.id AS item_id,
              ii.requested_quantity, ii.incoming_quantity, ii.missing_quantity, ii.purchase_price, ii.purchase_currency, ii.memo
         FROM incoming i JOIN incoming_item ii ON ii.incoming_id = i.id WHERE ii.sku_id = ? ORDER BY i.created_at DESC, i.id DESC`,
      [skuId],
    );
    return rows;
  },

  async sku(skuId: number): Promise<RowDataPacket | undefined> {
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT * FROM sku WHERE id = ?', [skuId]);
    return rows[0];
  },

  async skuGroup(groupId: number): Promise<RowDataPacket | undefined> {
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT * FROM sku_group WHERE id = ?', [groupId]);
    return rows[0];
  },

  /** Xoá mềm SKU (deleted_at) — TC "SKU deleted after selection / soft-deleted SKU". */
  async softDeleteSku(skuId: number): Promise<void> {
    await getPool().query('UPDATE sku SET deleted_at = NOW(6), deleted_by = ?, deleted_ip = ? WHERE id = ? AND deleted_at IS NULL', [DB_ACTOR.by, DB_ACTOR.ip, skuId]);
  },

  async softDeleteSkuGroup(groupId: number): Promise<void> {
    await getPool().query('UPDATE sku_group SET deleted_at = NOW(6), deleted_by = ?, deleted_ip = ? WHERE id = ? AND deleted_at IS NULL', [DB_ACTOR.by, DB_ACTOR.ip, groupId]);
  },

  /** Tạo 제조사 cho 1 비즈파트너 (màn này không có chức năng tạo 제조사). */
  async insertManufacturer(bizPartnerId: number, name: string): Promise<number> {
    const id = newDbId();
    await getPool().query(
      `INSERT INTO manufacturer (id, biz_partner_id, name, addr, corp_registration_no, corporate_phone, country, manager_name, manager_phone,
         representative_name, zip_code, created_at, updated_at, created_by, created_ip, updated_by, updated_ip)
       VALUES (?, ?, ?, 'Automation street 1', ?, '0212345678', 'KR', 'Automation', '01012345678', 'Automation', '04524', NOW(6), NOW(6), ?, ?, ?, ?)`,
      [id, bizPartnerId, name, String(id).slice(-10), DB_ACTOR.by, DB_ACTOR.ip, DB_ACTOR.by, DB_ACTOR.ip],
    );
    return id;
  },

  async deleteManufacturer(id: number): Promise<void> {
    await getPool().query('DELETE FROM manufacturer WHERE id = ? AND created_by = ?', [id, DB_ACTOR.by]);
  },

  /**
   * Dọn toàn bộ dấu vết tồn kho của các SKU suite tạo (lịch sử, 조정, 전환, 입고, mapping CJ, sổ cái, tồn kho) rồi xoá mềm
   * SKU + nhóm SKU — sau bước này kho automation không còn tham chiếu và xoá được qua API.
   */
  async purgeSkus(skuIds: number[], groupIds: number[]): Promise<void> {
    if (skuIds.length > 0) {
      const ids = [skuIds];
      await getPool().query('DELETE u FROM stock_usage u JOIN stock s ON s.id = u.stock_id WHERE s.sku_id IN (?)', ids);
      await getPool().query('DELETE FROM stock_usage WHERE sku_id IN (?)', ids);
      await getPool().query('DELETE FROM stock_conversion WHERE sku_id IN (?)', ids);
      await getPool().query('DELETE FROM adjustment WHERE sku_id IN (?)', ids);
      await getPool().query('DELETE FROM stock_ledger WHERE sku_id IN (?)', ids);
      await getPool().query('DELETE FROM stock_reservation WHERE sku_id IN (?)', ids);
      await getPool().query('DELETE FROM logistics_sku_mapping WHERE sku_id IN (?)', ids);
      const [incomings] = await getPool().query<RowDataPacket[]>('SELECT DISTINCT incoming_id FROM incoming_item WHERE sku_id IN (?)', ids);
      const incomingIds = incomings.map((row) => row.incoming_id as number);
      await getPool().query('DELETE FROM incoming_item WHERE sku_id IN (?)', ids);
      if (incomingIds.length > 0) {
        await getPool().query('DELETE FROM logistics_incoming_mapping WHERE incoming_id IN (?)', [incomingIds]).catch(() => undefined);
        await getPool().query('DELETE i FROM incoming i LEFT JOIN incoming_item ii ON ii.incoming_id = i.id WHERE i.id IN (?) AND ii.id IS NULL', [incomingIds]);
      }
      await getPool().query('DELETE FROM stock WHERE sku_id IN (?)', ids);
      await getPool().query('UPDATE sku SET deleted_at = NOW(6), deleted_by = ?, deleted_ip = ? WHERE id IN (?) AND deleted_at IS NULL', [DB_ACTOR.by, DB_ACTOR.ip, skuIds]);
    }
    if (groupIds.length > 0) {
      await getPool().query('UPDATE sku_group SET deleted_at = NOW(6), deleted_by = ?, deleted_ip = ? WHERE id IN (?) AND deleted_at IS NULL', [DB_ACTOR.by, DB_ACTOR.ip, groupIds]);
    }
  },

  /** Xoá mọi bản ghi tồn kho còn trỏ vào kho automation (kể cả SKU không do suite tạo, VD upload thử) trước khi xoá kho. */
  async purgeWarehouseStock(warehouseIds: number[]): Promise<void> {
    if (warehouseIds.length === 0) return;
    await getPool().query('DELETE u FROM stock_usage u JOIN stock s ON s.id = u.stock_id WHERE s.warehouse_id IN (?)', [warehouseIds]);
    await getPool().query('DELETE FROM stock_conversion WHERE warehouse_id IN (?)', [warehouseIds]);
    await getPool().query('DELETE FROM adjustment WHERE warehouse_id IN (?)', [warehouseIds]);
    await getPool().query('DELETE FROM stock_ledger WHERE warehouse_id IN (?)', [warehouseIds]);
    await getPool().query('DELETE FROM logistics_sku_mapping WHERE warehouse_id IN (?)', [warehouseIds]);
    await getPool().query('DELETE ii FROM incoming_item ii JOIN incoming i ON i.id = ii.incoming_id WHERE i.warehouse_id IN (?)', [warehouseIds]);
    await getPool().query('DELETE FROM incoming WHERE warehouse_id IN (?)', [warehouseIds]);
    await getPool().query('DELETE FROM stock WHERE warehouse_id IN (?)', [warehouseIds]);
  },

  async close(): Promise<void> {
    await pool?.end();
    pool = undefined;
  },
};
