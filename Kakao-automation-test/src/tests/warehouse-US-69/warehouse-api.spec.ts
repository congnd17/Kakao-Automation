import { test, expect } from '@fixtures/warehouse-api.fixture';
import { makeApiStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { buildWarehouseBody, warehouseName } from '@utils/warehouse.data';
import { ApiResult } from '@api/payment-method-policy.api';
import { WarehouseApi, WarehouseApiError, WarehouseWriteBody } from '@api/warehouse.api';

/**
 * Gọi thẳng API register 창고 (dev-settlement-admin-api.berriz.in) — các guard phía server không có đường đi trên UI.
 * Nguồn TC: input/US069_TestCases_EN_v1.20.md — mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` /
 * `Assert: Expected N`. TC lệch thực tế → assert theo thực tế, ghi "Deviation from TC" (quyết định 28/09).
 * Request lỡ được chấp nhận (201) vẫn được đăng ký dọn — không để lại dữ liệu trên môi trường dùng chung.
 */
const TAGS = ['api', 'warehouse'];

type Attempt = { label: string; result: ApiResult<WarehouseApiError & { id?: number }> };

async function post(api: WarehouseApi, cleanup: { track: (id: number) => void }, label: string, body: WarehouseWriteBody): Promise<Attempt> {
  const result = await api.create<WarehouseApiError & { id?: number }>(body);
  if (result.status === 201 && result.body.id) cleanup.track(result.body.id);
  return { label, result };
}

function expectRefused(attempt: Attempt, tag: string, status: number, code: string): void {
  expect(attempt.result.status, `${tag} ${attempt.label} is refused with HTTP ${status}`).toBe(status);
  expect(attempt.result.body.code, `${tag} ${attempt.label} returns ${code}`).toBe(code);
}

test.describe('[API] Register 창고 — server-side guards', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_170 — The (logistics type, 3PL connection) combination guard at the API level', async ({ warehouseApi, warehouseCleanup }) => {
    const step = makeApiStep(warehouseApi);
    await tcMeta('TC_US069_170', 'Medium', TAGS, 'POSTs with WMS + NONE, PICKUP_LOCATION + CJ_LOGISTICS and STORE + CJ_LOGISTICS are all rejected with WH-WAREHOUSE_INVALID_LOGISTICS_COMBINATION (HTTP 400). Any request accepted by mistake is deleted afterwards.');
    const attempts: Attempt[] = [];
    const cj = { logisticsChannelWarehouseCode: 'A12', logisticsChannelCode: 'CH01' };

    await step('Arrange: Pre-condition 1 — A tool to call the API directly (automation API client)', async () => {
      expect((await warehouseApi.list({}, 0, 1)).status, 'The API is reachable').toBe(200);
    });

    await step('Act: Step 1 — POST with logisticsType = WMS and logisticsChannelType = NONE', async () => {
      attempts.push(await post(warehouseApi, warehouseCleanup, 'WMS + NONE', buildWarehouseBody('PLATFORM_GENERAL', warehouseName('TC_US069_170', 'wms'), { logisticsType: 'WMS', logisticsChannelType: 'NONE' })));
    });

    await step('Act: Step 2 — POST with PICKUP_LOCATION + CJ_LOGISTICS', async () => {
      attempts.push(await post(warehouseApi, warehouseCleanup, 'PICKUP_LOCATION + CJ_LOGISTICS', buildWarehouseBody('PLATFORM_PICKUP', warehouseName('TC_US069_170', 'pickup'), { logisticsChannelType: 'CJ_LOGISTICS', ...cj })));
    });

    await step('Act: Step 3 — POST with STORE + CJ_LOGISTICS', async () => {
      attempts.push(await post(warehouseApi, warehouseCleanup, 'STORE + CJ_LOGISTICS', buildWarehouseBody('PLATFORM_STORE', warehouseName('TC_US069_170', 'store'), { logisticsChannelType: 'CJ_LOGISTICS', ...cj })));
    });

    await step('Assert: Expected 1/2/3 — All three are rejected with WH-WAREHOUSE_INVALID_LOGISTICS_COMBINATION', async () => {
      for (const attempt of attempts) expectRefused(attempt, '[Expected 1/2/3]', 400, 'WH-WAREHOUSE_INVALID_LOGISTICS_COMBINATION');
    });
  });

  test('TC_US069_171 — An invalid country code returns 400, not 500', async ({ warehouseApi, warehouseCleanup }) => {
    const step = makeApiStep(warehouseApi);
    await tcMeta('TC_US069_171', 'Medium', TAGS, 'POSTs with address country "OTHER", "UK", "EU" and "XK" are rejected with HTTP 400 and WH-WAREHOUSE_INVALID_COUNTRY — never 500. Deviation from TC: the country travels as the top-level `country` field of the create body (there is no nested address object). Any request accepted by mistake is deleted afterwards.');
    const attempts: Attempt[] = [];

    await step('Arrange: Pre-condition 1 — A tool to call the API directly (automation API client)', async () => {
      expect((await warehouseApi.list({}, 0, 1)).status, 'The API is reachable').toBe(200);
    });

    for (const [n, country] of [[1, 'OTHER'], [2, 'UK'], [3, 'EU'], [4, 'XK']] as const) {
      await step(`Act: Step ${n} — POST with country = "${country}"`, async () => {
        attempts.push(await post(warehouseApi, warehouseCleanup, `country "${country}"`, buildWarehouseBody('SUPPLIER', warehouseName('TC_US069_171', country), { country })));
      });
    }

    await step('Assert: Expected 1-4 — All are rejected with HTTP 400 and WH-WAREHOUSE_INVALID_COUNTRY, never 500', async () => {
      for (const attempt of attempts) {
        expect(attempt.result.status, `[Expected 1-4] ${attempt.label} never returns 500`).not.toBe(500);
        expectRefused(attempt, '[Expected 1-4]', 400, 'WH-WAREHOUSE_INVALID_COUNTRY');
      }
    });
  });

  test('TC_US069_172 — A bucket cannot be updated or deleted via the API', async ({ warehouseApi, warehouseCleanup }) => {
    const step = makeApiStep(warehouseApi);
    await tcMeta('TC_US069_172', 'High', TAGS, 'Update, DELETE, deactivate and reactivate requests on a bucket id are rejected with WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE, and a POST with logisticsType = IN_TRANSIT is rejected with WH-WAREHOUSE_LOGISTICS_TYPE_NOT_ALLOWED. Deviation from TC: the update endpoint is PATCH (the API has no PUT); the refusals return HTTP 409 (virtual) / 400 (logistics type). Data: an automation-owned warehouse with 5 buckets is created and deleted afterwards.');
    let bucketId = 0;
    const attempts: Attempt[] = [];

    await step('Arrange: Pre-condition 1 — A fully-provisioned warehouse with 5 buckets (automation-owned)', async () => {
      const parent = await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_172');
      bucketId = (await warehouseApi.bucketsOf(parent))[0].id;
    });

    await step('Act: Step 1 — Send an update (PATCH) targeting a bucket id', async () => {
      const bucket = (await warehouseApi.get(bucketId)).body;
      attempts.push({ label: 'PATCH bucket', result: await warehouseApi.update(bucketId, WarehouseApi.toUpdateBody(bucket, { name: `${bucket.name}_x` })) as Attempt['result'] });
    });

    await step('Act: Step 2 — Send a DELETE targeting a bucket id', async () => {
      attempts.push({ label: 'DELETE bucket', result: await warehouseApi.remove(bucketId) });
    });

    await step('Act: Step 3 — Send deactivate, then reactivate, targeting a bucket id', async () => {
      const version = (await warehouseApi.get(bucketId)).body.version;
      attempts.push({ label: 'deactivate bucket', result: await warehouseApi.deactivate(bucketId, version) });
      attempts.push({ label: 'reactivate bucket', result: await warehouseApi.reactivate(bucketId, version) });
    });

    await step('Assert: Expected 1/2/3 — All are rejected with WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE', async () => {
      for (const attempt of attempts) expectRefused(attempt, '[Expected 1/2/3]', 409, 'WH-WAREHOUSE_VIRTUAL_NOT_MODIFIABLE');
      expect((await warehouseApi.get(bucketId)).status, '[Expected 1/2/3] The bucket still exists').toBe(200);
    });

    let inTransit: Attempt | undefined;
    await step('Act: Step 4 — POST a warehouse with logisticsType = IN_TRANSIT', async () => {
      inTransit = await post(warehouseApi, warehouseCleanup, 'POST IN_TRANSIT', buildWarehouseBody('PLATFORM_GENERAL', warehouseName('TC_US069_172', 'it'), { logisticsType: 'IN_TRANSIT' }));
    });

    await step('Assert: Expected 4 — Rejected with WH-WAREHOUSE_LOGISTICS_TYPE_NOT_ALLOWED', async () => {
      expectRefused(inTransit!, '[Expected 4]', 400, 'WH-WAREHOUSE_LOGISTICS_TYPE_NOT_ALLOWED');
    });
  });
});
