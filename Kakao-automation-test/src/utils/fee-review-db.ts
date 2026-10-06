import mysql, { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import * as dotenv from 'dotenv';
import * as path from 'path';

/**
 * MySQL schema `settlement` (dev) — seed / dọn bảng fixture của US079 (`input/TESTCASE_US079_v1.md`, pre-condition "SQL:").
 * Thông tin kết nối đọc từ `.env` (DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD) — KHÔNG log, KHÔNG đính kèm report.
 * Verify 01/10: account `settlement_dev` có SELECT/INSERT/UPDATE/DELETE trên `settlement.*`.
 */
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export interface FixtureProduct {
  productId: string;
  productName: string;
  contractId: number | null;
  categoryId: number | null;
  saleTypeId: number | null;
  defaultSlotFeeRowId: number | null;
  promotionSlotFeeRowId: number | null;
}

export interface FixtureTarget {
  cycleId: number;
  productId: string;
  policy: 'NORMAL' | 'PROMOTION';
  saleLineCount: number;
}

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    const { DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD } = process.env;
    if (!DB_HOST || !DB_USER || !DB_PASSWORD) throw new Error('MySQL connection is not configured (DB_HOST / DB_USER / DB_PASSWORD missing in .env)');
    pool = mysql.createPool({ host: DB_HOST, port: Number(DB_PORT ?? 3306), database: DB_NAME ?? 'settlement', user: DB_USER, password: DB_PASSWORD, connectionLimit: 2, connectTimeout: 15_000, timezone: 'Z' });
  }
  return pool;
}

export const feeReviewDb = {
  async query<T extends RowDataPacket[]>(sql: string, params: unknown[] = []): Promise<T> {
    const [rows] = await getPool().query<T>(sql, params);
    return rows;
  },

  async execute(sql: string, params: unknown[] = []): Promise<number> {
    const [result] = await getPool().query<ResultSetHeader>(sql, params);
    return result.affectedRows;
  },

  async insertProducts(products: FixtureProduct[]): Promise<void> {
    if (!products.length) return;
    await this.execute(
      'INSERT INTO fee_review_fixture_product (product_id, product_name, contract_id, category_id, sale_type_id, default_slot_fee_row_id, promotion_slot_fee_row_id) VALUES ?',
      [products.map((p) => [p.productId, p.productName, p.contractId, p.categoryId, p.saleTypeId, p.defaultSlotFeeRowId, p.promotionSlotFeeRowId])],
    );
  },

  async insertTargets(targets: FixtureTarget[]): Promise<void> {
    if (!targets.length) return;
    await this.execute(
      'INSERT INTO fee_review_fixture_target (settlement_cycle_id, product_id, policy, sale_line_count) VALUES ?',
      [targets.map((t) => [t.cycleId, t.productId, t.policy, t.saleLineCount])],
    );
  },

  async updateProduct(productId: string, fields: Partial<Omit<FixtureProduct, 'productId'>>): Promise<void> {
    const columns: Record<string, string> = { productName: 'product_name', contractId: 'contract_id', categoryId: 'category_id', saleTypeId: 'sale_type_id', defaultSlotFeeRowId: 'default_slot_fee_row_id', promotionSlotFeeRowId: 'promotion_slot_fee_row_id' };
    const entries = Object.entries(fields).filter(([key]) => key in columns);
    if (!entries.length) return;
    await this.execute(`UPDATE fee_review_fixture_product SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE product_id = ?`, [...entries.map(([, v]) => v), productId]);
  },

  /**
   * Dọn mọi dữ liệu xoá được của 1 tiền tố sản phẩm (pre-condition "Cleanup after the run" của TC): history → change_approval
   * Fee Rule → correction → target → product. Contract và cycle KHÔNG có API xoá → giữ lại (TC ghi rõ).
   */
  async cleanupPrefix(prefix: string): Promise<void> {
    const like = `${prefix}%`;
    await this.execute('DELETE FROM fee_correction_history WHERE product_id LIKE ?', [like]);
    await this.execute("DELETE FROM change_approval WHERE target_type = 'FEE_RULE' AND target_ref LIKE ?", [`%/${like}`]);
    await this.execute('DELETE FROM fee_correction WHERE product_id LIKE ?', [like]);
    await this.execute('DELETE FROM fee_review_fixture_target WHERE product_id LIKE ?', [like]);
    await this.execute('DELETE FROM fee_review_fixture_product WHERE product_id LIKE ?', [like]);
  },

  async close(): Promise<void> {
    await pool?.end();
    pool = undefined;
  },
};
