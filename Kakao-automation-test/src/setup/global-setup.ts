import * as fs from 'fs';
import { ALLURE_RESULTS_DIR } from './constants';

/**
 * Xoá raw results của các lần chạy trước — allure-playwright chỉ ghi thêm, không tự dọn, nên không có bước này
 * thì `allure generate` gộp lịch sử mọi lần chạy vào 1 report. Chạy 1 lần trước toàn bộ suite.
 */
export default function globalSetup(): void {
  fs.rmSync(ALLURE_RESULTS_DIR, { recursive: true, force: true });
}
