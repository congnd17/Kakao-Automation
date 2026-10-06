import { test, expect } from '@fixtures/base.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { getAccountDisplayName } from '@utils/auth-token';
import { WH_TEXT } from '@utils/warehouse.data';
import { WarehouseApi, WarehouseWriteBody } from '@api/warehouse.api';

/**
 * Kiểm tra version khi ghi 창고 (US069 BR-11) — 409 WH-WAREHOUSE_STALE_VERSION và dialog [M-CONFLICT] 저장 충돌.
 * Nguồn TC: input/US069_TestCases_EN_v1.20.md — mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` /
 * `Assert: Expected N`. TC lệch UI thật → assert theo UI, ghi "Deviation from TC" (quyết định 28/09).
 *
 * Phiên B (và C) = trình duyệt đang chạy test; phiên A "lưu trước" = 1 lần ghi qua API trên cùng warehouse (cùng backend,
 * cùng version check) — môi trường không có 2 admin đồng thời cho mọi test. Dữ liệu: mỗi test tự tạo warehouse
 * `auto_US069_<TC>_<timestamp>` và xoá ở teardown.
 */
const TAGS = ['ui', 'warehouse', 'warehouse-conflict'];
const SESSION_A = 'Deviation from TC: session A (and C) is an API save on the same warehouse — same backend, same version check.';
const FIELD_LABELS = ['창고명', '국가', '거리(상세) 주소', '도시', '주/도', '우편번호', '추가 주소', '전화번호', '국가번호', '물류사 유형', '물류사 창고 코드', '물류 채널 코드', '물류사 연동 정보 (JSON)', '상태'];

/** Phiên A lưu trước: ghi `patch` qua API trên bản mới nhất. */
async function sessionASaves(api: WarehouseApi, id: number, patch: Partial<WarehouseWriteBody>): Promise<void> {
  const latest = (await api.get(id)).body;
  const result = await api.update(id, WarehouseApi.toUpdateBody(latest, patch));
  if (result.status !== 200) throw new Error(`Session A save failed with ${result.status}: ${JSON.stringify(result.body)}`);
}

