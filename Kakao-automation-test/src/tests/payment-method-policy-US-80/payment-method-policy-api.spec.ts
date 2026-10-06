import { test, expect } from '@fixtures/api.fixture';
import { allure } from 'allure-playwright';
import { makeApiStep } from '@utils/step';
import {
  ApiError,
  ApiResult,
  ByKeyResponse,
  ChannelKey,
  PaymentMethodPolicy,
  PaymentMethodPolicyApi,
  formatKey,
} from '@api/payment-method-policy.api';
import {
  LIVE_ROW,
  METHOD_CODES,
  MSG_DUPLICATE_SUFFIX,
  SEED_ROW as READ_ONLY_ROW,
  pickUnusedKey,
  traceReason,
  withdrawPendingCreate,
} from '@utils/payment-method-policy.data';

/**
 * Gọi thẳng API register 결제수단 정책 (dev-settlement-admin-api.berriz.in) — không qua UI.
 * Nguồn TC: input/Test_Cases_US080_EN_v1.md — mỗi dòng Steps N / Expected N map đúng 1 step `Act: Step N` /
 * `Assert: Expected N` (reporting_rules.md mục 2). TC lệch thực tế → assert theo thực tế, ghi "Deviation" trong
 * description (quyết định của user 28/09).
 *
 * Dòng live: LIVE_ROW (automation sở hữu). ⚠️ Sai khác TC gốc (`NICEPAY · CREDIT_CARD · KRW`): dòng đó là dữ liệu
 * seed thật trên môi trường dev dùng chung — chỉ TC_075 ĐỌC nó.
 */
const MSG_IMMUTABLE_KEY =
  '정책 생성 후에는 결제 채널(PG·결제수단·통화)을 변경할 수 없습니다. 새 채널에 대한 정책을 새로 만드세요.';
const MSG_INVALID_LAG = '0 이상의 정수(일)를 입력하세요.';

type Attempt = { value: string; status: number; body: ApiError };

/** Mọi giá trị của dòng, theo tên trường — dùng để assert "every value unchanged" từng trường một. */
function rowValues(row: PaymentMethodPolicy): Record<string, unknown> {
  const { pending, ...fields } = row;
  return { ...fields, pendingChangeApprovalId: pending?.changeApprovalId };
}

function expectRefused(attempt: Attempt, expectedNo: number, message: string, code: string, label: string) {
  expect(attempt.status, `[Expected ${expectedNo}] ${label} "${attempt.value}" is refused with 4xx`).toBeGreaterThanOrEqual(400);
  expect(attempt.status, `[Expected ${expectedNo}] ${label} "${attempt.value}" is refused with 4xx`).toBeLessThan(500);
  expect(attempt.body.message, `[Expected ${expectedNo}] ${label} "${attempt.value}" returns the exact message`).toBe(message);
  expect(attempt.body.code, `[Expected ${expectedNo}] ${label} "${attempt.value}" returns code ${code}`).toBe(code);
}

