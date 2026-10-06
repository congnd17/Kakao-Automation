import { Locator, Page, expect, test } from '@playwright/test';
import type { FeeReviewListPage } from '@pages/fee-review.page';
import { FR_EN, FR_KO } from '@utils/fee-review.i18n';

/**
 * Bổ sung locator cho dialog 내보내기 (Export) của US079 v1 — nhóm [Export] (TC_US079_161–172).
 * Nguồn: recon `.playwright-mcp/v1-recon/11-export-list-dialog.yml` (dialog list) + `10-report-dialog.yml` (báo cáo kỳ).
 * Locator đánh dấu UNVERIFIED = chưa thấy trong snapshot recon (chỉ lấy chữ từ bundle i18n) — cần xác nhận ở lần chạy đầu.
 */
function esc(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const either = (key: keyof typeof FR_KO): RegExp => new RegExp(`^\\s*(${esc(FR_KO[key])}|${esc(FR_EN[key])})\\s*$`);

/** Dải URL export của BE: list (`products`) hoặc báo cáo kỳ (`corrections`). */
export const EXPORT_URL = /\/api\/v1\/fee-review\/cycles\/(\d+)\/(products|corrections)\/export(\?|$)/;

export class FeeReviewExportPage {
  /** Nhãn 파일 형식 (File format) — recon 11. */
  readonly formatLabel: Locator;
  /** Radio Excel — tên accessible = "Excel (.xlsx) <mô tả>" (recon 11, mặc định checked). */
  readonly xlsxRadio: Locator;
  /** Radio CSV — tên accessible = "CSV (.csv) <mô tả>" (recon 11). */
  readonly csvRadio: Locator;
  /** Ghi chú dưới radio khi chọn Excel (recon 11). */
  readonly xlsxNote: Locator;
  /** Ghi chú dưới radio khi chọn CSV — UNVERIFIED (recon chụp lúc Excel đang chọn; chữ lấy từ bundle). */
  readonly csvNote: Locator;
  /** Câu phạm vi của chế độ list ("지금 적용된 필터 기준입니다 — …") — recon 11. */
  readonly scopeListNote: Locator;
  /** Nút X góc dialog (button "Close") — recon 11. */
  readonly cornerClose: Locator;

  constructor(
    private readonly page: Page,
    private readonly list: FeeReviewListPage,
  ) {
    const root = list.exporter.root;
    this.formatLabel = root.getByText(either('export.formatLabel'));
    this.xlsxRadio = root.getByRole('radio', { name: /^Excel \(\.xlsx\)/ });
    this.csvRadio = root.getByRole('radio', { name: /^CSV \(\.csv\)/ });
    this.xlsxNote = root.getByText(either('export.xlsxNote'));
    this.csvNote = root.getByText(either('export.csvNote'));
    this.scopeListNote = list.exporter.scope.getByText(either('export.scopeList'));
    this.cornerClose = root.getByRole('button', { name: 'Close' });
  }

  /**
   * Tooltip của nút 목록 내보내기 — UNVERIFIED: recon không thấy tooltip/title của nút. Đọc thuộc tính `title`
   * (tooltip trình duyệt) hoặc tooltip react-bootstrap đang mở, cái nào có chữ.
   */
  async exportListTooltipText(): Promise<string> {
    const title = await this.list.exportButton.getAttribute('title');
    if (title) return title.trim();
    const tooltip = this.page.getByRole('tooltip');
    return (await tooltip.count()) ? ((await tooltip.first().textContent()) ?? '').trim() : '';
  }

  /** Badge 직접 입력 (Hand-keyed) trong ô rate của bảng chính — UNVERIFIED (recon 01 không có sản phẩm hand-keyed). */
  handKeyedBadge(rateCell: Locator): Locator {
    return rateCell.getByText(new RegExp(`${esc(FR_KO['lbl.handKeyed'])}|${esc(FR_EN['lbl.handKeyed'])}`));
  }

  /** Đóng dialog 내보내기 nếu còn mở (bằng 취소) — dialog có thể còn mở sau khi tải xong. */
  async closeIfOpen(): Promise<void> {
    if (await this.list.exporter.root.isVisible()) {
      await test.step('Close the Export dialog (취소)', () => this.list.exporter.cancelButton.click());
      await expect(this.list.exporter.root, 'The Export dialog closes').toHaveCount(0);
    }
  }
}
