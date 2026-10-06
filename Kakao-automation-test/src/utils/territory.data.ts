import type { Territory, TerritoryApi, VatTreatment } from '@api/territory.api';

/**
 * Dữ liệu test US089 (Territory). Dev DÙNG CHUNG và có người khác sửa cùng lúc (29/09). Từ 29/09 cả congnd17 và dungbd
 * đều có quyền ghi → TC sửa đúng mã quốc gia TC ghi (JP, AT, AE, TR, KR), khôi phục ở teardown (`TerritoryState`);
 * VN không bao giờ bị sửa. Tiền điều kiện "chưa sửa / chưa có lịch sử" → assert tương đối theo trạng thái đọc ở Arrange.
 */

/** Chuỗi UI — nguồn: DOM thật 29/09 (tiếng Hàn mặc định; tiếng Anh qua `?lang=en`). */
export const TERRITORY_TEXT = {
  ko: {
    columns: ['국가', '부가세 처리', '수출신고', '최종 수정', '작업'],
    searchPlaceholder: '국가 코드 또는 국가명',
    vatOptions: ['전체', '과세', '영세율'],
    exportOptions: ['전체', '필요', '불필요'],
    pageSizes: ['10개', '20개', '50개', '100개'],
    readOnly: '읽기 전용 역할입니다. 세금 설정은 시스템 관리자만 변경할 수 있습니다.',
    history: '변경 이력',
    historyColumns: ['일시', '변경자', '항목', '변경 내용', '사유'],
    historyEmptyTitle: '변경 이력이 없습니다',
    historyEmptyBody: '이 국가는 아직 시드 시점의 값을 그대로 유지하고 있습니다.',
    close: '닫기',
    noResults: '조건에 맞는 결과가 없습니다',
    seeded: '시드 기본값',
    taxable: '과세',
    zeroRated: '영세율',
    required: '필요',
    notRequired: '불필요',
    reasonEmpty: '사유를 입력하세요.',
    reasonShort: (n: number) => `사유는 최소 10자 이상이어야 합니다 — 현재 ${n}자.`,
    back: '목록으로',
    save: '저장',
    cardTitle: '세금 설정',
    identityNote: '국가 코드와 국가명은 ISO 3166-1 목록에서 가져오며 여기에서 변경할 수 없습니다.',
  },
  en: {
    columns: ['Country', 'VAT treatment', 'Export declaration', 'Last updated', 'Action'],
    searchPlaceholder: 'Code or name',
    vatOptions: ['All', 'Taxable (standard)', 'Zero-rated'],
    exportOptions: ['All', 'Required', 'Not required'],
    readOnly: 'Read-only for your role. Only a System Admin can change the tax settings.',
    history: 'Change history',
    historyColumns: ['When', 'Who', 'Setting', 'Change', 'Reason'],
    historyEmptyTitle: 'No changes yet',
    historyEmptyBody: 'This country still carries the values it was seeded with.',
    close: 'Close',
    noResults: 'No results match the filters',
    noResultsHint: 'Every ISO country has a row, so a country you expected is filtered out rather than missing. Clear the filters to see every seeded country.',
    seeded: 'Seeded default',
    cardTitle: 'Tax settings',
    identityNote: 'Country code and name come from the ISO 3166-1 list and cannot be changed here.',
    vatHint: 'Sales into this country are taxed at the standard rate, or zero-rated and still reported.',
    exportText: 'An export declaration number is required',
    reasonPlaceholder: 'Why is this changing? Kept in the change history.',
    reasonHint: 'At least 10 characters — stored with the change so anyone reading the history later knows why.',
    scopeNote: 'Applies to the open settlement cycle onward — amounts already settled are not repriced.',
    back: 'Back to list',
    save: 'Save',
  },
} as const;

/** Bộ đếm: "총 {n}개의 국가 중 {a}-{b}개 표시" (KO) — số hiển thị đọc lại bằng regex này. */
export const COUNTER_RE = /총\s*(\d+)개의\s*(?:국가|countries)\s*중\s*(\d+)-(\d+)개 표시/;

export function parseCounter(text: string): { total: number; from: number; to: number } | null {
  const m = COUNTER_RE.exec(text);
  return m ? { total: Number(m[1]), from: Number(m[2]), to: Number(m[3]) } : null;
}

export type TerritoryFlags = { vat: VatTreatment; exportRequired: boolean };

/** Giá trị "bình thường" theo quy tắc seed: chỉ KR là 과세 + 불필요, mọi nước khác 영세율 + 필요. */
export const NORMAL_FLAGS = (code: string): TerritoryFlags =>
  code === 'KR' ? { vat: 'TAXABLE_STANDARD', exportRequired: false } : { vat: 'ZERO_RATED', exportRequired: true };

