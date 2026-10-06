/**
 * Dọn dữ liệu US134 còn sót khi 1 lần chạy bị ngắt giữa chừng (teardown của world không chạy / API bị 401).
 * CHỈ đụng dữ liệu automation: nhóm SKU có mã bắt đầu `T134`, kho có tên bắt đầu `T134`, 제조사 tạo bởi automation-US134.
 *   node scripts/cleanup-us134-data.js          → liệt kê (không xoá)
 *   node scripts/cleanup-us134-data.js --apply  → xoá: dấu vết tồn kho (DB) → kho (API DELETE) → xoá mềm SKU (DB)
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'node_modules', 'dotenv')).config({ path: path.join(ROOT, '.env') });
const mysql = require(path.join(ROOT, 'node_modules', 'mysql2', 'promise'));
const { request } = require(path.join(ROOT, 'node_modules', '@playwright', 'test'));

const API = process.env.API_BASE_URL || 'https://dev-settlement-admin-api.berriz.in';
const ACTOR = ['automation-US134', '127.0.0.1'];
const apply = process.argv.includes('--apply');

(async () => {
  const db = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  const [groups] = await db.query("SELECT id FROM sku_group WHERE code LIKE 'T134%'");
  const groupIds = groups.map((row) => row.id);
  const [skus] = groupIds.length ? await db.query('SELECT id FROM sku WHERE sku_group_id IN (?)', [groupIds]) : [[]];
  const skuIds = skus.map((row) => row.id);
  const [warehouses] = await db.query("SELECT id FROM warehouse WHERE name LIKE 'T134%'");
  const warehouseIds = warehouses.map((row) => row.id);
  console.log(`T134 SKU groups: ${groupIds.length}, SKUs: ${skuIds.length}, warehouses (incl. virtual): ${warehouseIds.length}`);
  if (!apply) {
    await db.end();
    console.log('Dry run — add --apply to delete.');
    return;
  }

  const del = async (sql, ids) => (ids.length ? (await db.query(sql, [ids]))[0].affectedRows : 0);
  for (const [label, ids, column] of [['SKU', skuIds, 'sku_id'], ['warehouse', warehouseIds, 'warehouse_id']]) {
    if (ids.length === 0) continue;
    await del(`DELETE u FROM stock_usage u JOIN stock s ON s.id = u.stock_id WHERE s.${column} IN (?)`, ids);
    for (const table of ['stock_conversion', 'adjustment', 'stock_ledger', 'logistics_sku_mapping']) await del(`DELETE FROM ${table} WHERE ${column} IN (?)`, ids);
    if (column === 'sku_id') {
      await del('DELETE FROM stock_usage WHERE sku_id IN (?)', ids);
      await del('DELETE FROM stock_reservation WHERE sku_id IN (?)', ids);
      await del('DELETE FROM incoming_item WHERE sku_id IN (?)', ids);
    } else {
      await del('DELETE ii FROM incoming_item ii JOIN incoming i ON i.id = ii.incoming_id WHERE i.warehouse_id IN (?)', ids);
      await del('DELETE FROM incoming WHERE warehouse_id IN (?)', ids);
    }
    console.log(`Removed stock rows by ${label}: ${await del(`DELETE FROM stock WHERE ${column} IN (?)`, ids)}`);
  }
  await db.query("DELETE i FROM incoming i LEFT JOIN incoming_item ii ON ii.incoming_id = i.id WHERE ii.id IS NULL AND i.created_by = 'automation-US134'").catch(() => undefined);
  if (skuIds.length) await db.query('UPDATE sku SET deleted_at = NOW(6), deleted_by = ?, deleted_ip = ? WHERE id IN (?) AND deleted_at IS NULL', [...ACTOR, skuIds]);
  if (groupIds.length) await db.query('UPDATE sku_group SET deleted_at = NOW(6), deleted_by = ?, deleted_ip = ? WHERE id IN (?) AND deleted_at IS NULL', [...ACTOR, groupIds]);
  console.log(`Removed automation manufacturers: ${(await db.query("DELETE FROM manufacturer WHERE created_by = 'automation-US134'"))[0].affectedRows}`);

  const api = await request.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${process.env.AUTH_TOKEN}`, Accept: 'application/json' } });
  let deleted = 0;
  for (let page = 0; ; page += 1) {
    const list = await (await api.get(`/api/v1/warehouses?name=T134&page=0&size=100`)).json();
    const parents = (list.items ?? []).filter((w) => !w.virtual && String(w.name).startsWith('T134'));
    if (parents.length === 0 || page > 20) break;
    for (const w of parents) {
      let status = (await api.delete(`/api/v1/warehouses/${w.id}`)).status();
      if (status >= 300 && status !== 404) {
        const detail = await (await api.get(`/api/v1/warehouses/${w.id}`)).json();
        await api.post(`/api/v1/warehouses/${w.id}/reactivate`, { data: { version: detail.version } });
        status = (await api.delete(`/api/v1/warehouses/${w.id}`)).status();
      }
      if (status < 300 || status === 404) deleted += 1;
      else console.log(`Could not delete warehouse ${w.id} (${w.name}): HTTP ${status}`);
    }
  }
  console.log(`Deleted T134 warehouses through the API: ${deleted}`);
  await api.dispose();
  await db.end();
})();