test.describe('[API] Register 결제수단 정책 — call the endpoint directly', () => {
  test('TC_US080_076 — The catalogue read returns all nine codes, not the seven policy rows', async ({ paymentMethodPolicyApi }) => {
    const step = makeApiStep(paymentMethodPolicyApi);
    await allure.description(
      'Call GET /payment-method-policies/catalog — the catalogue is an independent source and must return all 9 ' +
        '결제수단 codes, not the codes inferred from the existing policy rows (BR-6.V1 ER2). ' +
        'Deviation from TC: pre-condition 2 ("register holds only 7 rows") no longer holds on the shared dev env — ' +
        'automation-created rows exist — so the register code coverage is recorded in Arrange, not asserted.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'api', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_076');

    let catalog: ApiResult<{ paymentMethodCodes: string[] }> = { status: 0, body: { paymentMethodCodes: [] } };
    let returnedCodes: string[] = [];

    await step('Arrange: Pre-condition 1–2 — Catalogue endpoint callable, record the codes covered by policy rows', async () => {
      const { body } = await paymentMethodPolicyApi.list({}, 1000);
      const registerCodes = [...new Set(body.content.map((row) => row.paymentMethodCode))].sort();
      await test.info().attach('Codes covered by policy rows', {
        body: JSON.stringify({ rows: body.totalElements, codes: registerCodes }, null, 2),
        contentType: 'application/json',
      });
    });

    await step('Act: Step 1 — Call the payment method catalogue read endpoint', async () => {
      catalog = await paymentMethodPolicyApi.getCatalog();
    });

    await step('Assert: Expected 1 — The endpoint returns a list of codes', async () => {
      expect(catalog.status, '[Expected 1] GET /catalog returns 200').toBe(200);
      expect(Array.isArray(catalog.body.paymentMethodCodes), '[Expected 1] paymentMethodCodes is a list').toBe(true);
      expect(catalog.body.paymentMethodCodes.length, '[Expected 1] The list is not empty').toBeGreaterThan(0);
    });

    await step('Act: Step 2 — Count and compare the codes returned', async () => {
      returnedCodes = catalog.body.paymentMethodCodes;
    });

    await step('Assert: Expected 2 — All 9 codes are returned, not the codes inferred from policy rows', async () => {
      for (const code of METHOD_CODES) {
        expect(returnedCodes, `[Expected 2] Catalogue contains ${code}`).toContain(code);
      }
      expect(returnedCodes, '[Expected 2] Catalogue returns exactly 9 codes').toHaveLength(9);
      expect(new Set(returnedCodes).size, '[Expected 2] Catalogue has no duplicate codes').toBe(returnedCodes.length);
    });
  });

  test('TC_US080_075 — The read endpoint exists for the consumer outside the settlement module', async ({ paymentMethodPolicyApi }) => {
    const step = makeApiStep(paymentMethodPolicyApi);
    await allure.description(
      'Call GET /payment-method-policies/by-key from a Node process (APIRequestContext — no browser, not ' +
        'in-process) like the US095 consumer in the Common module. A key with a row → {taken: true, holder} where ' +
        'holder is the entire policy of that key; an unused key → exactly {taken: false}, no holder.',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'api', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_075');

    let unusedKey: ChannelKey = READ_ONLY_ROW;
    let taken: ApiResult<ByKeyResponse> = { status: 0, body: { taken: false } };
    let holder: PaymentMethodPolicy | undefined;
    let free: ApiResult<ByKeyResponse> = { status: 0, body: { taken: true } };

    await step(`Arrange: Pre-condition 1–3 — Out-of-process HTTP client, seed key ${formatKey(READ_ONLY_ROW)}, an unused key`, async () => {
      unusedKey = await pickUnusedKey(paymentMethodPolicyApi);
    });

    await step(`Act: Step 1 — Call the read-by-key endpoint for ${formatKey(READ_ONLY_ROW)} from outside the settlement module`, async () => {
      taken = await paymentMethodPolicyApi.getByKey(READ_ONLY_ROW);
    });

    await step('Assert: Expected 1 — An HTTP endpoint reachable from outside the settlement module exists', async () => {
      expect(taken.status, '[Expected 1] GET /by-key over HTTP returns 200').toBe(200);
      expect(taken.body, '[Expected 1] The endpoint returns a JSON body').toEqual(expect.any(Object));
    });

    await step('Act: Step 2 — Read the response', async () => {
      holder = taken.body.holder;
    });

    await step('Assert: Expected 2 — Response is {taken: true, holder} with the entire policy of the key asked for', async () => {
      expect(Object.keys(taken.body).sort(), '[Expected 2] Response has exactly taken + holder, not standalone fields').toEqual([
        'holder',
        'taken',
      ]);
      expect(taken.body.taken, '[Expected 2] taken is true').toBe(true);
      expect(holder?.id, '[Expected 2] holder.id is present').toEqual(expect.any(Number));
      expect(holder?.pgCode, `[Expected 2] holder.pgCode is ${READ_ONLY_ROW.pgCode}`).toBe(READ_ONLY_ROW.pgCode);
      expect(holder?.paymentMethodCode, `[Expected 2] holder.paymentMethodCode is ${READ_ONLY_ROW.paymentMethodCode}`).toBe(
        READ_ONLY_ROW.paymentMethodCode,
      );
      expect(holder?.currency, `[Expected 2] holder.currency is ${READ_ONLY_ROW.currency}`).toBe(READ_ONLY_ROW.currency);
      expect(holder?.fxSourceStrategy, '[Expected 2] holder.fxSourceStrategy is present').toEqual(expect.any(String));
      expect(holder?.cycleType, '[Expected 2] holder.cycleType is present').toEqual(expect.any(String));
      expect(holder?.cycleLagDays, '[Expected 2] holder.cycleLagDays is present').toEqual(expect.any(Number));
      expect(holder?.approval, '[Expected 2] holder.approval is present').toEqual(expect.any(String));
      expect(holder?.version, '[Expected 2] holder.version is present').toEqual(expect.any(Number));
    });

    await step(`Act: Step 3 — Repeat step 1 with the unused key ${formatKey(unusedKey)}`, async () => {
      free = await paymentMethodPolicyApi.getByKey(unusedKey);
    });

    await step('Assert: Expected 3 — Response is exactly {taken: false}, with no holder', async () => {
      expect(free.status, '[Expected 3] GET /by-key with an unused key returns 200').toBe(200);
      expect(free.body.holder, '[Expected 3] Response has no holder').toBeUndefined();
      expect(free.body, `[Expected 3] Unused key ${formatKey(unusedKey)} returns exactly {taken: false}`).toEqual({ taken: false });
    });
  });

  test('TC_US080_070 — An update carrying a different channel key is rejected and the row is unchanged', async ({
    paymentMethodPolicyApi,
  }) => {
    const step = makeApiStep(paymentMethodPolicyApi);
    await allure.description(
      'Send PUT /payment-method-policies/{id} carrying a pgCode, then a paymentMethodCode, then a currency different ' +
        'from the stored value. Each is refused with 4xx, code PMP-1003 and the immutable-key message; the three key ' +
        'fields stay unchanged. API-only by design — the form renders the key as plain text. ' +
        `Deviation from TC: runs on ${formatKey(LIVE_ROW)} instead of ${formatKey(READ_ONLY_ROW)} (real data, not to be ` +
        'touched); code PMP-1003 is asserted as observed on the server (TC lists it only in Remark as [proposed]).',
    );
    await allure.severity('blocker');
    await allure.tags('regression', 'api', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_070');

    let before: PaymentMethodPolicy | undefined;
    let after: PaymentMethodPolicy | undefined;
    const attempts: Record<string, Attempt> = {};

    const sendKeyChange = async (field: keyof ChannelKey, value: string) => {
      const { status, body } = await paymentMethodPolicyApi.update<ApiError>(before!.id, {
        ...PaymentMethodPolicyApi.toUpdateBody(before!),
        [field]: value,
      });
      attempts[field] = { value: `${field}=${value}`, status, body };
    };

    await step(`Arrange: Pre-condition 1–2 — Row ${formatKey(LIVE_ROW)} is live with no pending request`, async () => {
      before = await paymentMethodPolicyApi.getEditableRow(LIVE_ROW);
      expect(before.pending, '[Pre-condition 2] Row has no pending approval request').toBeUndefined();
    });

    await step('Act: Step 1 — Send an update carrying a different pgCode', async () => {
      await sendKeyChange('pgCode', 'EXIMBAY');
    });

    await step('Assert: Expected 1 — Refused with 4xx and the immutable-key message', async () => {
      expectRefused(attempts.pgCode, 1, MSG_IMMUTABLE_KEY, 'PMP-1003', 'Update with');
    });

    await step('Act: Step 2 — Repeat with a different paymentMethodCode, then a different currency', async () => {
      await sendKeyChange('paymentMethodCode', 'CREDIT_CARD');
      await sendKeyChange('currency', 'USD');
    });

    await step('Assert: Expected 2 — Both remaining attempts are refused with the same message', async () => {
      expectRefused(attempts.paymentMethodCode, 2, MSG_IMMUTABLE_KEY, 'PMP-1003', 'Update with');
      expectRefused(attempts.currency, 2, MSG_IMMUTABLE_KEY, 'PMP-1003', 'Update with');
    });

    await step('Act: Step 3 — Read that row again', async () => {
      after = (await paymentMethodPolicyApi.get(before!.id)).body;
    });

    await step(`Assert: Expected 3 — The three key fields are unchanged at ${formatKey(LIVE_ROW)}`, async () => {
      expect(after?.pgCode, `[Expected 3] pgCode is unchanged at ${LIVE_ROW.pgCode}`).toBe(LIVE_ROW.pgCode);
      expect(after?.paymentMethodCode, `[Expected 3] paymentMethodCode is unchanged at ${LIVE_ROW.paymentMethodCode}`).toBe(
        LIVE_ROW.paymentMethodCode,
      );
      expect(after?.currency, `[Expected 3] currency is unchanged at ${LIVE_ROW.currency}`).toBe(LIVE_ROW.currency);
    });
  });

  test('TC_US080_071 — The server rejects a lag value outside 0–999', async ({ paymentMethodPolicyApi }) => {
    const step = makeApiStep(paymentMethodPolicyApi);
    await allure.description(
      "Send PUT with cycleLagDays = 1000, then -1, 3.5 and a text string — the form's maxlength=3 only blocks " +
        'typing, BR-5.V3 requires the server to check too. Each value is refused with 4xx, code PMP-1004 and the ' +
        "invalid-lag message; the row's cycleLagDays stays unchanged. " +
        `Deviation from TC: runs on ${formatKey(LIVE_ROW)} (automation-owned row); code PMP-1004 is asserted as ` +
        'observed on the server (TC lists it only in Remark as [proposed]).',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'api', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_071');

    let before: PaymentMethodPolicy | undefined;
    let after: PaymentMethodPolicy | undefined;
    const attempts: Attempt[] = [];

    const sendLag = async (value: string) => {
      const { status, body } = await paymentMethodPolicyApi.update<ApiError>(before!.id, {
        ...PaymentMethodPolicyApi.toUpdateBody(before!),
        cycleLagDays: value,
      });
      attempts.push({ value, status, body });
    };

    await step(`Arrange: Pre-condition 1–2 — Live policy row ${formatKey(LIVE_ROW)}`, async () => {
      before = await paymentMethodPolicyApi.getEditableRow(LIVE_ROW);
    });

    try {
      await step('Act: Step 1 — Send an update with cycleLagDays = 1000', async () => {
        await sendLag('1000');
      });

      await step('Assert: Expected 1 — Refused with 4xx and the invalid-lag message', async () => {
        expectRefused(attempts[0], 1, MSG_INVALID_LAG, 'PMP-1004', 'cycleLagDays');
      });

      await step('Act: Step 2 — Repeat with -1, then 3.5, then a text string', async () => {
        for (const value of ['-1', '3.5', 'abc']) {
          await sendLag(value);
        }
      });

      await step('Assert: Expected 2 — All three remaining values are refused with the same message', async () => {
        for (const attempt of attempts.slice(1)) {
          expectRefused(attempt, 2, MSG_INVALID_LAG, 'PMP-1004', 'cycleLagDays');
        }
      });

      await step('Act: Step 3 — Read that row again', async () => {
        after = (await paymentMethodPolicyApi.get(before!.id)).body;
      });

      await step("Assert: Expected 3 — The row's cycleLagDays is unchanged", async () => {
        expect(after?.cycleLagDays, `[Expected 3] cycleLagDays is unchanged at ${before!.cycleLagDays}`).toBe(before!.cycleLagDays);
      });
    } finally {
      // Môi trường dùng chung: nếu server lỡ nhận 1 giá trị sai, trả 지연일수 về như cũ (áp dụng ngay, không qua duyệt).
      if (attempts.some((attempt) => attempt.status < 300)) {
        const current = (await paymentMethodPolicyApi.get(before!.id)).body;
        await paymentMethodPolicyApi.update(current.id, {
          ...PaymentMethodPolicyApi.toUpdateBody(current),
          cycleLagDays: String(before!.cycleLagDays),
        });
      }
    }
  });

  test('TC_US080_052 — A write through the API is refused while a change awaits approval', async ({ paymentMethodPolicyApi }) => {
    const step = makeApiStep(paymentMethodPolicyApi);
    await allure.description(
      'A row with a pending 환율 적용 방식 (fx_source_strategy) change → send PUT for 지연일수 directly, bypassing the ' +
        'UI. The server answers 409 (code PMP-1005) and writes nothing — the server tier locks too, not only the UI ' +
        `(TC_US080_045). Deviation from TC: runs on ${formatKey(LIVE_ROW)} instead of ${formatKey(READ_ONLY_ROW)} (real ` +
        'data, not to be touched); code PMP-1005 is asserted as observed on the server (TC Remark: [proposed]).',
    );
    await allure.severity('normal');
    await allure.tags('regression', 'api', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_052');

    let pendingRow: PaymentMethodPolicy | undefined;
    let after: PaymentMethodPolicy | undefined;
    let attempt: ApiResult<ApiError & { version?: number }> = { status: 0, body: {} as ApiError };

    try {
      await step(`Arrange: Pre-condition 1–2 — Submit an 환율 적용 방식 change for approval on ${formatKey(LIVE_ROW)}`, async () => {
        const row = await paymentMethodPolicyApi.getEditableRow(LIVE_ROW);
        const otherStrategy = row.fxSourceStrategy === 'ALREADY_KRW' ? 'BANK_SETTLEMENT_RATE' : 'ALREADY_KRW';
        const submitted = await paymentMethodPolicyApi.update(row.id, {
          ...PaymentMethodPolicyApi.toUpdateBody(row),
          fxSourceStrategy: otherStrategy,
          changeReason: traceReason('TC_US080_052'),
        });
        expect(submitted.status, '[Pre-condition 2] Submitting the 환율 적용 방식 change for approval succeeds').toBeLessThan(300);
        pendingRow = (await paymentMethodPolicyApi.get(row.id)).body;
        expect(pendingRow.pending, '[Pre-condition 2] Row has a pending approval request').toBeDefined();
      });

      await step('Act: Step 1 — Send a 지연일수 update on that row directly, bypassing the UI', async () => {
        attempt = await paymentMethodPolicyApi.update<ApiError & { version?: number }>(pendingRow!.id, {
          ...PaymentMethodPolicyApi.toUpdateBody(pendingRow!),
          cycleLagDays: String((pendingRow!.cycleLagDays + 1) % 1000),
        });
      });

      await step('Assert: Expected 1 — The server answers 409 and writes nothing', async () => {
        expect(attempt.status, '[Expected 1] Server answers 409').toBe(409);
        expect(attempt.body.code, '[Expected 1] Server returns code PMP-1005 (locked by the pending approval)').toBe('PMP-1005');
        // Body lỗi Problem Details có sẵn `id` của dòng bị khoá — phân biệt với policy đã ghi bằng `message` + thiếu `version`.
        expect(attempt.body.message, '[Expected 1] Response is an error carrying a message').toEqual(expect.any(String));
        expect(attempt.body.version, '[Expected 1] Response is not a written policy (no version)').toBeUndefined();
      });

      await step('Act: Step 2 — Read that row again', async () => {
        after = (await paymentMethodPolicyApi.get(pendingRow!.id)).body;
      });

      await step('Assert: Expected 2 — Every value on the row is unchanged from before step 1', async () => {
        const expected = rowValues(pendingRow!);
        const actual = rowValues(after!);
        for (const [field, value] of Object.entries(expected)) {
          expect(actual[field], `[Expected 2] ${field} is unchanged`).toEqual(value);
        }
      });
    } finally {
      if (pendingRow?.pending) {
        await paymentMethodPolicyApi.withdraw(pendingRow.id);
      }
    }
  });

  test('TC_US080_037 — Two concurrent creates on the same key leave exactly one row', async ({ paymentMethodPolicyApi }) => {
    const step = makeApiStep(paymentMethodPolicyApi);
    await allure.description(
      'Send 2 POST /payment-method-policies requests almost simultaneously for the same unused key. Uniqueness is ' +
        'a DB constraint: one succeeds, the other is refused with 409 (code PMP-1001) and the duplicate message ' +
        'naming the key; the register holds exactly one row for the key. The test consumes one key of the automation ' +
        'pool permanently (no delete, BR-18) and withdraws the pending create afterwards. ' +
        'Deviation from TC: pre-condition 2 asks for two accounts — both requests are sent from the submitter account ' +
        '(the DB constraint does not depend on the caller).',
    );
    await allure.severity('blocker');
    await allure.tags('regression', 'api', 'concurrency', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_037');

    let key: ChannelKey = LIVE_ROW;
    let results: ApiResult<ApiError>[] = [];
    let rowsForKey = -1;

    try {
      await step('Arrange: Pre-condition 1–3 — Create endpoint callable, pick an unused key from the automation pool', async () => {
        key = await pickUnusedKey(paymentMethodPolicyApi);
      });

      await step('Act: Step 1 — Send two create requests for the same key almost simultaneously', async () => {
        const body = {
          ...key,
          fxSourceStrategy: 'ALREADY_KRW',
          cycleType: 'WEEKLY',
          cycleAnchorWeekday: 'WED',
          cycleLagDays: '5',
          changeReason: traceReason('TC_US080_037'),
        };
        results = await Promise.all([
          paymentMethodPolicyApi.create<ApiError>(body),
          paymentMethodPolicyApi.create<ApiError>(body),
        ]);
      });

      await step('Assert: Expected 1 — One request succeeds, the other is refused with 409 and the duplicate message', async () => {
        const accepted = results.filter((result) => result.status < 300);
        const refused = results.filter((result) => result.status === 409);
        expect(accepted, `[Expected 1] Exactly one request creating ${formatKey(key)} succeeds`).toHaveLength(1);
        expect(refused, '[Expected 1] The other request is refused with 409').toHaveLength(1);
        expect(refused[0]?.body.code, '[Expected 1] The refused request returns code PMP-1001').toBe('PMP-1001');
        expect(refused[0]?.body.message, `[Expected 1] Duplicate message is "${formatKey(key)} ${MSG_DUPLICATE_SUFFIX}"`).toBe(
          `${formatKey(key)} ${MSG_DUPLICATE_SUFFIX}`,
        );
      });

      await step('Act: Step 2 — Read the policy register for that key', async () => {
        rowsForKey = (await paymentMethodPolicyApi.list(key)).body.totalElements;
      });

      await step('Assert: Expected 2 — The register holds exactly one row for that key', async () => {
        expect(rowsForKey, `[Expected 2] Register has exactly one row for ${formatKey(key)}`).toBe(1);
      });
    } finally {
      // Register không có xoá (BR-18) — 회수 để dọn hàng đợi duyệt dùng chung; key vẫn bị chiếm vĩnh viễn.
      if (key !== LIVE_ROW) await withdrawPendingCreate(paymentMethodPolicyApi, key);
    }
  });

  test('TC_US080_072 — No delete endpoint exists on the register', async () => {
    await allure.description(
      'Not automated: the case sends a real DELETE to a live policy row. The dev environment is shared (confirmed ' +
        '25/09) — if the server had a bug the row would be lost for everyone. The TC is also marked BLOCKED in the ' +
        'source document.',
    );
    await allure.severity('critical');
    await allure.tags('api', 'blocked', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_072');
    test.skip(true, 'Shared dev environment — a real DELETE on a live row could destroy shared data; TC is BLOCKED in the source');
  });

  test('TC_US080_073 — A read call without SETTLEMENT_CONFIG returns 403', async () => {
    await allure.description(
      'Not automated: BLOCKED in the source document — the API contract states the SETTLEMENT_CONFIG guard is not ' +
        'implemented yet (every logged-in admin passes), and no account without the code is available.',
    );
    await allure.severity('critical');
    await allure.tags('api', 'blocked', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_073');
    test.skip(true, 'BLOCKED — SETTLEMENT_CONFIG guard not built yet (OQ-121); no account without the code');
  });

  test('TC_US080_074 — Create, update, submit and withdraw all require the writable flag', async () => {
    await allure.description(
      'Not automated: BLOCKED in the source document — the readonly-flag guard is not implemented in the current ' +
        'build, and no read-only token is available.',
    );
    await allure.severity('critical');
    await allure.tags('api', 'blocked', 'payment-method-policy');
    await allure.label('testId', 'TC_US080_074');
    test.skip(true, 'BLOCKED — readonly-flag guard not built yet (OQ-121); no read-only token');
  });
});