/**
 * Trạng thái Territory của 1 test trên dev DÙNG CHUNG (có người khác sửa cùng lúc — verify 29/09).
 * `prepare` đưa quốc gia về đúng tiền điều kiện của TC qua API; `dispose` (teardown) đưa mọi quốc gia đã đụng tới về
 * cờ seed chuẩn (`NORMAL_FLAGS` — trạng thái của JP/AT/AE/TR/KR trước khi suite chạy, verify 29/09). Lịch sử append-only nên mỗi lần prepare/restore sinh thêm bản ghi — TC assert tương đối
 * theo trạng thái đọc ở Arrange (quyết định user 29/09).
 */
export class TerritoryState {
  /** Quốc gia test đã đụng tới — teardown đưa về cờ seed chuẩn (`NORMAL_FLAGS`). */
  private readonly touched = new Set<string>();

  constructor(private readonly api: TerritoryApi, private readonly testId: string) {}

  async current(code: string): Promise<Territory> {
    const { status, body } = await this.api.get(code);
    if (status !== 200) throw new Error(`GET territory ${code} returned ${status}`);
    return body;
  }

  /** Đưa `code` về `flags` (nếu đang khác) — trả về bản ghi sau khi chuẩn bị. */
  async prepare(code: string, flags: TerritoryFlags): Promise<Territory> {
    this.touched.add(code);
    const row = await this.current(code);
    if (row.vatTreatment === flags.vat && row.exportDeclarationRequired === flags.exportRequired) return row;
    const { status } = await this.api.update(code, {
      vatTreatment: flags.vat,
      exportDeclarationRequired: flags.exportRequired,
      reason: `Automation pre-condition for ${this.testId}`,
      version: row.version,
    });
    if (status >= 300) throw new Error(`Could not prepare ${code} for ${this.testId} (status ${status})`);
    return this.current(code);
  }

  /** Ghi nhận quốc gia mà test sẽ sửa (không đổi dữ liệu ở Arrange) để teardown khôi phục. */
  async track(code: string): Promise<Territory> {
    this.touched.add(code);
    return this.current(code);
  }

  /**
   * Teardown: đưa MỌI quốc gia đã đụng tới về cờ seed chuẩn (29/09: khôi phục về "giá trị lúc Arrange" làm lỗi lan dây
   * chuyền khi 1 teardown hỏng — test sau lấy trạng thái sai làm gốc). Mỗi quốc gia thử 3 lần; lỗi của 1 quốc gia không
   * chặn các quốc gia khác; cuối cùng vẫn còn lệch → throw để report hiện rõ dữ liệu chưa được khôi phục.
   */
  async dispose(): Promise<void> {
    const failed: string[] = [];
    for (const code of this.touched) {
      const flags = NORMAL_FLAGS(code);
      let restored = false;
      for (let attempt = 0; attempt < 3 && !restored; attempt++) {
        try {
          const row = await this.current(code);
          if (row.vatTreatment === flags.vat && row.exportDeclarationRequired === flags.exportRequired) {
            restored = true;
            break;
          }
          const { status } = await this.api.update(code, {
            vatTreatment: flags.vat,
            exportDeclarationRequired: flags.exportRequired,
            reason: `Automation restore after ${this.testId}`,
            version: row.version,
          });
          restored = status === 200;
        } catch {
          restored = false;
        }
      }
      if (!restored) failed.push(code);
    }
    if (failed.length) throw new Error(`Teardown could not restore ${failed.join(', ')} to the seeded flags after ${this.testId}`);
  }
}

/** Quốc gia TC dùng để sửa — không bao giờ chọn làm "quốc gia chưa từng sửa". */
const EDITED_BY_SUITE = ['JP', 'AT', 'AE', 'TR', 'KR'];

/**
 * Quốc gia "chưa từng sửa" cho TC cần seeded default: ưu tiên mã TC ghi (VN); nếu người khác đã sửa nó trên dev dùng chung
 * (29/09: yennt37 sửa VN) thì lấy quốc gia đầu tiên còn `seededDefault` — test ghi Deviation với mã thực dùng.
 */
export async function pickSeededCountry(api: TerritoryApi, preferred = 'VN'): Promise<Territory> {
  const first = (await api.get(preferred)).body;
  if (first.seededDefault) return first;
  const seeded = (await api.all()).find((t) => t.seededDefault && !EDITED_BY_SUITE.includes(t.countryCode));
  if (!seeded) throw new Error('No seeded-default country is left on the register');
  return seeded;
}

/** Thời điểm hiển thị theo giờ Seoul `YYYY-MM-DD HH:mm` của một timestamp UTC. */
export function toSeoulMinute(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString();
  return `${t.slice(0, 10)} ${t.slice(11, 16)}`;
}
