import { WarehouseApi, WarehouseDetail, WarehouseWriteBody } from '@api/warehouse.api';

/**
 * Dữ liệu test US069 (창고 관리). Môi trường dev DÙNG CHUNG — mỗi test tự tạo warehouse riêng tên `auto_<TC>_<timestamp>`,
 * sửa / bật tắt / xoá chính nó và xoá hẳn ở teardown (WarehouseCleanup). KHÔNG đụng warehouse của người khác.
 * Xoá warehouse cha kéo theo 5 bucket (BR-8d, verify 28/09) — không để lại dòng mồ côi.
 * Mapping US071 do test tạo (trỏ vào warehouse automation) được xoá ở teardown TRƯỚC warehouse (mở rộng phạm vi 28/09).
 */

/** Biz partner dùng cho warehouse test — id lấy từ option value của select 거래처, verify 28/09. */
export const BIZ_PARTNER = { id: '3333', name: '카카오엔터테인먼트 테스트' };

/** Mapping US071 dựng cho TC tham chiếu ③ — owner PARTNER (mã từ GET /ownership-types, verify 28/09). */
export const MAPPING_PRODUCT_KEYWORD = 'STAR';
export const MAPPING_OWNERSHIP = 'PARTNER';

/** Hậu tố tên 5 bucket theo thứ tự list — `{tên cha} - {hậu tố}` (verify 28/09). */
export const BUCKET_SUFFIXES = ['매출대기', '이동중', '폐기', '이슈격리', '불량'] as const;
export const VIRTUAL_LOGISTICS_TYPES = ['PENDING_REVENUE', 'IN_TRANSIT', 'SCRAP', 'QUARANTINE', 'DEFECTIVE'] as const;
export const VIRTUAL_LABEL = 'System (virtual)';

