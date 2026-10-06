import { test, expect } from '@fixtures/receipt-reconciliation-api.fixture';
import { makeApiStep } from '@utils/step';
import { tcMeta } from '@utils/tc-meta';
import { RR_TEXT } from '@utils/receipt-reconciliation.data';
import { groupPeriod } from '@api/receipt-reconciliation.api';
import type { GroupSummary, Paged, ProblemDetail } from '@api/receipt-reconciliation.api';

/**
 * US020 — nhóm [API] chạy được trên dev (30/09): lời gọi đọc trực tiếp bằng token admin (A④ — mọi admin gọi được).
 * Không có file OpenAPI `US020_openapi` trong input/ → ý "Open the OpenAPI" ghi Not automated.
 */
const TAGS = ['api', 'receipt-reconciliation'];
const DATA = 'Data: read-only calls — nothing is written.';

test.describe('[API] Receipt reconciliation — contract refusals', () => {
  test('TC_US020_074 — A list request that names no period is refused by the contract', async ({ reconApi }) => {
    const step = makeApiStep(reconApi);
    await tcMeta('TC_US020_074', 'Medium', TAGS, `GET /api/v1/reconciliation-groups without period is refused with 400 CMN-4000 (ProblemDetail, no list); with period=2026-09 it returns 200 {items, paging} holding only 2026-09 groups. Not automated: Expected 1 (period declared required, format yyyy-MM, in US020_openapi 0.4.2) — the OpenAPI file is not in input/. ${DATA}`);
    let withoutPeriod = { status: 0, body: {} as ProblemDetail };
    let withPeriod = { status: 0, body: {} as Paged<GroupSummary> };

    await step('Arrange: Pre-condition 1 — An admin token able to call the US020 API', async () => {
      expect((await reconApi.counts('2026-09')).groupCount, 'The token reads the US020 API').toBeGreaterThanOrEqual(0);
    });

    await step('Act: Step 1 — Open US020_openapi 0.4.2, operation GET /reconciliation-groups (Not automated — file not provided)', async () => {
      test.info().annotations.push({ type: 'Not automated', description: 'Step 1 / Expected 1: US020_openapi 0.4.2 is not in input/' });
    });

    await step('Assert: Expected 1 — period is declared required, format yyyy-MM (Not automated)', async () => {
      expect(test.info().annotations.some((note) => note.type === 'Not automated'), '[Expected 1] Recorded as Not automated').toBe(true);
    });

    await step('Act: Step 2 — Call GET /api/v1/reconciliation-groups WITHOUT period', async () => {
      withoutPeriod = await reconApi.listGroups<ProblemDetail>({});
    });

    await step('Assert: Expected 2 — 400 · CMN-4000 (ProblemDetail); no list returned', async () => {
      expect.soft(withoutPeriod.status, '[Expected 2] HTTP 400').toBe(400);
      expect.soft(withoutPeriod.body.code, '[Expected 2] Error code CMN-4000').toBe('CMN-4000');
      expect(withoutPeriod.body, '[Expected 2] No list is returned').not.toHaveProperty('items');
    });

    await step('Act: Step 3 — Call GET /api/v1/reconciliation-groups?period=2026-09', async () => {
      withPeriod = await reconApi.listGroups<Paged<GroupSummary>>({ period: '2026-09' });
    });

    await step('Assert: Expected 3 — 200 · {items, paging} holding only the groups of 2026-09', async () => {
      expect.soft(withPeriod.status, '[Expected 3] HTTP 200').toBe(200);
      expect.soft(Array.isArray(withPeriod.body.items), '[Expected 3] The body carries items[]').toBe(true);
      expect.soft(withPeriod.body.paging, '[Expected 3] The body carries paging').toBeDefined();
      expect((withPeriod.body.items ?? []).filter((group) => groupPeriod(group) !== '2026-09'), '[Expected 3] Every group belongs to 2026-09').toEqual([]);
    });
  });

  test('TC_US020_076 — A request naming a group that does not exist is refused with LED-1101 and the list RELOADS', async ({ reconApi }) => {
    const step = makeApiStep(reconApi);
    await tcMeta('TC_US020_076', 'Medium', TAGS, `GET /api/v1/reconciliation-groups/999999 is refused with 404 LED-1101 and the message ${RR_TEXT.groupNotFound} Not automated: the "list reloads" part of the title — the TC has no screen step for it. ${DATA}`);
    let result = { status: 0, body: {} as ProblemDetail };

    await step('Arrange: Pre-condition 1 — An admin token able to call the US020 API; group 999999 does not exist', async () => {
      expect((await reconApi.counts('2026-09')).groupCount, 'The token reads the US020 API').toBeGreaterThanOrEqual(0);
    });

    await step('Act: Step 1 — Call GET /api/v1/reconciliation-groups/999999', async () => {
      result = await reconApi.getGroup<ProblemDetail>(999999);
    });

    await step(`Assert: Expected 1 — 404 · LED-1101 — ${RR_TEXT.groupNotFound}`, async () => {
      expect.soft(result.status, '[Expected 1] HTTP 404').toBe(404);
      expect.soft(result.body.code, '[Expected 1] Error code LED-1101').toBe('LED-1101');
      expect(result.body.detail ?? result.body.message, `[Expected 1] Message "${RR_TEXT.groupNotFound}"`).toBe(RR_TEXT.groupNotFound);
    });
  });
});
