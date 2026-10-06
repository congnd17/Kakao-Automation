# Kakao-automation-test

Web UI Automation Framework — **Playwright + TypeScript**, tuân thủ Page Object Model.

Hệ thống test: Berriz admin (dev) — `dev-settlement-admin.berriz.in`.

---

## Prerequisites

- Node.js >= 20
- npm >= 10

## Installation

```bash
cd Kakao-automation-test
npm install
npx playwright install --with-deps msedge   # bỏ qua nếu máy đã cài Microsoft Edge
cp .env.example .env   # điền BASE_URL / TEST_EMAIL / TEST_PASSWORD thật
```

Mặc định mọi test chạy trên **Microsoft Edge** (`channel: 'msedge'`). Cần chạy trên Chromium của Playwright thì đặt
`BROWSER=chromium` (trong `.env` hoặc trước lệnh: `$env:BROWSER='chromium'; npm test`) và cài `npx playwright install chromium`.

## Cách chạy test

```bash
npm run test:headed      # Chạy headed — bắt buộc khi debug lần đầu
npm run test:headless    # Chạy headless (giống CI)
npm run test:ui          # Playwright UI mode — debug trực quan
npm run test:debug       # Debug từng bước
npm run typecheck        # Kiểm tra TypeScript
```

## Giữ token Okta sống (keep-alive)

Refresh token Okta chỉ dùng được 1 lần (xoay vòng) và **chết nếu để lâu không dùng** (~1 giờ). `scripts/keep-tokens-alive.js`
refresh mọi account có refresh token trong `.env` (account gốc + `APPROVER_*`) và ghi token mới về đúng bộ key — dùng
chung khoá file với framework nên không bao giờ rotate đè lên lần chạy test.

```bash
npm run tokens:keep-alive         # refresh 1 lần ngay
npm run tokens:keep-alive:watch   # refresh ngay rồi lặp mỗi 50 phút (Ctrl+C để dừng)
```

Trên máy dev đã đăng ký Windows Task Scheduler `Kakao-automation-okta-keep-alive` chạy mỗi 50 phút (chỉ khi user đăng
nhập Windows). Log: `reports/logs/keep-tokens-alive.log`. Gỡ: `Unregister-ScheduledTask -TaskName Kakao-automation-okta-keep-alive`.
⚠️ Không gọi Okta token endpoint (Postman…) bằng cùng refresh token với `.env` — 2 bên rotate cùng chuỗi sẽ làm chết nhau.
Chuỗi đã chết (`invalid_grant`) không tự hồi sinh — phải lấy `refreshToken` mới từ `localStorage["okta-token-storage"]`.

## Xem report

```bash
npm run report:html                               # Mở HTML report của Playwright runner (lần chạy gần nhất)
npm run report:allure:list                        # Liệt kê mọi lần chạy đã lưu Allure report
npm run report:allure:open                        # Mở Allure report của lần chạy gần nhất
npm run report:allure:open -- 2026-09-28_14-05-12 # Mở Allure report của đúng lần chạy đó
```

Allure report **tự sinh sau mỗi lần chạy** và **không ghi đè** lần trước: mỗi lần chạy 1 thư mục đặt tên theo thời
điểm bắt đầu chạy (`YYYY-MM-DD_HH-mm-ss`). Report nối lịch sử lần trước — tab **Trend** cho thấy PASS/FAIL qua các lần
chạy; widget **Environment** và tab **Executors** ghi mã lần chạy, trình duyệt, Base URL. Report cũ không tự xoá — dọn
tay thư mục `<runId>/` không cần nữa.

Toàn bộ output nằm trong `reports/` (đã bị `.gitignore` chặn commit):

```
reports/
├── allure-results/                   # raw results của lần chạy hiện tại — input cho allure generate
├── allure-report/<runId>/            # Allure report nhiều file (npm run report:allure:open)
├── allure-report-single/<runId>/     # Allure report 1 file — mở thẳng index.html, tiện gửi
├── html/                # HTML report của Playwright runner
├── logs/                 # log thực thi (winston)
└── test-artifacts/      # trace khi test fail
```

## Project Structure

