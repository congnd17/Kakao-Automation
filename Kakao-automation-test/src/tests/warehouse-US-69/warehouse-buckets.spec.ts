import { test, expect } from '@fixtures/base.fixture';
import { makeStep } from '@utils/step';
import { skipTc, tcMeta } from '@utils/tc-meta';
import {
  BUCKET_SUFFIXES,
  MAPPING_OWNERSHIP,
  MAPPING_PRODUCT_KEYWORD,
  VIRTUAL_LABEL,
  VIRTUAL_LOGISTICS_TYPES,
  WH_TEXT,
  buildWarehouseBody,
  warehouseName,
} from '@utils/warehouse.data';
import { WarehouseApi, WarehouseSummary } from '@api/warehouse.api';

/**
 * Bucket hệ thống của 창고 (US069 BR-8a…8d) — tự sinh 5 bucket, đặt tên, hiển thị trên list, cascade đổi tên / trạng thái /
 * xoá, chỉ số tham chiếu. Nguồn TC: input/US069_TestCases_EN_v1.20.md — mỗi dòng Steps N / Expected N map đúng 1 step
 * `Act: Step N` / `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" (quyết định 28/09).
 *
 * "Kiểm tra ở tầng dữ liệu" (SELECT count(*) …) được thay bằng API register (GET list / detail) — cùng nguồn dữ liệu, không
 * có quyền DB. Mở rộng phạm vi 28/09: TC tham chiếu ③ tự tạo mapping US071 trỏ vào warehouse automation; TC cần tồn kho
 * (không có đường tạo trên dev) hoặc cửa hàng (không có contract API store) vẫn skip, lý do ghi trong report.
 * Dữ liệu: mỗi test tự tạo warehouse `auto_US069_<TC>_<timestamp>` và xoá ở teardown (kéo theo 5 bucket; mapping xoá trước).
 */
const TAGS = ['ui', 'warehouse', 'warehouse-buckets'];
const NO_STOCK =
  'the TC does not say how the stock records are produced and dev offers no UI/API to create stock in a warehouse or bucket (only ' +
  'request/complete/cancel of existing inbound rows of real warehouses — verified 28/09).';
const NO_STORE_CONTRACT =
  'the store register (US056) has no screen on dev and neither the TC nor the frontend gives the POST /api/v1/stores contract, so a store cannot be linked without guessing its fields';
const MAPPING_DATA =
  'Data: the automation-owned warehouse and the US071 mapping(s) pointing at it are created through the API and deleted in teardown (mapping first) — scope extended 28/09.';
const NO_CASCADE_LINE =
  'the dialog shows NO second body line with {n} — the detail API does not return virtualWarehouseCount, which the page needs to render it (verified 28/09); reported to the BA/dev as a gap';

async function familyStatuses(api: WarehouseApi, parent: { id: number; name: string }): Promise<string[]> {
  return [(await api.get(parent.id)).body.status, ...(await api.bucketsOf(parent)).map((b) => b.status)];
}

