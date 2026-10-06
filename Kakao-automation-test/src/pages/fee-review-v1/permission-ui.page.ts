import { Locator, Page, expect } from '@playwright/test';
import { FR_EN, FR_KO, FrKey } from '@utils/fee-review.i18n';

/**
 * Locator bổ sung cho nhóm TC [Permission] / [UI] / [Responsive] của US079 v1 (spec `fee-review-permission-ui.spec.ts`).
 * Nguồn: snapshot recon `.playwright-mcp/v1-recon/*.yml` (01/10). Locator nào KHÔNG có trong snapshot được ghi `UNVERIFIED`.
 * Không thay thế page object dùng chung (`@pages/fee-review.page`, `@pages/change-approval-queue.page`) — chỉ thêm phần thiếu.
 */
function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Regex khớp đúng chuỗi KO hoặc EN của 1 khoá i18n. */
export function koEn(key: FrKey): RegExp {
  return new RegExp(`^\\s*(${esc(FR_KO[key])}|${esc(FR_EN[key])})\\s*$`);
}

/** Nút có icon font trước/sau tên (VD " 승인") — khớp đúng chữ. */
function buttonName(names: string[]): RegExp {
  return new RegExp(`^[^가-힣A-Za-z]*(${names.map(esc).join('|')})[^가-힣A-Za-z]*$`);
}

/** Khung app (header + sidebar) quanh mọi màn admin — recon 01-list-all.yml. */
export class AppShell {
  /** Dải header trên cùng (banner). */
  readonly banner: Locator;
  /** Sidebar trái (complementary). */
  readonly sidebar: Locator;
  /** Khối "로그인 만료: …" ở header. */
  readonly loginExpiry: Locator;
  /** Link điều hướng chính trên header (Common, Account, Community…) — heading level 5. */
  readonly topNavLinks: Locator;
  /**
   * UNVERIFIED: nút ☰ mở sidebar dạng drawer. Recon 1920px chỉ có link icon "anchor" đầu tiên của header — giả định đó là
   * nút toggle sidebar (không có snapshot ở ≤ 1279px).
   */
  readonly menuToggle: Locator;

  constructor(page: Page) {
    this.banner = page.getByRole('banner');
    this.sidebar = page.getByRole('complementary');
    this.loginExpiry = this.banner.getByText(/^(로그인 만료:|Login expires:)/);
    this.topNavLinks = this.banner.getByRole('heading', { level: 5 });
    this.menuToggle = this.banner.getByRole('link', { name: 'anchor' }).first();
  }

  /** Tên account ở header (heading level 6). */
  userBlock(displayName: string): Locator {
    return this.banner.getByRole('heading', { level: 6, name: displayName });
  }

  /** Mục menu trong sidebar theo tên (KO hoặc EN). */
  sidebarEntry(key: FrKey): Locator {
    return this.sidebar.getByRole('link', { name: koEn(key) });
  }
}

/** Phần bổ sung cho màn 정산 수수료 확인·수정 và các dialog của nó. */
export class FeeReviewUiExtras {
  /** UNVERIFIED: vùng cuộn ngang bao quanh bảng chính (cha trực tiếp của `<table>`, thường là `.table-responsive`). */
  readonly tableScroller: Locator;
  /** Ô "페이지당" (nhãn) của thanh phân trang chính. */
  readonly pageSizeLabel: Locator;
  /** Nhãn 파일 형식 trong dialog 내보내기. */
  readonly exportFormatLabel: Locator;
  /** Nhãn 파일명 trong dialog 내보내기. */
  readonly exportFileNameLabel: Locator;
  /** UNVERIFIED: thanh phân trang trong dialog 이번 기 수정 내역 (recon 1 trang chỉ có tổng số + 페이지당, không có `ul.pagination`). */
  readonly reportPagination: Locator;