```
Kakao-automation-test/
├── playwright.config.ts      # Viewport 1920x1080, headed/headless theo env, reporter HTML+Allure
│                               # 3 projects: setup-auth / chromium / chromium-authenticated
├── src/
│   ├── pages/                 # Page Object Model
│   │   ├── base.page.ts       # Common methods + step API cho report
│   │   └── login.page.ts
│   ├── fixtures/
│   │   └── base.fixture.ts    # loginPage fixture + auto-attach screenshot cuối MỌI test
│   ├── setup/
│   │   ├── constants.ts       # Đường dẫn storageState dùng chung
│   │   └── auth.setup.ts      # Set cookie access_token từ AUTH_TOKEN, lưu storageState
│   ├── utils/
│   │   ├── env.config.ts      # Đọc .env
│   │   └── logger.ts          # Structured logging (winston) — ghi reports/logs/
│   └── tests/
│       └── authenticated/     # Test cần phiên đã đăng nhập sẵn — chạy ở project chromium-authenticated
└── .github/workflows/playwright.yml
```

## Test với phiên đăng nhập sẵn (bypass reCAPTCHA bằng token)

Trang `/login` có reCAPTCHA nên không automation trọn vẹn được luồng đăng nhập (xem mục Known Issues). Với các test cần vào thẳng khu vực sau đăng nhập, dùng token có sẵn thay vì đăng nhập qua UI:

1. Điền `AUTH_TOKEN` (token thật) vào `.env`.
2. Đặt test file trong `src/tests/authenticated/` — Playwright sẽ tự chạy project `chromium-authenticated`, phụ thuộc `setup-auth` (set cookie `access_token` từ `AUTH_TOKEN`, lưu vào `reports/.auth/storageState.json`), không cần gọi `loginPage.login()`.
3. Nếu `AUTH_TOKEN` để trống, `setup-auth` tự **skip** — không làm fail suite mặc định.

⚠️ Domain/attributes của cookie (`secure`, `sameSite`) trong `src/setup/auth.setup.ts` đang suy từ `BASE_URL`, **chưa verify trên DevTools thật**. Nếu test trong `authenticated/` vẫn bị redirect về `/login`, mở DevTools → Application → Cookies sau khi đăng nhập thật trên `dev-settlement-admin.berriz.in`, đối chiếu lại Domain/Secure/SameSite và cập nhật `auth.setup.ts` cho khớp.

## Conventions

| Thành phần | Quy tắc |
|---|---|
| Page class | PascalCase + hậu tố `Page` — `LoginPage.ts` |
| Test file | kebab-case + `.spec.ts` — `login.spec.ts` |
| Test title | Tiếng Việt, mô tả hành vi — không phải tên hàm |
| Locator | Khai báo trong Page class, KHÔNG inline trong test |
| Wait | Chỉ dùng auto-wait/`expect()` của Playwright — KHÔNG `waitForTimeout` |
| Test data | Sinh qua `TestDataGenerator` — unique + traceable |

## Known Issues / Limitations

- **Trang `/login` có reCAPTCHA ("Tôi không phải là người máy")** → không thể automation trọn vẹn luồng đăng nhập thành công vào Dashboard, vì việc bypass reCAPTCHA nằm ngoài phạm vi automation hợp lệ.
  Test `login.spec.ts` vì vậy chỉ verify: (1) form đăng nhập hiển thị đầy đủ, và (2) khi submit với thông tin hợp lệ nhưng chưa xác thực reCAPTCHA, hệ thống giữ nguyên tại trang đăng nhập (hành vi ổn định, tái lập được).
  Nếu môi trường test thật có cách tắt reCAPTCHA (feature flag/test mode), cập nhật lại `login.spec.ts` để test full happy-path đăng nhập → Dashboard.

## Việc cần làm trước khi chạy test

- [ ] Điền `.env` với `TEST_EMAIL` / `TEST_PASSWORD` thật (không hardcode trong code)
- [ ] Nếu thêm page/test mới có locator placeholder, đánh dấu `⚠️ PLACEHOLDER` và verify lại trên browser thật trước khi dùng — hiện tại **không có** locator placeholder, toàn bộ locator trong `login.page.ts` đã verify trên DOM thật của hệ thống test