/** Nhãn UI tiếng Hàn — nguồn: dictionary `warehouses.*` trong bundle frontend (28/09). */
export const WH_TEXT = {
  typeSupplier: '판매자 물류',
  typePlatform: '플랫폼 물류',
  channelNone: '연동 없음',
  channelEgFlex: 'CJ대한통운(EgFlex)',
  channelDt: 'CJ대한통운',
  categoryCj: 'CJ 창고',
  categoryCjDaegu: 'CJ 대구 창고',
  categoryPickup: '현장 수령지',
  categoryGeneral: '일반 창고',
  categoryStore: '매장 창고',
  statusActive: '활성',
  statusInactive: '비활성',
  none: '—',
  toastCreated: '창고가 등록되었습니다 — 즉시 적용됩니다.',
  toastSaved: '변경 사항이 저장되었습니다. 시스템 로그에 기록되었습니다.',
  toastDeactivated: (name: string) => `“${name}” 창고가 비활성화되었습니다.`,
  toastReactivated: (name: string) => `“${name}” 창고가 재활성화되었습니다.`,
  toastDeleted: (name: string) => `“${name}” 창고가 삭제되었습니다. 시스템 로그에 기록되었습니다.`,
  validBizPartner: '거래처를 선택하세요.',
  validName: '창고명을 입력하세요.',
  validType: '창고 유형을 선택하세요.',
  validLogisticsType: '물류 유형을 선택하세요.',
  validChannel: '물류사 유형을 선택하세요.',
  validCjWarehouseCode: '물류사 창고 코드를 입력하세요.',
  validCjChannelCode: '물류 채널 코드를 입력하세요.',
  validAddr: '주소를 입력하세요.',
  validZipCode: '우편번호를 입력하세요.',
  validNumber: '전화번호를 입력하세요.',
  validCallingCode: '국가번호를 입력하세요.',
  hintTypeSelect: '창고 유형을 선택하세요. 생성 후 변경할 수 없습니다.',
  hintTypeLock: '창고 유형은 등록 후 변경할 수 없습니다.',
  hintBizPartnerLock: '거래처는 등록 후 변경할 수 없습니다.',
  hintLogisticsTypeLock: '물류 유형은 등록 후 변경할 수 없습니다.',
  hintCategoryAuto: '창고 유형 + 물류 유형 + 3PL 연동에 따라 자동으로 계산됩니다. 직접 입력할 수 없습니다.',
  hintChannelFixed: '물류 유형에 따라 고정됩니다 — 이 유형의 창고는 3PL과 연동하지 않습니다.',
  hintChannelWms: '이 창고를 연동할 물류사를 선택하세요 — 연동이 구현된 업체만 목록에 나옵니다.',
  hintPhone: '국가번호와 전화번호는 각각 별도의 값으로 저장되며, 저장 시 하이픈은 제거됩니다.',
  hintLogisticsInfo: '목적지 창고와 배송 방법을 물류사 거래처 코드에 매핑합니다. 이후 출고에서 B2B 배송을 처리할 때만 사용됩니다.',
  saveNote: '저장 즉시 창고가 적용됩니다 — 별도의 승인 절차는 없습니다.',
  deactivateTitle: '창고를 비활성화할까요?',
  deactivateBody: (name: string) => `${name} 창고는 새 재고 이동을 받지 않습니다. 과거 데이터와 보고서는 그대로 유지됩니다.`,
  deactivateHint: '언제든지 창고를 다시 활성화할 수 있습니다.',
  deleteTitle: '창고를 삭제할까요?',
  deleteBody: (name: string) => `${name} 레코드는 참조하는 재고 기록이 없어 삭제할 수 있습니다. 이 작업은 되돌릴 수 없으며 시스템 로그에 기록됩니다.`,
  cascadeDeactivate: (n: number) => `이 창고에 속한 시스템 관리 창고 ${n}개도 함께 비활성화됩니다.`,
  cascadeDelete: (n: number) => `이 창고에 속한 시스템 관리 창고 ${n}개도 함께 삭제됩니다.`,
  systemNote:
    '시스템이 관리하는 가상 창고입니다(Pending revenue / In-transit / Scrap / Quarantine / Defective) — 실물 창고를 등록하면 대응하는 버킷이 함께 만들어집니다(BR-8a). 이 화면에서는 수정·비활성화·삭제할 수 없으며(AC 13), 상위 실물 창고를 비활성화·재활성화·삭제하면 이 창고도 함께 따라갑니다(BR-8d).',
  deleteBlocked: (causes: string) => `참조가 남아 있어 삭제할 수 없습니다 (${causes}). 창고 운영을 중단하려면 비활성화를 사용하세요 — 이력은 그대로 보존됩니다.`,
  causeMapping: (n: number) => `상품-창고 매핑 ${n}건`,
  conflictTitle: '저장 충돌',
  conflictMessage: '이 창고는 다른 사용자가 변경했습니다.',
  conflictFieldsTitle: '다른 사용자가 아래 항목을 변경했습니다.',
  conflictActionNoFields: '이 동작은 입력값을 보내지 않으므로 비교할 항목이 없습니다. 다른 사용자의 변경을 확인한 뒤 다시 시도하세요.',
  conflictAttribution: (name: string) => new RegExp(`^${name}님이 \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}에 변경했습니다\\.$`),
  historyTitle: '변경 이력',
  historyHeaders: ['변경 일시', '변경자', '항목', '변경 내용'],
  historyCreatedChip: '생성',
  historyEmptyTitle: '변경 이력이 없습니다',
  noResultsTitle: '필터 조건에 맞는 결과가 없습니다',
  noResultsHint: '필터를 초기화해 보세요.',
  invalidId: '요청 값이 올바르지 않습니다.',
  notFound: '창고를 찾을 수 없습니다.',
} as const;

/** Tên warehouse traceable: `auto_<tc>_<timestamp>` (+ nhãn tuỳ chọn). */
export function warehouseName(tcId: string, label = ''): string {
  const tc = tcId.replace(/^TC_US069_/, 'US069_');
  return `auto_${tc}_${Date.now()}${label ? `_${label}` : ''}`;
}

export type WarehouseKind = 'SUPPLIER' | 'PLATFORM_WMS_EGFLEX' | 'PLATFORM_GENERAL' | 'PLATFORM_PICKUP' | 'PLATFORM_STORE';

const LOGISTICS_BY_KIND: Record<WarehouseKind, Pick<WarehouseWriteBody, 'type' | 'logisticsType' | 'logisticsChannelType' | 'logisticsChannelWarehouseCode' | 'logisticsChannelCode'>> = {
  SUPPLIER: { type: 'SUPPLIER', logisticsType: null, logisticsChannelType: null, logisticsChannelWarehouseCode: null, logisticsChannelCode: null },
  PLATFORM_WMS_EGFLEX: { type: 'PLATFORM', logisticsType: 'WMS', logisticsChannelType: 'CJ_LOGISTICS', logisticsChannelWarehouseCode: 'A12', logisticsChannelCode: 'CH01' },
  PLATFORM_GENERAL: { type: 'PLATFORM', logisticsType: 'GENERAL', logisticsChannelType: 'NONE', logisticsChannelWarehouseCode: null, logisticsChannelCode: null },
  PLATFORM_PICKUP: { type: 'PLATFORM', logisticsType: 'PICKUP_LOCATION', logisticsChannelType: 'NONE', logisticsChannelWarehouseCode: null, logisticsChannelCode: null },
  PLATFORM_STORE: { type: 'PLATFORM', logisticsType: 'STORE', logisticsChannelType: 'NONE', logisticsChannelWarehouseCode: null, logisticsChannelCode: null },
};

