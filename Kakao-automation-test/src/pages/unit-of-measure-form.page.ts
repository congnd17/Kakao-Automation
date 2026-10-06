import { Page, test, expect } from '@playwright/test';
import { BasePage } from './base.page';

export class UnitOfMeasureFormPage extends BasePage {
  readonly pageHeading = this.page.getByRole('heading', { level: 4 });
  readonly newUnitTitle = this.page.getByText('신규 단위', { exact: true });
  readonly unitDetailTitle = this.page.getByText('단위 상세', { exact: true });

  readonly codeInput = this.page.locator('#uom_code');
  readonly codeHint = this.page.getByText('영문자로 시작하는 대문자·숫자 2~3자', { exact: false });
  readonly codeLockedHint = this.page.getByText('단위 생성 후에는 변경할 수 없습니다.', { exact: true });
  readonly codeError = this.codeInput.locator('xpath=following-sibling::div[contains(@class,"invalid-feedback")]');
  readonly nameEnInput = this.page.locator('#uom_name_en');
  readonly nameEnError = this.nameEnInput.locator('xpath=following-sibling::div[contains(@class,"invalid-feedback")]');
  readonly nameKoInput = this.page.locator('#uom_name_ko');
  readonly nameKoError = this.nameKoInput.locator('xpath=following-sibling::div[contains(@class,"invalid-feedback")]');
  readonly descriptionInput = this.page.locator('#uom_description');

  readonly backToListButton = this.page.getByRole('button', { name: '목록으로' });
  readonly saveButton = this.page.getByRole('button', { name: '저장' });

  // Panel 상태 및 작업 — chỉ hiển thị ở màn sửa. Scope các nút thao tác trong panel này để không khớp
  // nhầm nút 비활성화/재활성화 lặp lại trên từng dòng ở màn danh sách khi cùng test module.
  readonly statusActionsPanel = this.page.getByText('상태 및 작업', { exact: true });
  private readonly statusActionsPanelContainer = this.statusActionsPanel.locator('xpath=../..');
  readonly statusValue = this.page.getByText('상태', { exact: true }).locator('xpath=..').getByText(/^(활성|비활성)$/);
  readonly usedByRecordsValue = this.page
    .getByText('사용 중인 건수', { exact: true })
    .locator('xpath=..')
    .locator('*')
    .last();
  readonly createdValue = this.page.getByText('생성일', { exact: true }).locator('xpath=..').locator('*').last();
  readonly historyButton = this.statusActionsPanelContainer.getByRole('button', { name: '변경 이력' });
  readonly deactivateOrReactivateButton = this.statusActionsPanelContainer.getByRole('button', { name: /비활성화|재활성화/ });
  readonly deleteButton = this.statusActionsPanelContainer.getByRole('button', { name: '삭제' });
  readonly deleteNote = this.page.getByText(/삭제할 수 있습니다|삭제할 수 없습니다/);

  // Modal — 이 단위를 비활성화할까요? / 다시 활성화할까요?
  readonly statusDialog = this.page.getByRole('dialog').filter({ hasText: '활성화할까요' });
  readonly statusDialogTitle = this.statusDialog.getByRole('heading');
  readonly statusDialogCancelButton = this.statusDialog.getByRole('button', { name: '취소' });
  readonly statusDialogConfirmButton = this.statusDialog.getByRole('button', { name: /비활성화|재활성화/ });

  // Modal — 이 단위를 삭제할까요? / 이 단위는 삭제할 수 없습니다
  readonly deleteDialog = this.page.getByRole('dialog').filter({ hasText: '삭제' });
  readonly deleteDialogConfirmButton = this.deleteDialog.getByRole('button', { name: '삭제' });
  readonly deleteDialogCancelButton = this.deleteDialog.getByRole('button', { name: '취소' });
  readonly deleteDialogCloseButton = this.deleteDialog.getByRole('button', { name: '닫기' });

  // Modal — 변경 이력
  readonly historyDialog = this.page.getByRole('dialog').filter({ hasText: '변경 이력' });
  readonly historyTable = this.historyDialog.locator('table');
  readonly historyRows = this.historyDialog.locator('tbody tr');
  readonly historyCloseButton = this.historyDialog.getByRole('button', { name: '닫기' });

  constructor(page: Page) {
    super(page);
  }

  async fillCode(code: string): Promise<void> {
    await this.type(this.codeInput, code, '코드 (Code) field');
  }

  async fillNameEn(name: string): Promise<void> {
    await this.type(this.nameEnInput, name, '이름 (영문) (Name EN) field');
  }

  async fillNameKo(name: string): Promise<void> {
    await this.type(this.nameKoInput, name, '이름 (한글) (Name KO) field');
  }

  async fillDescription(text: string): Promise<void> {
    await this.type(this.descriptionInput, text, '설명 (Description) field');
  }

  async fillUnitForm(data: { code?: string; nameEn?: string; nameKo?: string; description?: string }): Promise<void> {
    if (data.code !== undefined) await this.fillCode(data.code);
    if (data.nameEn !== undefined) await this.fillNameEn(data.nameEn);
    if (data.nameKo !== undefined) await this.fillNameKo(data.nameKo);
    if (data.description !== undefined) await this.fillDescription(data.description);
  }

  async save(): Promise<void> {
    await this.click(this.saveButton, '저장 (Save) button');
  }

  async backToList(): Promise<void> {
    await this.click(this.backToListButton, '목록으로 (Back to list) button');
  }

  async openHistory(): Promise<void> {
    await this.click(this.historyButton, '변경 이력 (Change history) button');
  }

  async closeHistory(): Promise<void> {
    await this.click(this.historyCloseButton, '닫기 button on the 변경 이력 dialog');
  }

  async askDeactivateOrReactivate(): Promise<void> {
    // Ngay sau lần đổi trạng thái trước, nút render tạm thời 2 bản trong lúc chuyển tiếp UI —
    // chờ ổn định về 1 bản trong panel chi tiết trước khi click để tránh strict-mode violation.
    await expect(this.deactivateOrReactivateButton).toHaveCount(1);
    await this.click(this.deactivateOrReactivateButton, '비활성화/재활성화 (Deactivate/Reactivate) button');
  }

  async confirmStatusChange(): Promise<void> {
    await this.click(this.statusDialogConfirmButton, 'confirm button on the status-change dialog');
  }

  async cancelStatusChange(): Promise<void> {
    await this.click(this.statusDialogCancelButton, '취소 button on the status-change dialog');
  }

  async askDelete(): Promise<void> {
    await this.click(this.deleteButton, '삭제 (Delete) button');
  }

  async confirmDelete(): Promise<void> {
    await this.click(this.deleteDialogConfirmButton, '삭제 confirm button on the delete dialog');
  }

  async cancelDelete(): Promise<void> {
    await this.click(this.deleteDialogCancelButton, '취소 button on the delete dialog');
  }

  async pressEscape(): Promise<void> {
    await test.step('Press the Esc key', async () => {
      await this.page.keyboard.press('Escape');
    });
  }

  async clickOutsideModal(): Promise<void> {
    await test.step('Click outside the dialog (backdrop)', async () => {
      await this.page.mouse.click(5, 5);
    });
  }
}
