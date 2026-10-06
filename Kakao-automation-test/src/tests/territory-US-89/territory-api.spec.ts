import { test, expect } from '@fixtures/territory.fixture';
import { makeStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { NORMAL_FLAGS } from '@utils/territory.data';
import type { Territory } from '@api/territory.api';

/**
 * US089 — nhóm [API]: lời gọi ghi trực tiếp bằng account ADMIN (có quyền ghi từ 29/09) phải bị từ chối đúng mã lỗi.
 * "Query the DB / history store" → đọc qua API (không có quyền DB). Mọi lời gọi lỡ được nhận → `territoryState` ghi trả ở teardown.
 * Lịch sử append-only và dev có người sửa cùng lúc → "no history record" assert tương đối: số bản ghi không tăng.
 */
const TAGS = ['api', 'territory'];
const DATA = 'Data: every call must be refused; anything accepted is restored in teardown (shared dev).';

test.describe('[API] Territory — refused direct writes', () => {
  test.describe.configure({ timeout: 90_000 });

  test('TC_US089_43 — A write altering the country code, English or Korean name is refused and writes nothing', async ({ page, territoryApi, territoryState }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_43', 'Medium', TAGS, `Three PATCH calls on TR changing countryCode to TK, nameEn to Türkiye and nameKo to 터키공화국 (with a valid reason) are each refused with TER-1005 and write nothing: code, names and version unchanged and no new history record. Deviations: the row and the history are read through the API; on dev TR's English name is already "Türkiye" (the TC assumes "Turkey"), so step 2 sends "Turkey" instead — sending the current value is not a change. ${DATA}`);
    let before: Territory;
    let history = 0;
    const results: Record<number, { status: number; body: string }> = {};
    const reason = 'Attempt to change the country code via a direct call';

    const attempt = async (n: number, identity: { countryCode?: string; nameEn?: string; nameKo?: string }) => {
      const res = await territoryApi.update('TR', {
        vatTreatment: before.vatTreatment,
        exportDeclarationRequired: before.exportDeclarationRequired,
        reason,
        version: before.version,
        ...identity,
      });
      results[n] = { status: res.status, body: JSON.stringify(res.body) };
    };

    await step('Arrange: Pre-condition 1–2 — ADMIN session captured; TR exists (row and history read)', async () => {
      before = await territoryState.track('TR');
      history = (await territoryApi.history('TR')).length;
    });

    const cases: Array<[number, string, { countryCode?: string; nameEn?: string; nameKo?: string }]> = [
      [1, 'Send an update for TR changing the country code to TK', { countryCode: 'TK' }],
      [2, 'Send an update for TR changing the English name (Türkiye, or Turkey when it already reads Türkiye)', { nameEn: 'Türkiye' }],
      [3, 'Send an update for TR changing the Korean name to 터키공화국', { nameKo: '터키공화국' }],
    ];
    for (const [n, title, identity] of cases) {
      await step(`Act: Step ${n} — ${title}`, () => attempt(n, identity.nameEn && identity.nameEn === before.nameEn ? { nameEn: 'Turkey' } : identity));
      await step(`Assert: Expected ${n} — Refused with TER-1005; nothing written`, async () => {
        expect(results[n].status, `[Expected ${n}] The call is refused (4xx)`).toBeGreaterThanOrEqual(400);
        expect(results[n].status, `[Expected ${n}] The call is refused (4xx)`).toBeLessThan(500);
        expect(results[n].body, `[Expected ${n}] Error code TER-1005`).toContain('TER-1005');
      });
    }

    await step('Act: Step 4 — Read the TR row: code, English name, Korean name and version', async () => {
      await page.waitForLoadState();
    });

    await step('Assert: Expected 4 — All keep their original values; version unchanged; no new history record', async () => {
      const after = (await territoryApi.get('TR')).body;
      expect({ code: after.countryCode, en: after.nameEn, ko: after.nameKo }, '[Expected 4] Identity unchanged').toEqual({ code: before.countryCode, en: before.nameEn, ko: before.nameKo });
      expect(after.version, '[Expected 4] Version not incremented').toBe(before.version);
      expect((await territoryApi.history('TR')).length, '[Expected 4] No new history record').toBe(history);
    });
  });

  test('TC_US089_45 — A write with a VAT treatment outside the two allowed values is refused', async ({ page, territoryApi, territoryState }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_45', 'Medium', TAGS, `PATCH calls on JP with vatTreatment EXEMPT and "" are refused with TER-1004 and write nothing (JP stays zero-rated, version unchanged). Not automated: step 4 (the database check constraint) — the suite has no database access. ${DATA}`);
    let before: Territory;
    const results: Record<number, { status: number; body: string }> = {};

    await step('Arrange: Pre-condition 1–3 — ADMIN session captured; JP is zero-rated', async () => {
      before = await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
    });

    for (const [n, vat, title] of [[1, 'EXEMPT', 'Send an update for JP with the VAT treatment EXEMPT'], [2, '', 'Send the same update with an empty VAT treatment']] as const) {
      await step(`Act: Step ${n} — ${title}`, async () => {
        const res = await territoryApi.update('JP', { vatTreatment: vat, exportDeclarationRequired: before.exportDeclarationRequired, reason: 'Attempt an exempt value outside the allowed list', version: before.version });
        results[n] = { status: res.status, body: JSON.stringify(res.body) };
      });
      await step(`Assert: Expected ${n} — Refused with TER-1004; nothing written`, async () => {
        expect(results[n].status, `[Expected ${n}] The call is refused (4xx)`).toBeGreaterThanOrEqual(400);
        expect(results[n].status, `[Expected ${n}] The call is refused (4xx)`).toBeLessThan(500);
        expect(results[n].body, `[Expected ${n}] Error code TER-1004`).toContain('TER-1004');
      });
    }

    await step('Act: Step 3 — Read the JP VAT treatment and version', async () => {
      await page.waitForLoadState();
    });

    await step('Assert: Expected 3 — JP keeps the zero-rated value; the version does not increment', async () => {
      const after = (await territoryApi.get('JP')).body;
      expect(after.vatTreatment, '[Expected 3] Still zero-rated').toBe('ZERO_RATED');
      expect(after.version, '[Expected 3] Version unchanged').toBe(before.version);
    });

    await step('Act: Step 4 — Run a direct update statement writing EXEMPT (Not automated — no database access)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 4: needs a direct database statement' });
    });

    await step('Assert: Expected 4 — The check constraint refuses the statement (Not automated)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Expected 4: see Step 4' });
    });
  });

  test('TC_US089_50 — A write with a whitespace-only or under-10-character reason is refused (TER-1002)', async ({ page, territoryApi, territoryState }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_50', 'Medium', TAGS, `PATCH calls on JP (taxable) with the reasons "ok", ten spaces and none are each refused with TER-1002; JP keeps its VAT treatment and version and no history record is added. Deviation: "no history record yet" → the record count must not grow. ${DATA}`);
    let before: Territory;
    let history = 0;
    const results: Record<number, { status: number; body: string }> = {};

    await step('Arrange: Pre-condition 1–2 — ADMIN session captured; JP is 영세율', async () => {
      before = await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
      history = (await territoryApi.history('JP')).length;
    });

    for (const [n, reason, title] of [[1, 'ok', 'Send an update for JP (taxable) with the reason "ok"'], [2, ' '.repeat(10), 'Send it with ten consecutive spaces'], [3, '', 'Send it with the reason left empty']] as const) {
      await step(`Act: Step ${n} — ${title}`, async () => {
        const res = await territoryApi.update('JP', { vatTreatment: 'TAXABLE_STANDARD', exportDeclarationRequired: before.exportDeclarationRequired, reason, version: before.version });
        results[n] = { status: res.status, body: JSON.stringify(res.body) };
      });
      await step(`Assert: Expected ${n} — Refused with TER-1002`, async () => {
        expect(results[n].status, `[Expected ${n}] The call is refused (4xx)`).toBeGreaterThanOrEqual(400);
        expect(results[n].status, `[Expected ${n}] The call is refused (4xx)`).toBeLessThan(500);
        expect(results[n].body, `[Expected ${n}] Error code TER-1002`).toContain('TER-1002');
      });
    }

    await step('Act: Step 4 — Read the JP row and its change history (API)', async () => {
      await page.waitForLoadState();
    });

    await step('Assert: Expected 4 — Old VAT treatment, same version, no new history record', async () => {
      const after = (await territoryApi.get('JP')).body;
      expect(after.vatTreatment, '[Expected 4] VAT treatment unchanged').toBe(before.vatTreatment);
      expect(after.version, '[Expected 4] Version unchanged').toBe(before.version);
      expect((await territoryApi.history('JP')).length, '[Expected 4] No new history record').toBe(history);
    });
  });

  test('TC_US089_51 — A write carrying a reason longer than 255 characters', async ({ page, territoryApi, territoryState }) => {
    const step = makeStep(page);
    await tcMeta('TC_US089_51', 'Medium', TAGS, `Expected 1–2 are NEEDS CLARIFICATION — the responses to 256- and 1000-character reasons are recorded; Expected 3 must hold: no stored reason exceeds 255 characters, and a refused call leaves JP's VAT treatment and version unchanged. ${DATA}`);
    let before: Territory;
    const results: Record<number, { status: number; body: string }> = {};

    await step('Arrange: Pre-condition 1–3 — ADMIN session captured; JP is 영세율', async () => {
      before = await territoryState.prepare('JP', NORMAL_FLAGS('JP'));
    });

    for (const [n, length] of [[1, 256], [2, 1000]] as const) {
      await step(`Act: Step ${n} — Send an update for JP (taxable) with a ${length}-character reason`, async () => {
        const current = (await territoryApi.get('JP')).body;
        const res = await territoryApi.update('JP', { vatTreatment: 'TAXABLE_STANDARD', exportDeclarationRequired: current.exportDeclarationRequired, reason: 'A'.repeat(length), version: current.version });
        results[n] = { status: res.status, body: JSON.stringify(res.body).slice(0, 300) };
      });
      await step(`Assert: Expected ${n} — NEEDS CLARIFICATION: record the server response`, async () => {
        test.info().annotations.push({ type: `Observed (Expected ${n})`, description: `status=${results[n].status} body=${results[n].body}` });
        expect(results[n].status, `[Expected ${n}] A response was recorded`).toBeGreaterThan(0);
      });
    }

    await step('Act: Step 3 — Read the JP row and the newest history reason (API)', async () => {
      await page.waitForLoadState();
    });

    await step('Assert: Expected 3 — No stored reason exceeds 255 characters; refused calls change nothing', async () => {
      const [after, history] = [(await territoryApi.get('JP')).body, await territoryApi.history('JP')];
      expect(Math.max(0, ...history.map((r) => r.reason.length)), '[Expected 3] No stored reason exceeds 255 characters').toBeLessThanOrEqual(255);
      if (results[1].status >= 400 && results[2].status >= 400) {
        expect(after.vatTreatment, '[Expected 3] VAT treatment unchanged').toBe(before.vatTreatment);
        expect(after.version, '[Expected 3] Version unchanged').toBe(before.version);
      }
    });
  });
});