  constructor(private readonly page: Page) {
    this.tableScroller = page.getByRole('table').first().locator('xpath=..');
    this.pageSizeLabel = page.getByText(/^(페이지당|Rows per page)$/).first();
    const exportDialog = page.getByRole('dialog').filter({ has: page.getByText(koEn('export.scopeTitle')) });
    this.exportFormatLabel = exportDialog.getByText(koEn('export.formatLabel'));
    this.exportFileNameLabel = exportDialog.getByText(koEn('export.fileName'));
    this.reportPagination = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: koEn('report.title') }) }).locator('ul.pagination');
  }

  /** Mọi nút trong ô 작업 của 1 dòng, theo thứ tự hiển thị. */
  actionButtons(actionsCell: Locator): Locator {
    return actionsCell.getByRole('button');
  }

  /** Nút quyết định 승인 / 반려… (Approve / Reject…) trong 1 phạm vi. */
  decisionButtons(scope: Locator): Locator {
    return scope.getByRole('button', { name: buttonName(['승인', '반려', '반려…', 'Approve', 'Reject', 'Reject…']) });
  }

  /** Nút gửi / rút duyệt (상신, 선택 일괄 상신, 회수 và bản EN) trong 1 phạm vi. */
  submitControls(scope: Locator): Locator {
    return scope.getByRole('button', { name: buttonName(['상신', '선택 일괄 상신', '회수', 'Submit', 'Submit selected', 'Withdraw']) });
  }

  /** Khung `.modal-content` của 1 dialog react-bootstrap. */
  modalContent(dialog: Locator): Locator {
    return dialog.locator('.modal-content');
  }

  modalBody(dialog: Locator): Locator {
    return dialog.locator('.modal-body');
  }

  modalFooter(dialog: Locator): Locator {
    return dialog.locator('.modal-footer');
  }

  /** Nút X ở góc tiêu đề dialog — recon: button "Close" trong header của mọi dialog. */
  dialogX(dialog: Locator): Locator {
    return dialog.getByRole('button', { name: 'Close', exact: true });
  }

  /** Nhãn 1 lựa chọn định dạng (Excel (.xlsx) / CSV (.csv)) cùng mô tả — recon 11-export-list-dialog.yml. */
  exportFormatOption(format: 'xlsx' | 'csv'): Locator {
    return this.page.getByRole('radio', { name: new RegExp(`^${format === 'xlsx' ? 'Excel \\(\\.xlsx\\)' : 'CSV \\(\\.csv\\)'}`) });
  }

  /** Câu ghi chú bên dưới lựa chọn định dạng (export.xlsxNote / export.csvNote). */
  exportNote(key: 'export.xlsxNote' | 'export.csvNote'): Locator {
    return this.page.getByRole('dialog').getByText(koEn(key));
  }

  /**
   * Chữ của tooltip khi rê chuột lên `target`: tooltip react-bootstrap (role tooltip) nếu có, ngược lại thuộc tính `title`
   * gần nhất (vỏ bọc nút disabled mang `title` — verify 29/09). UNVERIFIED cho nút 목록 내보내기 / 내보내기.
   */
  async tooltipText(target: Locator): Promise<string> {
    await target.hover();
    const tip = this.page.getByRole('tooltip').first();
    const fromTip = await tip.waitFor({ state: 'visible', timeout: 3_000 }).then(
      () => tip.innerText(),
      () => '',
    );
    if (fromTip.trim()) return fromTip.trim();
    return ((await target.evaluate((el) => el.closest('[title]')?.getAttribute('title') ?? '')) || '').trim();
  }
}

/** Phần bổ sung cho màn 변경 승인 (Change Approval) — recon 12-queue-feerule-P03.yml. */
export class ChangeApprovalExtras {
  readonly heading: Locator;
  readonly queueCaption: Locator;
  /** UNVERIFIED: banner chủ sở hữu màn "US120의 화면입니다" — không có trong recon 01/10. */
  readonly ownerBanner: Locator;
  /** Câu mô tả phạm vi impact ngay sau khối 영향 건수. */
  readonly impactCountLabel: Locator;
  readonly impactCountValue: Locator;
  /** UNVERIFIED: nhãn / bộ đếm / nút 취소 của dialog 반려 확정 (không có snapshot dialog). */
  readonly rejectDialog: Locator;
  readonly rejectCounter: Locator;
  readonly rejectCancelButton: Locator;

  constructor(page: Page) {
    this.heading = page.getByRole('heading', { level: 4, name: /^(변경 승인|Change Approval)$/ });
    this.queueCaption = page.getByText(/^(승인 대기 목록|Approval Queue)$/);
    this.ownerBanner = page.getByText(/US120의 화면입니다|This screen belongs to US120/);
    this.impactCountLabel = page.getByText(/^(영향 건수|Records affected)$/);
    this.impactCountValue = this.impactCountLabel.locator('xpath=following-sibling::*[1]');
    this.rejectDialog = page.getByRole('dialog').filter({ hasText: /반려 확정|Confirm reject/ });
    this.rejectCounter = this.rejectDialog.getByText(/^\s*\d+\s*\/\s*200\s*$/);
    this.rejectCancelButton = this.rejectDialog.getByRole('button', { name: buttonName(['취소', 'Cancel']) });
  }

  /** Dòng hàng đợi mang đúng target ref `<cycleId>/<productId>/<policy>`. */
  entry(queueItems: Locator, targetRef: string): Locator {
    return queueItems.filter({ hasText: targetRef });
  }

  async closeRejectDialog(): Promise<void> {
    await this.rejectCancelButton.click();
    await expect(this.rejectDialog, 'The reject dialog closes').toHaveCount(0);
  }
}