test.describe('[Conflict] Optimistic version check and the 저장 충돌 dialog', () => {
  test.describe.configure({ timeout: 120_000 });

  test('TC_US069_140 — A second save is refused when the row has changed underneath it', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_140', 'Critical', TAGS, `A's save succeeds; B's save from a form loaded before A's save is refused with HTTP 409 WH-WAREHOUSE_STALE_VERSION, nothing is written and the 저장 충돌 dialog opens over B's form. ${SESSION_A} Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    const aName = () => `${wh.name}_A`;
    let bResponse = { status: 0, code: '' };

    await step('Arrange: Pre-condition 1 — Two writable sessions on the same warehouse (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_140');
    });

    await step('Act: Step 1 — A and B both open the warehouse in Detail/Edit', async () => {
      await form.open(wh.id);
    });

    await step('Act: Step 2 — A edits 창고명 and saves', async () => {
      await sessionASaves(warehouseApi, wh.id, { name: aName() });
    });

    await step('Assert: Expected 2 — A\'s save succeeds', async () => {
      expect((await warehouseApi.get(wh.id)).body.name, '[Expected 2] A\'s 창고명 is stored').toBe(aName());
    });

    await step('Act: Step 3 — B edits 도시 and clicks 저장 on the form loaded before A\'s save', async () => {
      await form.cityInput.fill('Session B city');
      const response = await form.saveAndWait();
      bResponse = { status: response.status(), code: (await response.json()).code };
    });

    await step('Assert: Expected 3 — B is refused with 409 WH-WAREHOUSE_STALE_VERSION, nothing written, the dialog opens', async () => {
      expect(bResponse.status, '[Expected 3] HTTP 409').toBe(409);
      expect(bResponse.code, '[Expected 3] Error code WH-WAREHOUSE_STALE_VERSION').toBe('WH-WAREHOUSE_STALE_VERSION');
      const stored = (await warehouseApi.get(wh.id)).body;
      expect(stored.city ?? null, '[Expected 3] B\'s value is NOT written').toBeNull();
      expect(stored.name, '[Expected 3] A\'s change is kept').toBe(aName());
      await expect(form.conflictDialog, '[Expected 3] The 저장 충돌 dialog opens over B\'s form').toBeVisible();
    });
  });

  test('TC_US069_141 — The check operates at row level, not field level', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_141', 'Critical', TAGS, `A changes only 창고명, B changes only 전화번호 — B is still refused with 409: the unit of conflict is the row. ${SESSION_A} Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    let status = 0;

    await step('Arrange: Pre-condition 1 — Two sessions have the same warehouse open (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_141');
    });

    await step('Act: Step 1 — A and B both open the warehouse', async () => {
      await form.open(wh.id);
    });

    await step('Act: Step 2 — A edits ONLY 창고명 and saves', async () => {
      await sessionASaves(warehouseApi, wh.id, { name: `${wh.name}_A` });
    });

    await step('Act: Step 3 — B edits ONLY 전화번호 and clicks 저장', async () => {
      await form.numberInput.fill('010-4141-4141');
      status = (await form.saveAndWait()).status();
    });

    await step('Assert: Expected 3 — B is still refused with 409 although the fields differ', async () => {
      expect(status, '[Expected 3] HTTP 409 even for a different field').toBe(409);
      await expect(form.conflictDialog, '[Expected 3] The 저장 충돌 dialog opens').toBeVisible();
      expect((await warehouseApi.get(wh.id)).body.number, '[Expected 3] B\'s phone is not written — no field-level merge').not.toBe('01041414141');
    });
  });

  test('TC_US069_142 — Content of the 저장 충돌 dialog', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_142', 'High', TAGS, `Title "저장 충돌", message "이 창고는 다른 사용자가 변경했습니다." and attribution "{name}님이 {time}에 변경했습니다" read from the stored updated_by / updated_at. ${SESSION_A} Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    let updatedAt = '';

    await step('Arrange: Pre-condition 1 — A conflict is set up as in TC_US069_140 (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_142');
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { name: `${wh.name}_A` });
      updatedAt = (await warehouseApi.get(wh.id)).body.updatedAt;
    });

    await step('Act: Step 1 — Trigger the conflict; the 저장 충돌 dialog opens', async () => {
      await form.cityInput.fill('Conflict city');
      await form.saveAndWait();
      await expect(form.conflictDialog).toBeVisible();
    });

    await step('Act: Step 2 — Observe the title, the message line and the attribution line', async () => {
      await form.conflictDialog.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 2 — 저장 충돌, the exact message and the stored updated_by / updated_at', async () => {
      const kst = new Date(new Date(updatedAt).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
      await expect(form.conflictDialog.locator('.modal-title'), '[Expected 2] Title reads 저장 충돌').toHaveText(WH_TEXT.conflictTitle);
      await expect(form.conflictMessage, '[Expected 2] Message reads 이 창고는 다른 사용자가 변경했습니다.').toHaveText(WH_TEXT.conflictMessage);
      await expect(form.conflictAttribution, '[Expected 2] Attribution reads "{updated_by}님이 {updated_at}에 변경했습니다."').toHaveText(`${getAccountDisplayName('submitter')}님이 ${kst}에 변경했습니다.`);
    });
  });

  test('TC_US069_143 — The dialog lists the differing fields by name only', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_143', 'High', TAGS, `After A saves 창고명 and 도시, B's conflict dialog lists field NAMES, one per line, using the Detail/Edit labels (incl. 창고명 and 도시) — never DB columns, change types or old/new values. ${SESSION_A} B changed 전화번호 to enable 저장, so it is listed too (the list compares B's form with the stored record). Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    let fields: string[] = [];

    await step('Arrange: Pre-condition 1 — Two sessions have the same warehouse open (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_143');
      await form.open(wh.id);
    });

    await step('Act: Step 1 — A edits 창고명 AND 도시 and saves', async () => {
      await sessionASaves(warehouseApi, wh.id, { name: `${wh.name}_A`, city: 'A city' });
    });

    await step('Act: Step 2 — B clicks 저장 (after editing 전화번호 to enable it); the dialog opens', async () => {
      await form.numberInput.fill('010-1433-1433');
      await form.saveAndWait();
      await expect(form.conflictDialog).toBeVisible();
    });

    await step('Act: Step 3 — Observe the field list in the dialog', async () => {
      await expect(form.conflictFields.first()).toBeVisible();
      fields = (await form.conflictFields.allInnerTexts()).map((f) => f.trim());
    });

    await step('Assert: Expected 3 — Field names only, one per line, with the screen labels', async () => {
      await expect(form.conflictFieldsTitle, '[Expected 3] The list heading 다른 사용자가 아래 항목을 변경했습니다. is shown').toBeVisible();
      expect(fields, '[Expected 3] 창고명 is listed').toContain('창고명');
      expect(fields, '[Expected 3] 도시 is listed').toContain('도시');
      for (const field of fields) {
        expect(FIELD_LABELS, `[Expected 3] "${field}" is a Detail/Edit field label (not a DB column / change type)`).toContain(field);
        expect(field, `[Expected 3] "${field}" shows no old/new value`).not.toMatch(/→|A city|_A$/);
      }
      expect(fields.length, '[Expected 3] The list is not empty').toBeGreaterThan(0);
    });
  });

  test('TC_US069_144 — 다시 불러오기 (Reload) in the 저장 충돌 dialog', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_144', 'High', TAGS, `다시 불러오기 renders as btn-outline-secondary; clicking it discards all of B's edits, reloads the stored record (A's values) and closes the dialog with no second confirmation. ${SESSION_A} Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    const seen = { dialogs: -1, name: '', city: '' };

    await step('Arrange: Pre-condition 1 — The 저장 충돌 dialog is open in session B (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_144');
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { name: `${wh.name}_A` });
      await form.cityInput.fill('B typed city');
      await form.saveAndWait();
      await expect(form.conflictDialog).toBeVisible();
    });

    await step('Act: Step 1 — Observe the style of the 다시 불러오기 button', async () => {
      await form.conflictReloadButton.scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 1 — 다시 불러오기 renders as btn-outline-secondary (no primary weight)', async () => {
      await expect(form.conflictReloadButton, '[Expected 1] It is btn-outline-secondary').toHaveClass(/btn-outline-secondary/);
      await expect(form.conflictReloadButton, '[Expected 1] It is not a primary button').not.toHaveClass(/btn-primary/);
    });

    await step('Act: Step 2 — Click 다시 불러오기 (Reload)', async () => {
      const reloaded = page.waitForResponse((r) => new RegExp(`/api/v1/warehouses/${wh.id}$`).test(r.url()) && r.request().method() === 'GET');
      await form.click(form.conflictReloadButton, '다시 불러오기 (Reload) button');
      await reloaded;
    });

    await step('Act: Step 3 — Observe the form and the dialog', async () => {
      await expect(form.nameInput).toHaveValue(`${wh.name}_A`);
      seen.dialogs = await page.getByRole('dialog').count();
      seen.name = await form.nameInput.inputValue();
      seen.city = await form.cityInput.inputValue();
    });

    await step('Assert: Expected 2/3 — B\'s edits discarded, A\'s stored values reloaded, dialog closed, no second confirmation', async () => {
      expect(seen.dialogs, '[Expected 2/3] No dialog remains open (no second confirmation)').toBe(0);
      expect(seen.name, '[Expected 2/3] The form shows A\'s stored 창고명').toBe(`${wh.name}_A`);
      expect(seen.city, '[Expected 2/3] B\'s typed 도시 is discarded').toBe('');
    });
  });

  test('TC_US069_145 — 덮어쓰기 (Overwrite) is itself subject to the version check', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_145', 'High', TAGS, `If session C saves while B's dialog is open, B's first 덮어쓰기 is refused again (409) and the dialog re-opens with a new field list; the second 덮어쓰기 succeeds and B's values overwrite the current version. ${SESSION_A} Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    const seen = { first: 0, reopened: false, fieldsAfterC: [] as string[], second: 0 };

    await step('Arrange: Pre-condition 1 — Sessions A, B and C are writable (automation-owned warehouse)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_145');
      await form.open(wh.id);
    });

    await step('Act: Step 1 — Create a conflict between A and B; the dialog opens on B\'s side', async () => {
      await sessionASaves(warehouseApi, wh.id, { name: `${wh.name}_A` });
      await form.cityInput.fill('B city');
      await form.saveAndWait();
      await expect(form.conflictDialog).toBeVisible();
    });

    await step('Act: Step 2 — Before B clicks anything, session C saves the same warehouse', async () => {
      await sessionASaves(warehouseApi, wh.id, { zipCode: '24545' });
    });

    await step('Act: Step 3 — B clicks 덮어쓰기 (Overwrite)', async () => {
      const response = page.waitForResponse((r) => r.request().method() === 'PATCH');
      await form.click(form.conflictOverwriteButton, '덮어쓰기 (Overwrite) button');
      seen.first = (await response).status();
      await expect(form.conflictFields.filter({ hasText: '우편번호' })).toBeVisible();
      seen.reopened = await form.conflictDialog.isVisible();
      seen.fieldsAfterC = (await form.conflictFields.allInnerTexts()).map((f) => f.trim());
    });

    await step('Assert: Expected 3 — Overwrite is refused again and the dialog re-opens with a new list (against C)', async () => {
      expect(seen.first, '[Expected 3] The first overwrite is refused with 409').toBe(409);
      expect(seen.reopened, '[Expected 3] The dialog re-opens').toBe(true);
      expect(seen.fieldsAfterC, '[Expected 3] The new list includes C\'s 우편번호 change').toContain('우편번호');
    });

    await step('Act: Step 4 — B clicks 덮어쓰기 again', async () => {
      const response = page.waitForResponse((r) => r.request().method() === 'PATCH');
      await form.click(form.conflictOverwriteButton, '덮어쓰기 (Overwrite) button');
      seen.second = (await response).status();
    });

    await step('Assert: Expected 4 — This time it succeeds and B\'s values overwrite the current version', async () => {
      expect(seen.second, '[Expected 4] The second overwrite succeeds').toBe(200);
      const stored = (await warehouseApi.get(wh.id)).body;
      expect(stored.city, '[Expected 4] B\'s 도시 is stored').toBe('B city');
      expect(stored.name, '[Expected 4] B\'s (original) 창고명 overwrites A\'s').toBe(wh.name);
    });
  });

  test('TC_US069_146 — The 저장 충돌 dialog cannot be closed via Esc or an outside click', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_146', 'Medium', TAGS, `Esc and an outside click do not close the dialog and it has no X button — the ADMIN must choose 다시 불러오기 or 덮어쓰기. ${SESSION_A} Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    const seen = { afterEsc: 0, afterOutside: 0 };

    await step('Arrange: Pre-condition 1 — The 저장 충돌 dialog is open (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_146');
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { name: `${wh.name}_A` });
      await form.cityInput.fill('Esc city');
      await form.saveAndWait();
      await expect(form.conflictDialog).toBeVisible();
    });

    await step('Act: Step 1 — Press Esc', async () => {
      await page.keyboard.press('Escape');
      seen.afterEsc = await form.conflictDialog.count();
    });

    await step('Act: Step 2 — Click outside the dialog area', async () => {
      await page.mouse.click(8, 540);
      seen.afterOutside = await form.conflictDialog.count();
    });

    await step('Assert: Expected 1/2 — The dialog does not close', async () => {
      expect(seen.afterEsc, '[Expected 1/2] Still open after Esc').toBe(1);
      expect(seen.afterOutside, '[Expected 1/2] Still open after an outside click').toBe(1);
      await expect(form.conflictDialog, '[Expected 1/2] The dialog is visible').toBeVisible();
    });

    await step('Act: Step 3 — Look for an X-style close button on the dialog', async () => {
      await form.conflictDialog.locator('.modal-header').scrollIntoViewIfNeeded();
    });

    await step('Assert: Expected 3 — No X button; only 다시 불러오기 or 덮어쓰기 remain', async () => {
      await expect(form.conflictCloseIcon, '[Expected 3] There is no X close button').toHaveCount(0);
      await expect(form.conflictDialog.getByRole('button'), '[Expected 3] Only 다시 불러오기 and 덮어쓰기 are offered').toHaveCount(2);
    });
  });

  test('TC_US069_147 — The form behind the dialog keeps the typed values', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_147', 'High', TAGS, `While the dialog is open, every value B typed (창고명, 전화번호) is still on the form — not cleared, not reloaded. ${SESSION_A} Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    const typed = { name: '', number: '010-1477-1477' };
    const seen = { name: '', number: '' };

    await step('Arrange: Pre-condition 1 — Two sessions have the warehouse open; A has already saved (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_147');
      typed.name = `${wh.name}_B`;
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { city: 'A city' });
    });

    await step('Act: Step 1 — B types new values into 창고명 and 전화번호', async () => {
      await form.nameInput.fill(typed.name);
      await form.numberInput.fill(typed.number);
    });

    await step('Act: Step 2 — B clicks 저장; the dialog opens', async () => {
      await form.saveAndWait();
      await expect(form.conflictDialog).toBeVisible();
    });

    await step('Act: Step 3 — Observe the form behind the dialog', async () => {
      seen.name = await form.nameInput.inputValue();
      seen.number = await form.numberInput.inputValue();
    });

    await step('Assert: Expected 3 — Every typed value is still present on the form', async () => {
      await expect(form.conflictDialog, '[Expected 3] The dialog is still open').toBeVisible();
      expect(seen.name, '[Expected 3] 창고명 keeps B\'s value').toBe(typed.name);
      expect(seen.number, '[Expected 3] 전화번호 keeps B\'s value').toBe(typed.number);
    });
  });

  test('TC_US069_148 — The guard blocks update / deactivate / reactivate, not delete', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_148', 'Medium', TAGS, `A version conflict refuses 저장, 창고 비활성화 and 재활성화 with 409 and the 저장 충돌 dialog (the action variant carries 다시 시도), while 창고 삭제 is not blocked by this guard. ${SESSION_A} Data: automation-owned warehouses are created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    let deletable = { id: 0, name: '' };
    const statuses: Record<string, number> = {};
    const dialogs: Record<string, boolean> = {};

    await step('Arrange: Pre-condition 1 — The same warehouse is open in two sessions; another warehouse is eligible for delete (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_148');
      deletable = await warehouseCleanup.create('SUPPLIER', 'TC_US069_148', { name: `${wh.name}_del` });
    });

    await step('Act: Step 1 — Create a version conflict, then attempt 저장', async () => {
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { city: 'C1' });
      await form.zipCodeInput.fill('20001');
      statuses.save = (await form.saveAndWait()).status();
      dialogs.save = await form.conflictDialog.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false);
    });

    await step('Act: Step 2 — Create a version conflict, then attempt 창고 비활성화', async () => {
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { city: 'C2' });
      await form.openDeactivateDialog();
      statuses.deactivate = (await form.confirmDeactivate()).status();
      await expect(form.conflictDialog).toBeVisible();
      dialogs.deactivate = await form.conflictRetryButton.isVisible();
    });

    await step('Act: Step 3 — Create a version conflict, then attempt 재활성화', async () => {
      await warehouseApi.deactivate(wh.id, (await warehouseApi.get(wh.id)).body.version);
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { city: 'C3' });
      statuses.reactivate = (await form.reactivate()).status();
      await expect(form.conflictDialog).toBeVisible();
      dialogs.reactivate = await form.conflictRetryButton.isVisible();
    });

    await step('Assert: Expected 1/2/3 — All three are refused with 409 and the 저장 충돌 dialog', async () => {
      for (const action of ['save', 'deactivate', 'reactivate']) {
        expect(statuses[action], `[Expected 1/2/3] ${action} is refused with 409`).toBe(409);
        expect(dialogs[action], `[Expected 1/2/3] ${action} opens the 저장 충돌 dialog`).toBe(true);
      }
    });

    await step('Act: Step 4 — Create a version conflict, then attempt 창고 삭제', async () => {
      await form.open(deletable.id);
      await sessionASaves(warehouseApi, deletable.id, { city: 'C4' });
      await form.openDeleteDialog();
      statuses.remove = (await form.confirmDelete()).status();
    });

    await step('Assert: Expected 4 — Delete is not blocked by the version guard', async () => {
      expect(statuses.remove, '[Expected 4] The delete succeeds (204)').toBe(204);
      expect((await warehouseApi.get(deletable.id)).status, '[Expected 4] The warehouse is gone').toBe(404);
    });
  });

  test('TC_US069_149 — An overwrite is recorded in the change history', async ({ page, warehouseFormPage: form, warehouseListPage: list, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_149', 'High', TAGS, `A renames "W" to "X"; B (still holding "W") is refused, then overwrites; 변경 이력 gets one record attributed to B with ~~X~~ → **W** on 창고명. ${SESSION_A} B also edits 도시 (needed to enable 저장), so the record carries that line too. Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    const x = () => `${wh.name}_X`;
    let rows: string[][] = [];

    await step('Arrange: Pre-condition 1 — Two sessions on the warehouse whose 창고명 starts as "W" (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_149');
      await form.open(wh.id);
    });

    await step('Act: Step 1 — A changes 창고명 to "X" and saves', async () => {
      await sessionASaves(warehouseApi, wh.id, { name: x() });
    });

    await step('Act: Step 2 — B (still holding "W") clicks 저장, is refused, then clicks 덮어쓰기', async () => {
      await form.cityInput.fill('Overwrite city');
      await form.saveAndWait();
      await expect(form.conflictDialog).toBeVisible();
      const saved = page.waitForResponse((r) => r.request().method() === 'PATCH');
      await form.click(form.conflictOverwriteButton, '덮어쓰기 (Overwrite) button');
      expect((await saved).status()).toBe(200);
      await list.waitForListLoaded();
    });

    await step('Act: Step 3 — Open 변경 이력 (Change history)', async () => {
      await form.open(wh.id);
      await form.openHistory();
      rows = await form.readHistoryRows();
    });

    await step('Assert: Expected 3 — One new record by B showing ~~X~~ → **W** on 창고명', async () => {
      expect(rows.length, '[Expected 3] Created + A\'s rename + B\'s overwrite').toBe(3);
      expect(rows[0][1], '[Expected 3] The overwrite is attributed to B').toBe(getAccountDisplayName('submitter'));
      const nameLine = form.historyChangeCell(0).locator('span.d-block').filter({ has: page.locator('s', { hasText: x() }) });
      await expect(nameLine.locator('s'), '[Expected 3] A\'s value X is on the before side, struck through').toHaveText(x());
      await expect(nameLine.locator('b'), '[Expected 3] B\'s value W is on the after side, bold').toHaveText(wh.name);
    });
  });

  test('TC_US069_150 — Field-list overflow and the Korean UI of 저장 충돌', async ({ page, warehouseFormPage: form, warehouseApi, warehouseCleanup }) => {
    const step = makeStep(page);
    await tcMeta('TC_US069_150', 'Medium', [...TAGS, 'i18n'], `With more than 6 differing fields the list scrolls inside a fixed-height box and the dialog does not grow; every string reads in Korean (저장 충돌 · 이 창고는 다른 사용자가 변경했습니다. · {name}님이 {time}에 변경했습니다 · 다시 불러오기 · 덮어쓰기). ${SESSION_A} The UI is already 한국어, so Step 3 recreates the conflict in the same language. Data: an automation-owned warehouse is created and deleted afterwards.`);
    let wh = { id: 0, name: '' };
    const seen = { count: 0, scrolls: false, listHeight: 0, dialogHeight: 0, text: '' };
    const conflictOnSevenFields = async () => {
      await form.open(wh.id);
      await sessionASaves(warehouseApi, wh.id, { name: `${wh.name}_${Date.now() % 1000}`, addr: `Addr ${Date.now()}`, city: `City ${Date.now()}`, stateOrProvince: `State ${Date.now()}`, zipCode: String(Date.now()).slice(-5), detailAddr: `Detail ${Date.now()}`, number: String(Date.now()).slice(-9) });
      await form.callingCodeInput.fill('+81');
      await form.saveAndWait();
      await expect(form.conflictFields.first()).toBeVisible();
    };

    await step('Arrange: Pre-condition 1 — A conflict differing on more than 6 fields can be set up (automation-owned)', async () => {
      wh = await warehouseCleanup.create('SUPPLIER', 'TC_US069_150');
    });

    await step('Act: Step 1 — Create a conflict where the two sides differ on more than 6 fields', async () => {
      await conflictOnSevenFields();
    });

    await step('Act: Step 2 — Observe the field list and the dialog size', async () => {
      seen.count = await form.conflictFields.count();
      seen.scrolls = await form.conflictFieldList.evaluate((el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto');
      seen.listHeight = (await form.conflictFieldList.boundingBox())!.height;
      seen.dialogHeight = (await form.conflictDialog.locator('.modal-content').boundingBox())!.height;
    });

    await step('Assert: Expected 2 — The list scrolls internally and the dialog does not grow', async () => {
      expect(seen.count, '[Expected 2] More than 6 fields differ').toBeGreaterThan(6);
      expect(seen.scrolls, '[Expected 2] The field list scrolls inside its own box').toBe(true);
      expect(seen.listHeight, '[Expected 2] The list box stays at its 160px maximum').toBeLessThanOrEqual(161);
      expect(seen.dialogHeight, '[Expected 2] The dialog stays within the viewport').toBeLessThan(1080);
    });

    await step('Act: Step 3 — With 한국어, recreate the conflict', async () => {
      await form.click(form.conflictReloadButton, '다시 불러오기 (Reload) button');
      await expect(form.conflictDialog).toHaveCount(0);
      await conflictOnSevenFields();
    });

    await step('Act: Step 4 — Observe every displayed string', async () => {
      seen.text = (await form.conflictDialog.innerText()).replace(getAccountDisplayName('submitter'), '');
    });

    await step('Assert: Expected 3/4 — Every string reads in Korean, no English, nothing clipped', async () => {
      await expect(form.conflictDialog.locator('.modal-title'), '[Expected 3/4] 저장 충돌').toHaveText(WH_TEXT.conflictTitle);
      await expect(form.conflictMessage, '[Expected 3/4] 이 창고는 다른 사용자가 변경했습니다.').toHaveText(WH_TEXT.conflictMessage);
      await expect(form.conflictAttribution, '[Expected 3/4] {name}님이 {time}에 변경했습니다').toHaveText(WH_TEXT.conflictAttribution(getAccountDisplayName('submitter')));
      await expect(form.conflictReloadButton, '[Expected 3/4] 다시 불러오기').toBeVisible();
      await expect(form.conflictOverwriteButton, '[Expected 3/4] 덮어쓰기').toBeVisible();
      expect(seen.text, '[Expected 3/4] No English string remains (the account name aside)').not.toMatch(/[A-Za-z]/);
    });
  });
});
