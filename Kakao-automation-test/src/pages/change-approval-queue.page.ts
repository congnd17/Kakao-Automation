import { Page, Locator, test, expect } from '@playwright/test';
import { BasePage } from './base.page';

/** Tên nút có icon font đứng trước/sau — khớp đúng chữ (`승인` KHÔNG khớp dòng queue "… 승인 대기 — 기안자: …"). */
const buttonText = (text: string) => new RegExp(`^[^가-힣A-Za-z]*${text}[^가-힣A-Za-z]*$`);

/**
 * Màn 변경 승인 (Change Approval, US120) — `/commerce/change-approvals`. US080 nộp request vào hàng đợi chung này qua
 * 원장 "결제수단 정책". Locator verify trên UI thật 28/09.
 * ⚠️ Mở màn / đổi filter → panel phải TỰ chọn request đầu danh sách (thường là request của NGƯỜI KHÁC). Không có deep
 * link theo id. Luôn chọn request qua `openRequest()` — khớp đúng changeApprovalId (response chi tiết) và lý do.
 */
export class ChangeApprovalQueuePage extends BasePage {
  readonly registerFilterSelect = this.page.getByRole('combobox', { name: '원장' });
  readonly requesterFilterSelect = this.page.getByRole('combobox', { name: '기안자' });
  /** Mỗi dòng hàng đợi là 1 button tên "… — 기안자: {account} · {yyyy-MM-dd HH:mm}". */
  readonly queueItems = this.page.getByRole('button', { name: /기안자:/ });
  readonly pageSizeSelect = this.page.locator('select').filter({ has: this.page.locator('option[value="100"]') });

  readonly changeSummaryHeading = this.page.getByRole('heading', { name: '변경 요약', exact: true });
  readonly reasonHeading = this.page.getByRole('heading', { name: '사유 (기안자)', exact: true });
  readonly reasonBlock = this.reasonHeading.locator('xpath=following-sibling::div[1]');
  readonly changeContentHeading = this.page.getByRole('heading', { name: '변경 내용', exact: true });
  readonly impactPreviewHeading = this.page.getByRole('heading', { name: '영향 미리보기', exact: true });
  /** Cả khối 영향 미리보기 (영향 건수 + câu phạm vi quét nằm ở phần tử kế tiếp — verify 29/09). */
  readonly impactSection = this.impactPreviewHeading.locator('xpath=..');
  /** Tiêu đề Impact theo TC US079 v4 (`영향 범위`) — bundle dev 01/10 vẫn dùng `영향 미리보기` (impact.title). */
  readonly impactRangeHeading = this.page.getByRole('heading', { name: '영향 범위', exact: true });
  /** Khối Impact dù build đang dùng tiêu đề nào — để đọc nội dung impact mà không phụ thuộc tên tiêu đề. */
  readonly impactAnySection = this.impactRangeHeading.or(this.impactPreviewHeading).first().locator('xpath=..');
  readonly panelHeadings = this.page.getByRole('heading', { level: 3 }).or(this.page.getByRole('heading', { level: 4 }));

  readonly rejectButton = this.page.getByRole('button', { name: buttonText('반려…') });
  /** Nút 승인 của panel (ngay trước 반려…) — tránh nhầm với nút 승인 trong dialog xác nhận. */
  readonly approveButton = this.rejectButton.locator('xpath=preceding-sibling::button[1]');
  readonly selfApprovalMessage = this.page.getByText('본인이 제출한 변경은 승인할 수 없습니다.', { exact: true });

  readonly approveDialog = this.page.getByRole('dialog').filter({ hasText: '승인 확인' });
  readonly approveDialogConfirmButton = this.approveDialog.getByRole('button', { name: buttonText('승인') });
  readonly rejectDialog = this.page.getByRole('dialog').filter({ hasText: '반려 확정' });
  readonly rejectReasonInput = this.page.locator('#changeApprovalRejectReason');
  readonly rejectReasonError = this.rejectDialog.locator('.invalid-feedback');
  readonly rejectDialogConfirmButton = this.rejectDialog.getByRole('button', { name: buttonText('반려 확정') });