export function buildWarehouseBody(kind: WarehouseKind, name: string, overrides: Partial<WarehouseWriteBody> = {}): WarehouseWriteBody {
  return {
    bizPartnerId: BIZ_PARTNER.id,
    name,
    country: 'KR',
    addr: 'Automation street 1',
    city: null,
    stateOrProvince: null,
    zipCode: '21500',
    detailAddr: null,
    callingCode: '+82',
    number: '0321234567',
    logisticsChannelInfo: null,
    ...LOGISTICS_BY_KIND[kind],
    ...overrides,
  };
}

/**
 * Theo dõi warehouse do test tạo và xoá hết ở teardown (fixture `warehouseCleanup`).
 * Warehouse tạo qua UI chưa biết id → `trackName()` trước khi bấm 저장; teardown tra id theo tên.
 */
export class WarehouseCleanup {
  private readonly ids = new Set<number>();
  private readonly names = new Set<string>();
  private readonly mappingIds = new Set<number>();

  constructor(private readonly api: WarehouseApi) {}

  track(id: number): void {
    this.ids.add(id);
  }

  trackName(name: string): void {
    this.names.add(name);
  }

  /** Tạo warehouse qua API và đăng ký dọn — trả về bản chi tiết mới nhất. */
  async create(kind: WarehouseKind, tcId: string, overrides: Partial<WarehouseWriteBody> = {}): Promise<WarehouseDetail> {
    const name = overrides.name ?? warehouseName(tcId);
    const created = await this.api.create(buildWarehouseBody(kind, name, overrides));
    if (created.status !== 201) {
      throw new Error(`Test data setup failed — POST /warehouses returned ${created.status}: ${JSON.stringify(created.body)}`);
    }
    this.track(created.body.id);
    return (await this.api.get(created.body.id)).body;
  }

  /**
   * Tạo 1 mapping sản phẩm–kho (US071) trỏ vào warehouse automation `warehouseId` và đăng ký dọn. Sản phẩm lấy lúc chạy
   * từ danh sách chọn được của màn mapping; owner PARTNER, không default (tránh WH-MAPPING_DEFAULT_ALREADY_SET).
   */
  async createMapping(warehouseId: number): Promise<number> {
    const [product] = await this.api.selectableProducts(MAPPING_PRODUCT_KEYWORD);
    if (!product) throw new Error(`Test data setup failed — no selectable product matches "${MAPPING_PRODUCT_KEYWORD}"`);
    const created = await this.api.createMapping({ productId: product.id, warehouseId, ownershipType: MAPPING_OWNERSHIP, isDefault: false });
    if (created.status >= 300) {
      throw new Error(`Test data setup failed — POST /product-warehouse-mappings returned ${created.status}: ${JSON.stringify(created.body)}`);
    }
    this.trackMapping(created.body.id);
    return created.body.id;
  }

  trackMapping(id: number): void {
    this.mappingIds.add(id);
  }

  async dispose(): Promise<void> {
    // Mapping phải gỡ trước: mapping ACTIVE chặn xoá warehouse (tham chiếu ③).
    for (const id of this.mappingIds) {
      const { status } = await this.api.removeMapping(id);
      if (status < 300 || status === 404) continue;
      await this.api.deactivateMapping(id);
      await this.api.removeMapping(id);
    }
    for (const name of this.names) {
      const rows = await this.api.listAll({ name });
      rows.filter((row) => !row.virtual && row.name.startsWith(name)).forEach((row) => this.ids.add(row.id));
    }
    for (const id of this.ids) {
      const { status } = await this.api.remove(id);
      if (status < 300 || status === 404) continue;
      // Phòng trường hợp backend chỉ cho xoá warehouse đang Active: bật lại rồi xoá.
      await this.api.reactivate(id, (await this.api.get(id)).body.version);
      await this.api.remove(id);
    }
  }
}
