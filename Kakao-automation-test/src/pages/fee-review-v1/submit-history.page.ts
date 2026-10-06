import { Locator, Page } from '@playwright/test';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import type { ChangeApprovalQueuePage } from '@pages/change-approval-queue.page';

/**
 * Locator bổ sung cho nhóm US079 v1 [Submit & Withdraw] / [History] / [Change Report] — đứng trên các page object có sẵn
 * (`FeeReviewListPage`, `ChangeApprovalQueuePage`), KHÔNG lặp lại locator đã có ở đó.
 * Nguồn: snapshot recon `.playwright-mcp/v1-recon/09-history-P05-rejected.yml`, `10-report-dialog.yml`, `12-queue-feerule-P03.yml`.
 * Locator đánh dấu UNVERIFIED: recon chưa có trạng thái tương ứng (spinner khi đang gửi, phân trang báo cáo > 10 dòng,
 * nút × của dialog 회수, kiểu gạch ngang giá trị không áp dụng) — kiểm lại ở lần chạy đầu.
 */
export class SubmitHistoryView {
  /** UNVERIFIED — spinner trong nút 선택 일괄 상신 khi request đang chạy (react-bootstrap Spinner). */
  readonly submitSpinner: Locator;
  /** UNVERIFIED — nút × ở header dialog 승인 요청 회수 (react-bootstrap closeButton, aria-label "Close" như dialog 이력 / 수정). */
  readonly withdrawCornerClose: Locator;
  /** UNVERIFIED — thanh điều hướng trang của dialog 이번 기 수정 내역 (recon 2 dòng không hiện thanh này). */
  readonly reportPagination: Locator;

  constructor(
    private readonly page: Page,
    private readonly list: FeeReviewListPage,
  ) {
    this.submitSpinner = this.list.submitButton.locator('.spinner-border, .spinner-grow, [role="status"]');
    this.withdrawCornerClose = this.list.withdraw.root.getByRole('button', { name: 'Close' });
    this.reportPagination = this.list.report.root.locator('ul.pagination');
  }

  /** Từng dòng con của ô 항목 (tên trường) hoặc 변경 내용 (trước → sau, dòng trạng thái) của 1 entry lịch sử — recon 09. */
  historyLines(row: Locator, column: 'setting' | 'change'): Locator {
    return this.list.history.cell(row, column).locator(':scope > *');
  }

  /** Khối 반려 사유 trong ô 사유: `<strong>반려 사유</strong>(approver): …` — recon 09. */
  historyRejectBlock(row: Locator): Locator {
    return this.list.history.cell(row, 'reason').locator('div').filter({ has: this.page.locator('strong', { hasText: /^(반려 사유|Reject reason)$/ }) });
  }

  /** UNVERIFIED — phần giá trị bị gạch ngang (giá trị đích không được áp dụng) trong 1 ô; class lấy từ code v4. */
  struck(cell: Locator): Locator {
    return cell.locator('.text-decoration-line-through, del, s');
  }

  /** Dòng của sản phẩm trong dialog 이번 기 수정 내역 — ô đầu là 상품ID (recon 10). */
  reportRow(productId: string): Locator {
    return this.list.report.rows.filter({ has: this.page.getByRole('cell', { name: productId, exact: true }) });
  }

  /** UNVERIFIED — nút trang (số trang / First / Last) của dialog 이번 기 수정 내역. */
  reportPageButton(name: string | RegExp): Locator {
    return this.reportPagination.getByRole('button', { name, exact: typeof name === 'string' });
  }

  /** Bản ghi của hàng đợi 변경 승인 theo target ref `{cycleId}/{productId}/{policy}` — recon 12. */
  queueRecord(queue: ChangeApprovalQueuePage, targetRef: string): Locator {
    return queue.queueItems.filter({ hasText: targetRef });
  }
}
