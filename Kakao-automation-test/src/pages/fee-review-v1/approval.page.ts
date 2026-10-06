import { Locator, Page, expect } from '@playwright/test';
import { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';
import { FeeReviewListPage } from '@pages/fee-review.page';
import { FR_KO } from '@utils/fee-review.i18n';

/**
 * Locator bổ sung cho nhóm [Change Approval] / [Retirement] US079 v1 — dùng chung với `ChangeApprovalQueuePage` và
 * `FeeReviewListPage` (KHÔNG sửa 2 page object đó). Nguồn: recon `.playwright-mcp/v1-recon/12-queue-feerule-P03.yml`
 * (hàng đợi Fee Rule), `09-history-P05-rejected.yml` (lịch sử bị 반려), `02-basis-P02-hierarchy.yml` (근거).
 * Locator đánh dấu UNVERIFIED chưa có trên snapshot nào (dialog 반려 확정 không có trong recon, chưa có dòng 직접 입력).
 */
export class FeeRuleApprovalPage {
  /** Tiêu đề khối hàng đợi "승인 대기 목록" — recon 12. */
  readonly queueTitle: Locator;
  /** Option của dropdown 원장 — recon 12 (전체 · 환율 원장 · 쿠폰 분담 관리 · … · 수수료 규칙 · 결제수단 정책 …). */
  readonly registerOptions: Locator;
  /** UNVERIFIED — nhãn trường 반려 사유 (필수) trong dialog 반려 확정. */
  readonly rejectReasonLabel: Locator;
  /** UNVERIFIED — bộ đếm ký tự "n/200" của trường 반려 사유. */
  readonly rejectCounter: Locator;

  constructor(
    private readonly page: Page,
    private readonly queue: ChangeApprovalQueuePage,
  ) {
    this.queueTitle = page.getByText('승인 대기 목록', { exact: true });
    this.registerOptions = queue.registerFilterSelect.locator('option');
    this.rejectReasonLabel = queue.rejectDialog.getByText(/^반려 사유/).first();
    this.rejectCounter = queue.rejectDialog.getByText(/^\s*\d+\s*\/\s*200\s*$/);
  }

  /** Dòng hàng đợi chứa đoạn text (VD mã sản phẩm của TC). */
  item(text: string): Locator {
    return this.queue.queueItems.filter({ hasText: text });
  }

  /**
   * Lọc 원장 theo nhãn hiển thị mà KHÔNG đòi hàng đợi có dòng — register FX / Coupon có thể trống trên dev
   * (`ChangeApprovalQueuePage.showRegister` chờ dòng đầu tiên nên fail khi trống).
   */
  async selectRegister(label: string): Promise<void> {
    await this.queue.registerFilterSelect.selectOption({ label });
    await this.page.waitForLoadState('networkidle');
    await expect(this.queue.registerFilterSelect.locator('option:checked'), `원장 filter reads ${label}`).toHaveText(label);
  }

  /** Text của mọi dòng hàng đợi đang hiển thị — dòng bắt đầu bằng nhãn 원장 (recon 12: "수수료 규칙 신규 수동 승인 대기 …"). */
  async itemTexts(): Promise<string[]> {
    return (await this.queue.queueItems.allTextContents()).map((t) => t.trim());
  }

  /** Thông báo lỗi / toast theo nguyên văn (VD STL-1016 errCode.noOpenCycle). */
  message(text: string | RegExp): Locator {
    return this.page.getByText(text).last();
  }
}

/** Phần bổ sung cho màn 정산 수수료 확인·수정 — nhãn lấy từ i18n bundle (`FR_KO`). */
export class FeeReviewRowExtras {
  constructor(
    private readonly page: Page,
    private readonly list: FeeReviewListPage,
  ) {}

  /** UNVERIFIED — badge 직접 입력 (Hand-keyed) trong ô 산정 요율 (i18n `lbl.handKeyed`). */
  handKeyedBadge(row: Locator): Locator {
    return this.list.cell(row, 'rate').getByText(FR_KO['lbl.handKeyed'], { exact: true });
  }

  /** Khối "반려 사유 (account): lý do" trong ô 사유 của 1 dòng lịch sử — recon 09 (`strong` 반려 사유 + text). */
  historyRejectBlock(historyRow: Locator): Locator {
    return this.list.history.cell(historyRow, 'reason').locator('strong', { hasText: FR_KO['hist.rejectReason'] }).locator('xpath=..');
  }

  /** Nhãn nguồn cạnh số liệu lớn của 근거: 수정본 적용 hoặc 계약 행 — recon 02. */
  basisSource(key: 'trace.fromCorrection' | 'trace.fromContract'): Locator {
    return this.list.basis.root.getByText(FR_KO[key], { exact: true });
  }

  /** Khối "수정본이 적용 중입니다" (correction đang có hiệu lực) trong 근거. */
  get basisOverridePanel(): Locator {
    return this.list.basis.root.getByText(FR_KO['trace.overrideTitle']).locator('xpath=..');
  }

  /** Mã contract của dòng thắng (cặp 계약 → id đầu tiên trong thân 근거) — recon 02. */
  get basisContract(): Locator {
    return this.list.basis.value(this.list.basis.root.locator('.modal-body'), FR_KO['trace.kvContract']).first();
  }

  /** Phần tử nào trong phạm vi bị gạch ngang (text-decoration line-through) — dùng cho giá trị đề xuất bị 반려. */
  async hasStrikeThrough(scope: Locator): Promise<boolean> {
    return scope.evaluate((root) =>
      [root, ...Array.from(root.querySelectorAll('*'))].some((el) => getComputedStyle(el).textDecorationLine.includes('line-through')),
    );
  }

  /** Tooltip đang mở sau khi hover pill. */
  get tooltip(): Locator {
    return this.page.getByRole('tooltip');
  }
}