  /** Toast sau quyết định — app nối thêm nhãn bản ghi khi có: "승인되었습니다 — {record}" (bundle + run 30/09). */
  readonly approvedToast = this.page.getByText(/^승인되었습니다( — .+)?$/);
  readonly rejectedToast = this.page.getByText(/^반려되었습니다( — .+)?$/);

  constructor(page: Page) {
    super(page);
  }

  /** Giá trị của 1 dòng "{nhãn} {giá trị}" trong khối 변경 요약 / 변경 내용 (VD 원장, 기안자, 제안 값). */
  panelValue(label: string): Locator {
    return this.page.locator('span', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::span[1]');
  }

  async open(): Promise<void> {
    await this.goto('/commerce/change-approvals');
    await expect(this.queueItems.first(), 'Change approval queue must finish loading').toBeVisible({ timeout: 20_000 });
  }

  /**
   * Mở đúng request của test: lọc 원장, duyệt các dòng của `requester` từ mới nhất, click và chờ response chi tiết
   * `GET /change-approvals/{id}`; dừng ở dòng có id = `changeApprovalId` và khối 사유 = `reason`. Request vừa nộp đôi khi
   * chưa kịp vào hàng đợi → mở lại tối đa 3 lần.
   */
  /** Lọc 원장 (value như `FEE_RULE` hoặc nhãn như `결제수단 정책`) và đặt 100 dòng/trang — request mới nhất nằm cuối danh sách, trang 10 dòng mặc định thường không chứa nó. */
  async showRegister(register: string): Promise<void> {
    await this.registerFilterSelect.selectOption(register);
    await expect(this.queueItems.first(), 'Queue must list the register requests').toBeVisible();
    if (await this.pageSizeSelect.count()) await this.pageSizeSelect.selectOption('100');
    await this.page.waitForLoadState('networkidle');
  }

  async openRequest(options: { register: string; requester: string; changeApprovalId: number; reason: string }): Promise<void> {
    await test.step(`Open the ${options.register} request #${options.changeApprovalId} submitted by ${options.requester}`, async () => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.open();
        await this.showRegister(options.register);
        const candidates = this.queueItems.filter({ hasText: options.requester });
        for (let i = (await candidates.count()) - 1; i >= 0; i--) {
          const detail = this.page
            .waitForResponse((response) => response.url().includes(`/api/v1/change-approvals/${options.changeApprovalId}`), { timeout: 5_000 })
            .catch(() => null);
          await candidates.nth(i).click();
          const opened = await detail;
          // Panel phải hiện đúng lý do + người gửi (smart wait). Hàng đợi 1 dòng tự chọn sẵn dòng đó nên click không gọi lại
          // GET chi tiết (verify 29/09) → chấp nhận cả khi không bắt được response, miễn panel khớp lý do + người gửi.
          const reasonMatches = await expect(this.reasonBlock).toHaveText(options.reason, { timeout: 5_000 }).then(() => true, () => false);
          const requesterMatches = ((await this.panelValue('기안자').textContent()) ?? '').trim() === options.requester;
          if (reasonMatches && (opened || requesterMatches)) return;
        }
      }
      throw new Error(`Request #${options.changeApprovalId} (${options.reason}) was not found in the ${options.register} queue`);
    });
  }

  async approve(): Promise<void> {
    await this.click(this.approveButton, '승인 (Approve) button');
    await expect(this.approveDialog, '승인 확인 dialog must open').toBeVisible();
    await this.click(this.approveDialogConfirmButton, '승인 button on the 승인 확인 dialog');
  }

  async openRejectDialog(): Promise<void> {
    await this.click(this.rejectButton, '반려… (Reject) button');
    await expect(this.rejectDialog, '반려 확정 dialog must open').toBeVisible();
  }

  async confirmReject(reason?: string): Promise<void> {
    if (reason !== undefined) await this.type(this.rejectReasonInput, reason, '반려 사유 (Reject reason) field');
    await this.click(this.rejectDialogConfirmButton, '반려 확정 (Confirm reject) button');
  }
}