test.describe('[Buckets] System-managed virtual buckets of a warehouse', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_129 — Creating a Platform warehouse auto-provisions 5 virtual buckets', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_129', 'Critical', TAGS, 'Saving a new Platform warehouse succeeds 활성; the list shows 6 rows (the warehouse + 5 System (virtual) buckets); the API returns 6 rows whose buckets are virtual, point at the parent (locationWarehouseId) and cover PENDING_REVENUE, IN_TRANSIT, SCRAP, QUARANTINE, DEFECTIVE. Deviation from TC: the name is "auto_…CJ Daegu" (traceable) and the row count is taken from the API, not SQL. Data: the created warehouse is deleted afterwards.');
    const name = `${warehouseName('TC_US069_129')} CJ Daegu`;
    let parentId = 0;
    let status = '';
    let buckets: WarehouseSummary[] = [];
    let listed = 0;
    let listedVirtual = 0;

    await step('Arrange: Pre-condition 1 — ADMIN has MASTER_DATA writable; the API can count rows', async () => {
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Open 창고 등록', async () => {
      await form.openCreate();
    });

    await step('Act: Step 2 — Create a new 플랫폼 물류 warehouse named "…CJ Daegu" with valid data and click 저장', async () => {
      await form.fill({ bizPartner: '카카오엔터테인먼트 테스트', name, type: WH_TEXT.typePlatform, logisticsType: '일반', addr: 'Automation street 129', zipCode: '21500', number: '0321234567' });
      await form.saveAndWait();
      await list.waitForListLoaded();
      const parent = (await warehouseApi.listAll({ name })).find((w) => w.name === name && !w.virtual)!;
      parentId = parent.id;
      status = parent.status;
    });

    await step('Assert: Expected 2 — Save succeeds and 상태 = 활성', async () => {
      await expect(form.toast(WH_TEXT.toastCreated), '[Expected 2] The create toast is shown').toBeVisible();
      expect(status, '[Expected 2] 상태 is ACTIVE').toBe('ACTIVE');
    });

    await step('Act: Step 3 — Open 창고 목록 and search for "…CJ Daegu"', async () => {
      await list.search({ keyword: name });
      listed = await list.tableRows.count();
      listedVirtual = await list.tableRows.filter({ has: page.locator('span.badge', { hasText: VIRTUAL_LABEL }) }).count();
    });

    await step('Assert: Expected 3 — 6 rows: the warehouse + 5 buckets tagged System (virtual)', async () => {
      expect(listed, '[Expected 3] 6 rows are listed').toBe(6);
      expect(listedVirtual, '[Expected 3] 5 of them carry the System (virtual) badge').toBe(5);
    });

    await step('Act: Step 4 — Count the rows through the API (id = parent OR location = parent)', async () => {
      buckets = await warehouseApi.bucketsOf({ id: parentId, name });
    });

    await step('Assert: Expected 4 — Total = 6; the 5 buckets are the 5 virtual logistics types and point at the parent', async () => {
      expect(1 + buckets.length, '[Expected 4] Total = 6').toBe(6);
      for (const bucket of buckets) {
        expect(bucket.virtual, `[Expected 4] ${bucket.name} is virtual`).toBe(true);
        expect(bucket.locationWarehouseId, `[Expected 4] ${bucket.name} carries the new warehouse as its location`).toBe(parentId);
      }
      const types = await Promise.all(buckets.map(async (b) => (await warehouseApi.get(b.id)).body.logisticsType));
      expect([...types].sort(), '[Expected 4] Exactly PENDING_REVENUE, IN_TRANSIT, SCRAP, QUARANTINE, DEFECTIVE').toEqual([...VIRTUAL_LOGISTICS_TYPES].sort());
    });
  });

  test('TC_US069_130 — A Supplier warehouse also provisions 5 buckets', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_130', 'Critical', TAGS, 'A new Supplier warehouse provisions the full 5 buckets exactly like a Platform warehouse (list shows 6 rows; the API shows 5 virtual rows pointing at it). Data: the created warehouse is deleted afterwards.');
    const name = warehouseName('TC_US069_130');
    let parentId = 0;
    let listed = 0;
    let buckets: WarehouseSummary[] = [];

    await step('Arrange: Pre-condition 1 — ADMIN has MASTER_DATA writable and is on 창고 등록', async () => {
      await form.openCreate();
      warehouseCleanup.trackName(name);
    });

    await step('Act: Step 1 — Create a new 판매자 물류 warehouse with valid data and click 저장', async () => {
      await form.fill({ bizPartner: '카카오엔터테인먼트 테스트', name, type: WH_TEXT.typeSupplier, addr: 'Automation street 130', zipCode: '21500', number: '0321234567' });
      await form.saveAndWait();
      await list.waitForListLoaded();
      parentId = (await warehouseApi.listAll({ name })).find((w) => w.name === name && !w.virtual)!.id;
    });

    await step('Act: Step 2 — Open 창고 목록 and check the rows through the API', async () => {
      await list.search({ keyword: name });
      listed = await list.tableRows.count();
      buckets = await warehouseApi.bucketsOf({ id: parentId, name });
    });

    await step('Assert: Expected 2 — The Supplier warehouse also has its full 5 buckets', async () => {
      expect(listed, '[Expected 2] The list shows the warehouse + 5 buckets').toBe(6);
      expect(buckets.length, '[Expected 2] The API shows 5 buckets pointing at it').toBe(5);
    });
  });

  test('TC_US069_131 — Bucket naming convention', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_131', 'High', TAGS, 'Every bucket is named "{parent name} - {type}"; no bucket carries the type alone. Deviation from TC: the type part is Korean — 매출대기 / 이동중 / 폐기 / 이슈격리 / 불량 (TC: "CJ Daegu - Pending revenue", "- In-transit" …). Data: an automation-owned "…CJ Daegu" warehouse is created and deleted afterwards.');
    let name = '';
    let names: string[] = [];

    await step('Arrange: Pre-condition 1 — A warehouse named "…CJ Daegu" has been created (automation-owned)', async () => {
      name = (await warehouseCleanup.create('PLATFORM_GENERAL', 'TC_US069_131', { name: `${warehouseName('TC_US069_131')} CJ Daegu` })).name;
    });

    await step('Act: Step 1 — Open 창고 목록', async () => {
      await list.open({ keyword: name });
    });

    await step('Act: Step 2 — Observe the names of the 5 buckets of "…CJ Daegu"', async () => {
      names = (await list.fullNames()).filter((n) => n !== name);
    });

    await step('Assert: Expected 2 — Each bucket is "{parent} - {type}", none is named by its type alone', async () => {
      expect(names.sort(), '[Expected 2] The 5 buckets follow "{parent} - {type}"').toEqual(BUCKET_SUFFIXES.map((s) => `${name} - ${s}`).sort());
      for (const suffix of BUCKET_SUFFIXES) expect(names, `[Expected 2] No bucket is named "${suffix}" alone`).not.toContain(suffix);
    });
  });

  test('TC_US069_132 — A bucket name longer than 100 characters truncates the parent part', async ({ page, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_132', 'Medium', TAGS, 'With a 100-character parent name no bucket name exceeds 100 characters; the parent-name part is truncated and " - {type}" is always kept intact. Data: an automation-owned warehouse is created and deleted afterwards.');
    const parentName = warehouseName('TC_US069_132').padEnd(100, 'L');
    let names: string[] = [];

    await step('Arrange: Pre-condition 1 — ADMIN has MASTER_DATA writable', async () => {
      await list.goto('/');
    });

    await step('Act: Step 1 — Create a warehouse whose name is 100 characters long', async () => {
      await warehouseCleanup.create('SUPPLIER', 'TC_US069_132', { name: parentName });
    });

    await step('Act: Step 2 — Observe the names of the 5 new buckets', async () => {
      await list.open({ keyword: parentName.slice(0, 40), size: '20' });
      names = (await list.fullNames()).filter((n) => n !== parentName);
    });

    await step('Assert: Expected 2 — No bucket name exceeds 100 characters and the suffix stays intact', async () => {
      expect(names.length, '[Expected 2] The 5 buckets are listed').toBe(5);
      for (const suffix of BUCKET_SUFFIXES) {
        const bucket = names.find((n) => n.endsWith(` - ${suffix}`));
        expect(bucket, `[Expected 2] A bucket keeps the intact suffix " - ${suffix}"`).toBeDefined();
        expect(bucket!.length, `[Expected 2] "${suffix}" bucket name is at most 100 characters`).toBeLessThanOrEqual(100);
        expect(parentName.startsWith(bucket!.slice(0, bucket!.length - ` - ${suffix}`.length)), `[Expected 2] "${suffix}" bucket truncates only the parent-name part`).toBe(true);
      }
    });
  });

  test('TC_US069_133 — Buckets carry type PLATFORM even under a Supplier warehouse', async ({ page, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_133', 'High', TAGS, 'The 5 buckets of a Supplier warehouse have type = PLATFORM (API), and filtering 유형 = 플랫폼 물류 returns them — correct behaviour per BR-8a, not a defect. Data: an automation-owned Supplier warehouse is created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let types: string[] = [];
    let listedBuckets = 0;

    await step('Arrange: Pre-condition 1 — A 판매자 물류 warehouse with its 5 buckets (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_133');
    });

    await step('Act: Step 1 — Check the type of the 5 buckets through the API', async () => {
      types = (await warehouseApi.bucketsOf(parent)).map((b) => b.type);
    });

    await step('Assert: Expected 1 — All 5 buckets are PLATFORM', async () => {
      expect(types, '[Expected 1] 5 buckets, all type = PLATFORM').toEqual(Array(5).fill('PLATFORM'));
    });

    await step('Act: Step 2 — On 창고 목록 filter 유형 = 플랫폼 물류', async () => {
      await list.open({ keyword: parent.name });
      await list.search({ type: WH_TEXT.typePlatform });
      listedBuckets = await list.tableRows.count();
    });

    await step('Assert: Expected 2 — The filtered result includes the Supplier warehouse\'s buckets', async () => {
      expect(listedBuckets, '[Expected 2] The 5 buckets are returned under 플랫폼 물류').toBe(5);
      await expect(list.rowByName(parent.name), '[Expected 2] The Supplier parent itself is not').toHaveCount(0);
    });
  });

  test('TC_US069_134 — Buckets render as System (virtual) on the list while the API keeps the raw values', async ({ page, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_134', 'High', TAGS, 'On every bucket row 창고 유형, 물류사 유형 and 분류 read "System (virtual)" and the 창고명 cell carries the badge; the API still returns type = PLATFORM, logisticsChannelType = NONE and no category — a display substitution only. Data: an automation-owned warehouse is created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let raw: WarehouseSummary[] = [];

    await step('Arrange: Pre-condition 1 — A warehouse with its 5 buckets (automation-owned)', async () => {
      parent = await warehouseCleanup.create('PLATFORM_WMS_EGFLEX', 'TC_US069_134');
    });

    await step('Act: Step 1 — Open 창고 목록', async () => {
      await list.open({ keyword: parent.name });
    });

    await step('Act: Step 2 — Observe the 5 bucket rows: 창고 유형, 물류사 유형, 분류 and 창고명', async () => {
      await list.table.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — All three columns read System (virtual) and 창고명 carries the badge', async () => {
      for (const suffix of BUCKET_SUFFIXES) {
        const row = list.rowByName(`${parent.name} - ${suffix}`);
        for (const column of ['창고 유형', '물류사 유형', '분류']) {
          await expect(await list.cell(row, column), `[Expected 2] ${suffix}: ${column} reads System (virtual)`).toHaveText(VIRTUAL_LABEL);
        }
        await expect(list.virtualBadge(row), `[Expected 2] ${suffix}: 창고명 carries the badge`).toBeVisible();
      }
    });

    await step('Act: Step 3 — Compare with the raw API response', async () => {
      raw = await warehouseApi.bucketsOf(parent);
    });

    await step('Assert: Expected 3 — The API keeps PLATFORM / NONE / no category — a display substitution', async () => {
      expect(raw.length, '[Expected 3] 5 bucket rows (6 rows per physical warehouse)').toBe(5);
      for (const bucket of raw) {
        expect(bucket.type, `[Expected 3] ${bucket.name}: type = PLATFORM`).toBe('PLATFORM');
        expect(bucket.logisticsChannelType, `[Expected 3] ${bucket.name}: logisticsChannelType = NONE`).toBe('NONE');
        expect(bucket.category ?? null, `[Expected 3] ${bucket.name}: category = null`).toBeNull();
      }
    });
  });

  test('TC_US069_135 — locationWarehouseId on the API response is response-only', async ({ page, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_135', 'Medium', [...TAGS, 'api'], 'On GET /warehouses a bucket carries locationWarehouseId = its parent id and a physical warehouse carries none; GET /warehouses/{bucket} carries it too; POST / update requests carrying locationWarehouseId do not apply it; the UI renders no such column. Deviation from TC: updates use PATCH (the API has no PUT); an unknown field is ignored, not rejected (POST returns 201 with no location). Data: automation-owned warehouses are created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let listRows: WarehouseSummary[] = [];
    let bucketDetail: { locationWarehouseId?: number | null } = {};
    const probe = { postStatus: 0, postLocation: 'unset' as unknown, patchStatus: 0, patchLocation: 'unset' as unknown };

    await step('Arrange: Pre-condition 1 — A physical warehouse and its 5 buckets exist (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_135');
    });

    await step('Act: Step 1 — Call GET /api/v1/warehouses', async () => {
      listRows = await warehouseApi.listAll({ name: parent.name });
    });

    await step('Act: Step 2 — Observe locationWarehouseId on a bucket row and on the physical row', async () => {
      await test.info().attach('GET /warehouses rows', { body: JSON.stringify(listRows, null, 2), contentType: 'application/json' });
    });

    await step('Assert: Expected 2 — Bucket: the parent id; physical warehouse: null', async () => {
      expect(listRows.find((r) => r.id === parent.id)?.locationWarehouseId ?? null, '[Expected 2] The physical warehouse has no location').toBeNull();
      for (const bucket of listRows.filter((r) => r.virtual)) expect(bucket.locationWarehouseId, `[Expected 2] ${bucket.name} points at the parent`).toBe(parent.id);
    });

    await step('Act: Step 3 — Call GET /api/v1/warehouses/{id} with a bucket id', async () => {
      bucketDetail = (await warehouseApi.get(listRows.find((r) => r.virtual)!.id)).body;
    });

    await step('Assert: Expected 3 — The single-record response carries locationWarehouseId too', async () => {
      expect(bucketDetail.locationWarehouseId, '[Expected 3] The bucket detail carries its parent id').toBe(parent.id);
    });

    await step('Act: Step 4 — Send POST and update requests carrying locationWarehouseId', async () => {
      const created = await warehouseApi.create({ ...buildWarehouseBody('SUPPLIER', warehouseName('TC_US069_135', 'post')), locationWarehouseId: parent.id });
      probe.postStatus = created.status;
      if (created.status === 201) {
        warehouseCleanup.track(created.body.id);
        probe.postLocation = (await warehouseApi.get(created.body.id)).body.locationWarehouseId ?? null;
      }
      const latest = (await warehouseApi.get(parent.id)).body;
      const patched = await warehouseApi.update(parent.id, { ...WarehouseApi.toUpdateBody(latest), locationWarehouseId: 1 });
      probe.patchStatus = patched.status;
      probe.patchLocation = (await warehouseApi.get(parent.id)).body.locationWarehouseId ?? null;
    });

    await step('Assert: Expected 4 — The field is not accepted on create / update', async () => {
      expect(probe.postLocation, `[Expected 4] POST (status ${probe.postStatus}) does not store locationWarehouseId`).toBeNull();
      expect(probe.patchLocation, `[Expected 4] PATCH (status ${probe.patchStatus}) does not store locationWarehouseId`).toBeNull();
    });

    await step('Act: Step 5 — Observe 창고 목록 on the UI', async () => {
      await list.open({ keyword: parent.name });
    });

    await step('Assert: Expected 5 — No locationWarehouseId column is rendered', async () => {
      const headers = (await list.table.locator('thead th').allTextContents()).map((h) => h.trim());
      expect(headers, '[Expected 5] The columns are exactly the 7 main columns').toEqual(['ID', '거래처', '창고 유형', '창고명', '물류사 유형', '분류', '상태']);
    });
  });

  for (const skip of [
    { tc: 'TC_US069_136', priority: 'High' as const, title: 'Provisioning is atomic', description: 'A failure while creating the 3rd bucket rolls back the whole save, parent included.', reason: 'needs failure injection at the service layer / DB connection, not available on the shared environment.' },
    { tc: 'TC_US069_137', priority: 'Medium' as const, title: 'The bucket count is driven by the virtual flag', description: 'The provisioning loop iterates LogisticsType.virtual = true; a 6th virtual type provisions 6 buckets.', reason: 'needs code inspection and adding a 6th virtual logistics type to the enum — not possible from the UI/API.' },
    { tc: 'TC_US069_138', priority: 'Medium' as const, title: 'A freshly-migrated database seeds no buckets', description: 'Running the migration on an empty database inserts no warehouse row; the list shows the empty state.', reason: 'needs an empty database and running the migration set — not possible on the shared environment.' },
  ]) {
    test(`${skip.tc} — ${skip.title}`, async () => {
      await skipTc(skip.tc, skip.priority, TAGS, skip.description, skip.reason);
    });
  }

  test('TC_US069_139 — Renaming the parent renames its 5 buckets', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_139', 'High', TAGS, 'Renaming "…CJ Daegu" to "…CJ Daegu 2" renames all 5 buckets to "…CJ Daegu 2 - {type}"; no bucket keeps the old name. Data: an automation-owned warehouse is created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    const renamed = () => `${parent.name} 2`;
    let names: string[] = [];

    await step('Arrange: Pre-condition 1 — A warehouse named "…CJ Daegu" with its 5 buckets recorded (automation-owned)', async () => {
      parent = await warehouseCleanup.create('PLATFORM_GENERAL', 'TC_US069_139', { name: `${warehouseName('TC_US069_139')} CJ Daegu` });
    });

    await step('Act: Step 1 — Open the Detail/Edit of "…CJ Daegu"', async () => {
      await form.open(parent.id);
    });

    await step('Act: Step 2 — Change 창고명 to "…CJ Daegu 2" and click 저장', async () => {
      await form.nameInput.fill(renamed());
      await form.saveAndWait();
      await list.waitForListLoaded();
    });

    await step('Act: Step 3 — Open 창고 목록 and observe the names of the 5 buckets', async () => {
      await list.search({ keyword: parent.name });
      names = await list.fullNames();
    });

    await step('Assert: Expected 3 — All 5 buckets carry "…CJ Daegu 2 - {type}", none the old name', async () => {
      for (const suffix of BUCKET_SUFFIXES) expect(names, `[Expected 3] Bucket "${renamed()} - ${suffix}" exists`).toContain(`${renamed()} - ${suffix}`);
      for (const suffix of BUCKET_SUFFIXES) expect(names, `[Expected 3] No bucket keeps "${parent.name} - ${suffix}"`).not.toContain(`${parent.name} - ${suffix}`);
    });
  });

  test('TC_US069_151 — Deactivating a warehouse carries its 5 buckets to Inactive', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_151', 'Critical', TAGS, 'One deactivation turns all 6 rows (warehouse + 5 buckets) 비활성 on the list and in the API. Data: an automation-owned warehouse is created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let listed: string[] = [];
    let stored: string[] = [];

    await step('Arrange: Pre-condition 1 — A provisioned, Active warehouse not blocked by gate G2 (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_151');
    });

    await step('Act: Step 1 — Open Detail/Edit and click 창고 비활성화', async () => {
      await form.open(parent.id);
      await form.openDeactivateDialog();
    });

    await step('Act: Step 2 — Confirm in the dialog', async () => {
      await form.confirmDeactivate();
      await expect(form.reactivateButton).toBeVisible();
    });

    await step('Act: Step 3 — Open 창고 목록 and observe the warehouse and its 5 buckets', async () => {
      await list.open({ keyword: parent.name });
      listed = await list.columnValues('상태');
    });

    await step('Act: Step 4 — Check the data through the API', async () => {
      stored = await familyStatuses(warehouseApi, parent);
    });

    await step('Assert: Expected 3/4 — All 6 rows are 비활성', async () => {
      expect(listed, '[Expected 3/4] The list shows 6 rows, all 비활성').toEqual(Array(6).fill(WH_TEXT.statusInactive));
      expect(stored, '[Expected 3/4] The API stores 6 rows, all INACTIVE').toEqual(Array(6).fill('INACTIVE'));
    });
  });

  test('TC_US069_152 — Reactivating a warehouse brings its 5 buckets back to Active', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_152', 'Critical', TAGS, 'Reactivating an Inactive warehouse returns all 6 rows to 활성. Data: an automation-owned warehouse is deactivated via API, reactivated on the UI and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let listed: string[] = [];

    await step('Arrange: Pre-condition 1 — The warehouse and its 5 buckets are 비활성 (automation-owned, deactivated via API)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_152');
      await warehouseApi.deactivate(parent.id, (await warehouseApi.get(parent.id)).body.version);
      expect(await familyStatuses(warehouseApi, parent)).toEqual(Array(6).fill('INACTIVE'));
    });

    await step('Act: Step 1 — Open Detail/Edit and click 재활성화', async () => {
      await form.open(parent.id);
      await form.reactivate();
      await expect(form.deactivateButton).toBeVisible();
    });

    await step('Act: Step 2 — Observe the warehouse and its 5 buckets on 창고 목록', async () => {
      await list.open({ keyword: parent.name });
      listed = await list.columnValues('상태');
    });

    await step('Assert: Expected 2 — All 6 rows return to 활성', async () => {
      expect(listed, '[Expected 2] The list shows 6 rows, all 활성').toEqual(Array(6).fill(WH_TEXT.statusActive));
      expect(await familyStatuses(warehouseApi, parent), '[Expected 2] The API stores 6 rows, all ACTIVE').toEqual(Array(6).fill('ACTIVE'));
    });
  });

  test('TC_US069_153 — The cascade is all-or-nothing — no split state exists', async ({ page, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_153', 'Critical', [...TAGS, 'api'], 'Deactivating and reactivating one warehouse never leaves a bucket in a different status from its parent, and a read-only scan of every warehouse on the environment finds no Inactive parent with an Active bucket. Deviation from TC: the status is read through the API (no DB access) and the pre-condition "3 provisioned warehouses" is covered by the environment-wide scan plus one automation-owned warehouse. Data: the automation-owned warehouse is deleted afterwards; other warehouses are only read.');
    let parent = { id: 0, name: '' };
    const seen = { afterDeactivate: [] as string[], afterReactivate: [] as string[], split: [] as string[] };

    await step('Arrange: Pre-condition 1 — Provisioned warehouses exist (automation-owned one + the environment)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_153');
      await list.open({ keyword: parent.name });
    });

    await step('Act: Step 1 — Deactivate 1 warehouse, check every bucket\'s status', async () => {
      await warehouseApi.deactivate(parent.id, (await warehouseApi.get(parent.id)).body.version);
      seen.afterDeactivate = await familyStatuses(warehouseApi, parent);
    });

    await step('Act: Step 2 — Reactivate that warehouse, check again', async () => {
      await warehouseApi.reactivate(parent.id, (await warehouseApi.get(parent.id)).body.version);
      seen.afterReactivate = await familyStatuses(warehouseApi, parent);
    });

    await step('Assert: Expected 1/2 — No bucket diverges from its parent, in either direction', async () => {
      expect(seen.afterDeactivate, '[Expected 1/2] After deactivation all 6 rows are INACTIVE').toEqual(Array(6).fill('INACTIVE'));
      expect(seen.afterReactivate, '[Expected 1/2] After reactivation all 6 rows are ACTIVE').toEqual(Array(6).fill('ACTIVE'));
    });

    await step('Act: Step 3 — Scan all warehouses for an Inactive parent that still has an Active bucket', async () => {
      const all = await warehouseApi.listAll();
      const byId = new Map(all.map((w) => [w.id, w]));
      seen.split = all
        .filter((w) => w.virtual && w.locationWarehouseId && byId.get(w.locationWarehouseId)?.status === 'INACTIVE' && w.status === 'ACTIVE')
        .map((w) => `${w.id} ${w.name}`);
    });

    await step('Assert: Expected 3 — That split state does not exist', async () => {
      expect(seen.split, '[Expected 3] No Active bucket under an Inactive parent').toEqual([]);
    });
  });

  for (const dialog of [
    { tc: 'TC_US069_154', priority: 'High' as const, kind: 'deactivate' as const },
    { tc: 'TC_US069_156', priority: 'High' as const, kind: 'delete' as const },
  ]) {
    test(`${dialog.tc} — Second body line of the ${dialog.kind} confirm dialog`, async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
      const step = makeStep(page);
      const isDeactivate = dialog.kind === 'deactivate';
      await tcMeta(
        dialog.tc,
        dialog.priority,
        TAGS,
        `The ${dialog.kind} dialog shows its title, body${isDeactivate ? ', hint' : ''} and buttons. Deviation from TC: ${NO_CASCADE_LINE}; the test asserts ` +
          'the dialog as rendered (one body line). Data: an automation-owned warehouse with 5 buckets is created and deleted afterwards.',
      );
      let parent = { id: 0, name: '' };

      await step('Arrange: Pre-condition 1 — An Active warehouse with 5 buckets and no references (automation-owned)', async () => {
        parent = await warehouseCleanup.create('SUPPLIER', dialog.tc);
        await form.open(parent.id);
      });

      await step(`Act: Step 1 — Click ${isDeactivate ? '창고 비활성화' : '창고 삭제'}`, async () => {
        if (isDeactivate) await form.openDeactivateDialog();
        else await form.openDeleteDialog();
      });

      await step('Act: Step 2 — Read the entire dialog content: title, body, hint, buttons', async () => {
        await form.dialog.scrollIntoViewIfNeeded();
      });

      await step('Assert: Expected 2 — The dialog content (no second cascade line — see Deviation)', async () => {
        await expect(form.dialogTitle, '[Expected 2] Title').toHaveText(isDeactivate ? WH_TEXT.deactivateTitle : WH_TEXT.deleteTitle);
        await expect(form.dialogBodyLines.first(), '[Expected 2] Body line 1').toHaveText(isDeactivate ? WH_TEXT.deactivateBody(parent.name) : WH_TEXT.deleteBody(parent.name));
        if (isDeactivate) await expect(form.dialog.getByText(WH_TEXT.deactivateHint, { exact: true }), '[Expected 2] The reactivate-any-time hint still holds').toBeVisible();
        await expect(form.dialog.getByText(isDeactivate ? WH_TEXT.cascadeDeactivate(5) : WH_TEXT.cascadeDelete(5)), '[Expected 2] Second body line is not rendered (Deviation)').toHaveCount(0);
        await expect(form.dialogCancelButton, '[Expected 2] 취소').toBeVisible();
        await expect(isDeactivate ? form.deactivateConfirmButton : form.deleteConfirmButton, `[Expected 2] ${isDeactivate ? '비활성화' : '영구 삭제'}`).toBeVisible();
      });
    });
  }

  test('TC_US069_155 — {n} in both dialogs is a dynamic count', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_155', 'Medium', TAGS, `Both dialogs should read {n} from the warehouse's real bucket count. Deviation from TC: ${NO_CASCADE_LINE}, so no {n} is rendered in either dialog and the test asserts that. Not automated: Step/Expected 2 — adding a 6th virtual logistics type is not possible on this environment. Data: an automation-owned warehouse is created and deleted afterwards.`);
    let parent = { id: 0, name: '' };
    const counts = { deactivate: -1, remove: -1 };
    const nText = (text: string) => (text.match(/시스템 관리 창고 (\d+)개/) ?? [])[1];

    await step('Arrange: Pre-condition 1 — A provisioned warehouse exists (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_155');
      await form.open(parent.id);
    });

    await step('Act: Step 1 — Open the 창고 비활성화 dialog on a warehouse with 5 buckets and read {n}', async () => {
      await form.openDeactivateDialog();
      counts.deactivate = nText(await form.dialog.innerText()) === undefined ? 0 : Number(nText(await form.dialog.innerText()));
      await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
    });

    await step('Assert: Expected 1 — {n} (not rendered — see Deviation)', async () => {
      expect(counts.deactivate, '[Expected 1] The deactivate dialog renders no {n} line (Deviation)').toBe(0);
    });

    // Step 2 (thêm logistics type ảo thứ 6) không thực hiện được — Not automated (xem description).
    await step('Act: Step 2 — Add a 6th virtual logistics type and reopen the dialog (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step/Expected 2: a 6th virtual logistics type cannot be added on this environment.' });
    });

    await step('Assert: Expected 2 — {n} = 6 (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 2 depends on Step 2.' });
    });

    await step('Act: Step 3 — Repeat with the 창고 삭제 dialog', async () => {
      await form.openDeleteDialog();
      counts.remove = nText(await form.dialog.innerText()) === undefined ? 0 : Number(nText(await form.dialog.innerText()));
      await form.click(form.dialogCancelButton, '취소 (Cancel) button in the dialog');
    });

    await step('Assert: Expected 3 — The delete dialog behaves identically', async () => {
      expect(counts.remove, '[Expected 3] The delete dialog renders no {n} line either (Deviation)').toBe(counts.deactivate);
    });
  });

  test('TC_US069_157 — Delete hard-deletes the warehouse and its 5 buckets', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_157', 'Critical', [...TAGS, 'api'], '영구 삭제 removes the warehouse AND its 5 buckets: none of the 6 ids resolves any more and no System (virtual) row points at the dead id. Deviation from TC: the row count is read through the API instead of SQL; the "buckets first" ordering inside the transaction is not observable from outside (Not automated). Data: the automation-owned warehouse is deleted by the test itself.');
    let parent = { id: 0, name: '' };
    let ids: number[] = [];
    let statuses: number[] = [];
    let orphans: WarehouseSummary[] = [];

    await step('Arrange: Pre-condition 1 — A warehouse with all 3 counts = 0 and its 5 buckets (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_157');
    });

    await step('Act: Step 1 — Record the id of the warehouse and of its 5 buckets', async () => {
      ids = [parent.id, ...(await warehouseApi.bucketsOf(parent)).map((b) => b.id)];
      expect(ids.length).toBe(6);
    });

    await step('Act: Step 2 — Delete the warehouse via 영구 삭제 and confirm', async () => {
      await form.open(parent.id);
      await form.openDeleteDialog();
      await form.confirmDelete();
      await list.waitForListLoaded();
    });

    await step('Act: Step 3 — Count the 6 ids through the API', async () => {
      statuses = await Promise.all(ids.map(async (id) => (await warehouseApi.get(id)).status));
    });

    await step('Assert: Expected 3 — Result = 0 (all 6 rows are gone)', async () => {
      expect(statuses, '[Expected 3] None of the 6 ids resolves (404)').toEqual(Array(6).fill(404));
    });

    await step('Act: Step 4 — Open 창고 목록', async () => {
      await list.search({ keyword: parent.name });
      orphans = (await warehouseApi.listAll({ name: parent.name })).filter((w) => w.locationWarehouseId === parent.id);
    });

    await step('Assert: Expected 4 — No System (virtual) row remains pointing at the dead id', async () => {
      await expect(list.tableRows, '[Expected 4] No row of the deleted warehouse is listed').toHaveCount(0);
      expect(orphans, '[Expected 4] No bucket points at the deleted id').toEqual([]);
    });
  });

  test('TC_US069_159 — No change history record is written for a bucket', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_159', 'High', TAGS, 'Deactivating a warehouse writes exactly one UPDATED record on 상태 on the parent (not enumerating the buckets); a bucket has no 변경 이력 button at all. Not automated: Step/Expected 4 — the DELETED record is only in the history store (data layer). Data: an automation-owned warehouse is created and deleted afterwards.');
    let parent = { id: 0, name: '' };
    let bucketId = 0;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — A warehouse with 5 buckets and at least 1 history record (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_159');
      bucketId = (await warehouseApi.bucketsOf(parent))[0].id;
    });

    await step('Act: Step 1 — Deactivate the warehouse', async () => {
      await form.open(parent.id);
      await form.openDeactivateDialog();
      await form.confirmDeactivate();
      await expect(form.reactivateButton).toBeVisible();
    });

    await step('Act: Step 2 — Open 변경 이력 of the parent warehouse', async () => {
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 2 — Exactly one UPDATED record on 상태, not enumerating the buckets', async () => {
      const statusRecords = rows.filter((r) => r[2] === '상태');
      expect(statusRecords.length, '[Expected 2] Exactly one record on 상태').toBe(1);
      expect(statusRecords[0][3], '[Expected 2] It reads 활성 → 비활성 only').toBe('활성 → 비활성');
      expect(rows.map((r) => r[3]).join('\n'), '[Expected 2] No record enumerates the buckets').not.toContain(' - ');
    });

    await step('Act: Step 3 — Open a bucket\'s Detail screen and look for 변경 이력', async () => {
      await form.closeHistory();
      await form.open(bucketId);
    });

    await step('Assert: Expected 3 — The bucket has no 변경 이력 button (absent, not disabled)', async () => {
      await expect(form.historyButton, '[Expected 3] 변경 이력 is not rendered').toHaveCount(0);
    });

    // Step 4 cần đọc history store của warehouse đã xoá (tầng dữ liệu) — Not automated (xem description).
    await step('Act: Step 4 — Delete another eligible warehouse and query the history store (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step/Expected 4: the DELETED record lives in the history store only.' });
    });

    await step('Assert: Expected 4 — One DELETED record for the parent only (Not automated — data layer)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 4 needs database access.' });
    });
  });

  test('TC_US069_162 — The cascade has no retroactive effect on orphan buckets', async ({ page, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_162', 'Low', [...TAGS, 'api'], 'Buckets without a parent (orphans from before BR-8d or hand-inserted mock rows) are not touched by deactivating / deleting other warehouses. The orphan list is read through the API (read-only); the actions run on an automation-owned warehouse that is deleted by the test.');
    let before: string[] = [];
    let after: string[] = [];
    const orphansNow = async () => {
      const all = await warehouseApi.listAll();
      const ids = new Set(all.filter((w) => !w.virtual).map((w) => w.id));
      return all.filter((w) => w.virtual && (!w.locationWarehouseId || !ids.has(w.locationWarehouseId))).map((w) => `${w.id}|${w.name}|${w.status}`).sort();
    };

    await step('Arrange: Pre-condition 1 — The environment may hold orphan buckets / FPT mock rows', async () => {
      await list.open();
    });

    await step('Act: Step 1 — List the buckets that have no parent warehouse', async () => {
      before = await orphansNow();
    });

    await step('Act: Step 2 — Deactivate and delete another (automation-owned) warehouse', async () => {
      const own = await warehouseCleanup.create('SUPPLIER', 'TC_US069_162');
      await warehouseApi.deactivate(own.id, (await warehouseApi.get(own.id)).body.version);
      expect((await warehouseApi.remove(own.id)).status).toBe(204);
    });

    await step('Act: Step 3 — Re-check the list from Step 1', async () => {
      after = await orphansNow();
    });

    await step('Assert: Expected 3 — The orphan buckets are unchanged', async () => {
      expect(after, '[Expected 3] The same orphan buckets, same status — the cascade does not clean them up').toEqual(before);
    });
  });

  test('TC_US069_165 — The 상태 및 작업 pane shows the three reference figures, read-only, never in history', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_165', 'High', TAGS, 'The pane shows 연결된 재고 기록, 연결된 매장 and 연결된 상품-창고 매핑; all three are read-only text; none appears in 변경 이력. Not automated: that the mapping figure counts ACTIVE triples only (needs US071 mapping data — see TC_163/164). Data: an automation-owned warehouse is created and deleted afterwards.');
    let id = 0;
    let settings: string[] = [];

    await step('Arrange: Pre-condition 1 — Any non-virtual warehouse (automation-owned, saved once)', async () => {
      id = (await warehouseCleanup.create('SUPPLIER', 'TC_US069_165')).id;
      const latest = (await warehouseApi.get(id)).body;
      await warehouseApi.update(id, WarehouseApi.toUpdateBody(latest, { city: 'Figures city' }));
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(id);
    });

    await step('Act: Step 2 — Observe the 상태 및 작업 pane', async () => {
      await form.panel.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — All three figures are shown', async () => {
      for (const label of ['연결된 재고 기록', '연결된 매장', '연결된 상품-창고 매핑']) {
        await expect(form.panelValue(label), `[Expected 2] ${label} is displayed with a figure`).toHaveText(/^\d+$/);
      }
    });

    await step('Act: Step 3 — Try to focus / edit the three reference figures', async () => {
      await form.panelValue('연결된 재고 기록').click();
      await page.keyboard.type('9');
    });

    await step('Assert: Expected 3 — All three are read-only', async () => {
      for (const label of ['연결된 재고 기록', '연결된 매장', '연결된 상품-창고 매핑']) {
        await expect(form.panelValue(label).locator('input, select, textarea, [contenteditable="true"]'), `[Expected 3] ${label} has no editable control`).toHaveCount(0);
      }
      await expect(form.panelValue('연결된 재고 기록'), '[Expected 3] The figure is unchanged after typing').toHaveText('0');
    });

    await step('Act: Step 4 — Open 변경 이력 (Change history)', async () => {
      await form.openHistory();
      settings = (await form.readHistoryRows()).map((r) => r[2]);
    });

    await step('Assert: Expected 4 — None of the three figures is written to the history', async () => {
      for (const label of ['연결된 재고 기록', '연결된 매장', '연결된 상품-창고 매핑']) {
        expect(settings.join('\n'), `[Expected 4] ${label} never appears in the history`).not.toContain(label);
      }
    });
  });

  test('TC_US069_163 — Delete is blocked when only 1 ACTIVE product mapping remains', async ({ page, warehouseFormPage: form, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_163', 'Critical', [...TAGS, 'cross-module'], `With exactly one ACTIVE (SKU, warehouse, owner) mapping and no stock / store, 창고 삭제 is disabled and its tooltip names ONLY the mapping cause "(${WH_TEXT.causeMapping(1)})". ${MAPPING_DATA}`);
    let parent = { id: 0, name: '' };

    await step('Arrange: Pre-condition 1 — Warehouse with 0 stock, 0 stores and exactly 1 ACTIVE US071 mapping (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_163');
      await warehouseCleanup.createMapping(parent.id);
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit of that warehouse', async () => {
      await form.open(parent.id);
      await form.waitForReferenceFigures();
    });

    await step('Act: Step 2 — Observe the 창고 삭제 (Delete warehouse) button', async () => {
      await form.deleteButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The Delete button is disabled', async () => {
      await expect(form.deleteButton, '[Expected 2] 창고 삭제 is disabled').toBeDisabled();
    });

    await step('Act: Step 3 — Hover over the button and read the tooltip', async () => {
      await form.hoverBlockedDelete();
    });

    await step(`Assert: Expected 3 — The tooltip states only "(${WH_TEXT.causeMapping(1)})"`, async () => {
      await expect(form.tooltip, `[Expected 3] Tooltip reads "${WH_TEXT.deleteBlocked(WH_TEXT.causeMapping(1))}"`).toHaveText(WH_TEXT.deleteBlocked(WH_TEXT.causeMapping(1)));
      await expect(form.tooltip, '[Expected 3] No stock-record cause is listed').not.toContainText('재고 기록');
      await expect(form.tooltip, '[Expected 3] No store cause is listed').not.toContainText('매장');
    });
  });

  test('TC_US069_164 — An INACTIVE mapping does not block Delete', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_164', 'Critical', [...TAGS, 'cross-module'], `With the warehouse's only US071 mapping switched to INACTIVE (and no stock / store), 창고 삭제 is enabled and 영구 삭제 succeeds — count ③ counts ACTIVE mappings only. ${MAPPING_DATA}`);
    let parent = { id: 0, name: '' };
    let mappingStatus = '';
    let deleteStatus = 0;
    let afterStatus = 0;

    await step('Arrange: Pre-condition 1 — Same set-up as TC_US069_163 but the only mapping is INACTIVE (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_164');
      const mappingId = await warehouseCleanup.createMapping(parent.id);
      await warehouseApi.deactivateMapping(mappingId);
      mappingStatus = (await warehouseApi.mappingsOf(parent.id)).body.items.find((m) => m.id === mappingId)?.status ?? '';
      expect(mappingStatus, 'Pre-condition: the only mapping is INACTIVE').toBe('INACTIVE');
    });

    await step('Act: Step 1 — Open Warehouse Detail/Edit', async () => {
      await form.open(parent.id);
      await form.waitForReferenceFigures();
    });

    await step('Act: Step 2 — Observe the 창고 삭제 (Delete warehouse) button', async () => {
      await form.deleteButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — The Delete button is enabled', async () => {
      await expect(form.deleteButton, '[Expected 2] 창고 삭제 is enabled').toBeEnabled();
    });

    await step('Act: Step 3 — Perform the delete and confirm', async () => {
      await form.openDeleteDialog();
      deleteStatus = (await form.confirmDelete()).status();
      await list.waitForListLoaded();
      afterStatus = (await warehouseApi.get(parent.id)).status;
    });

    await step('Assert: Expected 3 — The delete succeeds', async () => {
      expect(deleteStatus, '[Expected 3] DELETE /warehouses/{id} succeeds (204)').toBe(204);
      await expect(form.toast(WH_TEXT.toastDeleted(parent.name)), `[Expected 3] "“${parent.name}” 창고가 삭제되었습니다. …" is shown`).toBeVisible();
      expect(afterStatus, '[Expected 3] The warehouse no longer exists (404)').toBe(404);
    });
  });

  test('TC_US069_167 — The server re-checks all 3 counts at the moment of deletion', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta(
      'TC_US069_167',
      'Critical',
      [...TAGS, 'cross-module'],
      'Session A opens a warehouse whose 3 counts are 0 (Delete enabled); session B then creates an ACTIVE US071 mapping pointing at it; A\'s ' +
        '영구 삭제 and a direct API DELETE are both refused with WH-WAREHOUSE_IN_USE and the warehouse stays listed. Deviation from TC: session B ' +
        `is the API (same ADMIN account), not a second browser; the UI error message is not specified by the TC, so the refusal is asserted on the response code. ${MAPPING_DATA}`,
    );
    let parent = { id: 0, name: '' };
    let uiRefusal = { status: 0, code: '' };
    let apiRefusal = { status: 0, code: '' };

    await step('Arrange: Pre-condition 1 — A warehouse with all 3 counts = 0 (automation-owned); two sessions: A = browser, B = API', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_167');
    });

    await step('Act: Step 1 — Session A: open Warehouse Detail/Edit and confirm 창고 삭제 is enabled (no reload afterwards)', async () => {
      await form.open(parent.id);
      await form.waitForReferenceFigures();
      await expect(form.deleteButton, 'Session A sees 창고 삭제 enabled before session B acts').toBeEnabled();
    });

    await step('Act: Step 2 — Session B: create an ACTIVE product mapping pointing at that warehouse', async () => {
      await warehouseCleanup.createMapping(parent.id);
    });

    await step('Act: Step 3 — Session A: click 창고 삭제 and confirm 영구 삭제', async () => {
      await form.openDeleteDialog();
      const response = await form.confirmDelete();
      uiRefusal = { status: response.status(), code: (await response.json()).code };
    });

    await step('Assert: Expected 3 — Refused with WH-WAREHOUSE_IN_USE; the warehouse remains on the list', async () => {
      expect(uiRefusal.code, `[Expected 3] The delete is refused with WH-WAREHOUSE_IN_USE (HTTP ${uiRefusal.status})`).toBe('WH-WAREHOUSE_IN_USE');
      expect((await warehouseApi.get(parent.id)).status, '[Expected 3] The warehouse still exists').toBe(200);
      await list.open();
      await list.search({ keyword: parent.name });
      await expect(list.tableRows, '[Expected 3] The warehouse and its 5 buckets are still listed').toHaveCount(6);
    });

    await step('Act: Step 4 — Repeat the scenario sending the DELETE request directly via the API', async () => {
      const { status, body } = await warehouseApi.remove<{ code: string }>(parent.id);
      apiRefusal = { status, code: body?.code ?? '' };
    });

    await step('Assert: Expected 4 — The API also returns WH-WAREHOUSE_IN_USE', async () => {
      expect(apiRefusal.code, `[Expected 4] The API DELETE is refused with WH-WAREHOUSE_IN_USE (HTTP ${apiRefusal.status})`).toBe('WH-WAREHOUSE_IN_USE');
      expect((await warehouseApi.get(parent.id)).status, '[Expected 4] It never silently succeeds — the warehouse still exists').toBe(200);
    });
  });

  test('TC_US069_168 — The mapping count does not extend to the 5 buckets', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_168', 'Medium', [...TAGS, 'cross-module', 'api'], `US071 refuses a mapping against a virtual bucket, and the parent's 연결된 상품-창고 매핑 figure equals the ACTIVE mappings of the warehouse itself (buckets are not added). Deviation from TC: the US071 refusal code is not specified by the TC, so any 4xx refusal with no mapping stored passes. ${MAPPING_DATA}`);
    let parent = { id: 0, name: '' };
    let bucketId = 0;
    let bucketAttempt = { status: 0, body: '' };
    let bucketMappings = -1;
    let ownActive = -1;
    let panelFigure = '';

    await step('Arrange: Pre-condition 1 — A fully-provisioned warehouse with 5 buckets (automation-owned)', async () => {
      parent = await warehouseCleanup.create('SUPPLIER', 'TC_US069_168');
      bucketId = (await warehouseApi.bucketsOf(parent)).find((b) => b.name.endsWith(BUCKET_SUFFIXES[4]))!.id;
    });

    await step(`Act: Step 1 — Try to create a product-warehouse mapping pointing at a bucket (${BUCKET_SUFFIXES[4]}) via the US071 API`, async () => {
      const [product] = await warehouseApi.selectableProducts(MAPPING_PRODUCT_KEYWORD);
      const created = await warehouseApi.createMapping({ productId: product.id, warehouseId: bucketId, ownershipType: MAPPING_OWNERSHIP, isDefault: false });
      if (created.status < 300) warehouseCleanup.trackMapping(created.body.id);
      bucketAttempt = { status: created.status, body: JSON.stringify(created.body) };
      bucketMappings = (await warehouseApi.mappingsOf(bucketId)).body.paging.totalCount;
    });

    await step('Assert: Expected 1 — US071 refuses to register a triple against a virtual warehouse', async () => {
      expect(bucketAttempt.status, `[Expected 1] POST mapping on a bucket is refused (response: ${bucketAttempt.body})`).toBeGreaterThanOrEqual(400);
      expect(bucketAttempt.status, '[Expected 1] The refusal is a client error, not a server fault').toBeLessThan(500);
      expect(bucketMappings, '[Expected 1] No mapping is stored against the bucket').toBe(0);
    });

    await step('Act: Step 2 — Check the 연결된 상품-창고 매핑 figure on the parent warehouse', async () => {
      await form.open(parent.id);
      await form.waitForReferenceFigures();
      panelFigure = (await form.panelValue('연결된 상품-창고 매핑').innerText()).trim();
      ownActive = (await warehouseApi.mappingsOf(parent.id, 'ACTIVE')).body.paging.totalCount;
    });

    await step('Assert: Expected 2 — Count ③ only counts the warehouse itself, not its buckets', async () => {
      expect(panelFigure, `[Expected 2] 연결된 상품-창고 매핑 equals the parent's own ACTIVE mappings (${ownActive})`).toBe(String(ownActive));
    });
  });

  for (const skip of [
    { tc: 'TC_US069_158', priority: 'Critical' as const, title: 'Delete is blocked when stock sits inside a bucket', description: 'Stock inside a bucket counts in 연결된 재고 기록, disables Delete and makes the API refuse with WH-WAREHOUSE_IN_USE.', reason: NO_STOCK },
    { tc: 'TC_US069_160', priority: 'High' as const, title: 'An Inactive bucket is no longer a valid destination for new movements', description: 'A goods receipt routed into a deactivated warehouse\'s bucket fails with WH-WAREHOUSE_NOT_FOUND.', reason: `${NO_STOCK} The US105 goods-receipt flow can only complete existing inbound rows of real warehouses — it cannot be routed into an automation-owned bucket.` },
    { tc: 'TC_US069_161', priority: 'Medium' as const, title: 'An Inactive bucket\'s existing ledger balance is still readable', description: 'Deactivating the parent leaves the bucket\'s ledger lines readable and unchanged.', reason: `${NO_STOCK} No ledger read API/screen for a bucket was found either.` },
    { tc: 'TC_US069_166', priority: 'High' as const, title: 'The tooltip renders only the non-zero causes', description: 'The delete tooltip lists only the non-zero stock / store / mapping causes.', reason: `warehouses A and C need stock records (${NO_STOCK}) and warehouse B needs a linked store (${NO_STORE_CONTRACT})` },
    { tc: 'TC_US069_169', priority: 'High' as const, title: 'All three counts are real figures, never stubbed to 0', description: 'The three panel figures match a direct query and the Korean tooltip lists only the non-zero parts.', reason: `the pre-condition needs DB access and its migration set (not available to the suite); step 2 needs stock and store reference data (${NO_STOCK} ${NO_STORE_CONTRACT})` },
  ]) {
    test(`${skip.tc} — ${skip.title}`, async () => {
      await skipTc(skip.tc, skip.priority, TAGS, skip.description, skip.reason);
    });
  }
});
