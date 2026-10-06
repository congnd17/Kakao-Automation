import mysql, { Pool, RowDataPacket } from 'mysql2/promise';
import * as dotenv from 'dotenv';
import * as path from 'path';

/**
 * MySQL schema `settlement` (dev) — bảng procurement của US105 (`purchase_order`, `purchase_order_line`, `goods_receipt`,
 * cột verify 05/10/2026). Chỉ dùng cho TC mà pre-condition yêu cầu dựng trạng thái ở tầng dữ liệu (TC_120, TC_156) hoặc
 * đọc trường không có trên API (TC_132 `goods_receipt.source`) — người dùng cho phép ghi DB (05/10), CHỈ trên PO của
 * kho automation. Thông tin kết nối đọc từ `.env` — KHÔNG log, KHÔNG đính kèm report.
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
    if (!DB_HOST || !DB_USER || !DB_PASSWORD) throw new Error('MySQL connection is not configured (DB_HOST / DB_USER / DB_PASSWORD missing in .env)');
    pool = mysql.createPool({ host: DB_HOST, port: Number(DB_PORT ?? 3306), database: DB_NAME ?? 'settlement', user: DB_USER, password: DB_PASSWORD, connectionLimit: 2, connectTimeout: 15_000, timezone: 'Z' });
  }
  return pool;
}

export function hasDbCredentials(): boolean {
  return !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD);
}

export const purchaseOrderDb = {
  /** Đọc `status` của PO trực tiếp. */
  async status(poId: number): Promise<string | undefined> {
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT status FROM purchase_order WHERE id = ?', [poId]);
    return rows[0]?.status as string | undefined;
  },

  /** Ép trạng thái PO ở tầng dữ liệu (bỏ qua guard của API) — TC_156. Tăng lock_version như 1 lần ghi thật. */
  async forceStatus(poId: number, status: 'CLOSED' | 'CANCELED' | 'ISSUED'): Promise<void> {
    await getPool().query('UPDATE purchase_order SET status = ?, lock_version = lock_version + 1 WHERE id = ?', [status, poId]);
  },

  /** Đổi manufacturer_id của PO trực tiếp — dựng "đơn cũ trước BR-22" cho TC_120. */
  async setManufacturer(poId: number, manufacturerId: number | null): Promise<void> {
    await getPool().query('UPDATE purchase_order SET manufacturer_id = ?, lock_version = lock_version + 1 WHERE id = ?', [manufacturerId, poId]);
  },

  /** Nguồn receipt do server đóng dấu (`MANUAL` / `LOGISTICS`) — TC_132. */
  async receiptSource(grnId: number): Promise<string | undefined> {
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT source FROM goods_receipt WHERE id = ?', [grnId]);
    return rows[0]?.source as string | undefined;
  },

  /** Hai snapshot tên 공급처 lưu trên PO — TC_122 / TC_125. */
  async supplierNames(poId: number): Promise<{ ko: string | null; en: string | null } | undefined> {
    const [rows] = await getPool().query<RowDataPacket[]>('SELECT supplier_name_ko, supplier_name_en FROM purchase_order WHERE id = ?', [poId]);
    return rows[0] ? { ko: rows[0].supplier_name_ko as string | null, en: rows[0].supplier_name_en as string | null } : undefined;
  },

  async close(): Promise<void> {
    await pool?.end();
    pool = undefined;
  },
};
