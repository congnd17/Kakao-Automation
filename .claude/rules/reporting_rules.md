# Quy Tắc Report (Allure & tương đương)

> Áp dụng cho **mọi** script automation sinh ra, bất kể framework (Playwright, Selenium, Appium) hay ngôn ngữ.
>
> **Nguyên tắc gốc:** Report phải đọc hiểu được bởi người **không xem code** — QA lead, BA, PM. Nhìn vào Test Body là biết test đã làm gì, ở bước nào, kết quả ra sao.

---

## 1. Metadata Bắt Buộc Cho Mỗi Test

Mỗi test case **PHẢI** khai báo đủ 5 mục sau. Thiếu bất kỳ mục nào = chưa đạt Definition of Done.

| Mục | Nội dung | Ví dụ |
|---|---|---|
| **Tên test (title)** | Mô tả hành vi bằng **Tiếng Anh**, không phải tên hàm | `Log in successfully with a valid admin account` |
| **Description** | 1–2 câu **Tiếng Anh**: test kiểm tra gì, điều kiện gì, kỳ vọng gì | `Verify that a user logging in with a valid email and password lands on the Dashboard and sees the navigation menu.` |
| **Severity** | `blocker` / `critical` / `normal` / `minor` / `trivial` | `blocker` cho luồng login |
| **Tags / Labels** | Nhóm chạy: `smoke`, `regression`, tên module | `smoke`, `login` |
| **TC ID** | Mã manual test case để truy vết ngược | `CRM_LOGIN_TC_001` |

**KHÔNG** để tên test hiển thị trong report là tên hàm kiểu `test_login_with_valid_credentials` — đó là tên code, không phải tên test case.

**TC ID** gắn qua label riêng (không nhét vào title) để truy vết ngược về manual test case.

---

## 2. Test Body — Mô Tả Từng Bước

Toàn bộ thân test **PHẢI** được bọc trong các **step có tên mô tả bằng Tiếng Anh**.

> **Ngôn ngữ report = Tiếng Anh** cho mọi nội dung test ghi vào report: tên test, Description, tên step, message
> assertion, lý do skip, message lỗi `throw`, mô tả element trong sub-step POM, tên attachment. Chuỗi UI của
> hệ thống được test (VD tiếng Hàn `저장`) giữ **nguyên văn** — có thể thêm gloss tiếng Anh: `저장 (Save) button`.
> Comment trong code và giao tiếp với user vẫn theo CLAUDE.md mục 1.

### Cấu trúc chuẩn — bám theo Arrange / Act / Assert

```
▼ Test body
  ▸ Arrange: Open the Login page
  ▸ Act: Log in with the admin account
  ▸ Assert: The system redirects to the Dashboard
  ▸ final_state  (ảnh)
```

### Quy tắc đặt tên step

| ✅ Đúng | ❌ Sai |
|---|---|
| `Act: Log in with the admin account` | `login()` |
| `Assert: The system redirects to the Dashboard` | `check url` |
| `Arrange: Open the Login page` | `step 1` |

- Bắt đầu bằng tiền tố `Arrange:` / `Act:` / `Assert:` để người đọc biết đang ở giai đoạn nào
- Tên step mô tả **hành vi nghiệp vụ**, không mô tả thao tác DOM
- Step con (sub-step) sinh tự động từ method của Page Object — đánh dấu method POM bằng step API tương ứng

### Không được để test body rỗng step

Test mà Test Body chỉ hiện 1 dòng phẳng = **fail review**. Tối thiểu phải có 3 step Arrange / Act / Assert.

### Mapping 1-1 với gạch đầu dòng của manual TC (BẮT BUỘC khi có TC nguồn)

Khi script sinh từ manual TC, Test Body phải **soi gương** đúng các gạch đầu dòng đánh số của TC để người đọc
report đặt cạnh TC là trace được từng dòng — pass/fail tới **đúng bullet nào**.

| Cột trong manual TC | Step trong report | Tên step |
|---|---|---|
| **Pre-condition** 1..n | `Arrange` — 1 step cho mỗi pre-condition cần thao tác; pre-condition do fixture lo (login, seed) gộp 1 step ghi rõ số | `Arrange: Pre-condition 1–2 — Logged in as ADMIN, 7 seed rows present` |
| **Steps** — dòng `N` | `Act` — đúng 1 step cho dòng N | `Act: Step N — <nội dung dòng N>` |
| **Expected Results** — dòng `N` | `Assert` — đúng 1 step cho dòng N, đặt **ngay sau** `Act: Step N` | `Assert: Expected N — <nội dung dòng N>` |

```
▼ Test body                                   (TC_US080_077)
  ▸ Arrange: Pre-condition 1–3 — Logged in as ADMIN, seed rows present, zoom 100%
  ▸ Act: Step 1 — Open the 결제수단 정책 screen at 1920×1080
  ▸ Assert: Expected 1 — All columns, 3 filters, 검색/초기화/정책 추가 and the pager visible; no horizontal scrollbar
  ▸ Act: Step 2 — Resize the window to 1366×768
  ▸ Assert: Expected 2 — Everything still present, nothing overlaps or is cut off
  ▸ final_state  (ảnh)
```

**Quy tắc:**
- **Số lượng khớp tuyệt đối với TC đầu vào:** số step `Act` top-level = số dòng Steps; số step `Assert` top-level = số dòng Expected Results. Số `N` trong tên step **trùng** số dòng trong TC — không đánh lại, không gộp, không tách, **không thêm step top-level nào ngoài TC** (cleanup, điều hướng phụ, đóng dialog… → đặt làm sub-step bên trong `Act: Step N` hoặc ở teardown).
- **CẤM** step gộp `Act & Assert: ...` — tách thành 2 step để fail chỉ rõ là thao tác hỏng hay kỳ vọng sai.
- Assertion trong `Assert: Expected N` chỉ kiểm những gì **dòng N** mô tả — không kéo assertion của dòng khác vào — và phải phủ **mọi ý** của dòng N (xem [`automation_rules.md`](automation_rules.md) mục 6.1). Nếu dòng Steps N không có Expected tương ứng, vẫn giữ `Act: Step N`, không bịa thêm Assert.
- Một dòng Expected có nhiều ý → nhiều `expect` trong cùng step, **message** mỗi `expect` có tiền tố `[Expected N]` để lỗi chỉ đúng ý bị fail: `expect(locator, '[Expected 1] 검색 (Search) button is visible').toBeVisible()`.
- Ý nào của dòng Expected **không tự động hoá được** (VD tooltip, cảm quan layout) → vẫn giữ step, ghi lại trong code comment + `allure.description` phần *Not automated*, **không** lặng lẽ bỏ qua.
- Một dòng TC bao nhiều màn hình/dialog không cùng hiển thị được (VD "open the create form, then the edit form")
  → **KHÔNG** tách thành nhiều cặp step. Dùng mẫu **ghi nhận trong Act → assert trong Assert**:
  `Act: Step N` thực hiện toàn bộ thao tác của dòng N và, tại mỗi màn hình, **ghi nhận** kết quả đo từng ý
  (hiển thị, bị cắt, tràn, trong viewport…) + chụp ảnh màn hình đó; `Assert: Expected N` assert **từng** kết quả
  đã ghi nhận (soft assert để liệt kê đủ mọi ý fail). Playwright TS: `src/utils/observations.ts` (`Observations`).
  Dòng chỉ có 1 màn hình → assert trực tiếp bằng web-first assertion như bình thường.
- Lặp theo dữ liệu (viewport, zoom…) chỉ được dùng khi TC cũng lặp — tên step vẫn phải mang số dòng TC: `Act: Step 2 — Resize to ${w}×${h}`.
- Script không có TC nguồn (sinh từ UI flow) → dùng quy tắc đặt tên step ở trên, không bắt buộc đánh số.

---

## 3. Screenshot — Đính Kèm Sau MỖI Step Arrange/Act/Assert, Cộng Ảnh Cuối Test

**Bắt buộc** đính kèm ảnh chụp màn hình ngay sau khi mỗi step Arrange/Act/Assert chạy xong, **cộng thêm**
1 ảnh trạng thái cuối cùng ở teardown — **không phân biệt PASS hay FAIL**.

| Thời điểm | Ảnh đính kèm | Tên attachment |
|---|---|---|
| Sau mỗi step Arrange/Act/Assert | Trạng thái màn hình ngay sau step đó | Tên step (VD: `Assert: The system redirects to the Dashboard`) |
| Cuối test — **PASSED** | Ảnh trạng thái cuối cùng — bằng chứng test đã chạy thật | `final_state` |
| Cuối test — **FAILED** | Ảnh tại thời điểm fail | `state_at_failure` |

Lý do bắt buộc cả khi PASS: report có ảnh mới chứng minh được test **thực sự chạy trên UI** chứ không phải pass giả do assertion yếu. Ảnh theo từng step giúp người không xem code lần theo đúng tiến trình mà không cần mở trace.

**Quy tắc:**
- Ảnh cuối test chụp trong teardown (`afterEach` / `@AfterMethod` / fixture finalizer) như trước.
- Ảnh theo step chụp **ngay khi step đó vừa xong**, qua một wrapper dùng chung cho toàn bộ step Arrange/Act/Assert
  ở tầng test — **không** đặt trong `BasePage.click()`/`type()` (sub-step thao tác DOM), để tránh phình report
  với ảnh từng cú click nhỏ lẻ.
  - Playwright TS: `src/utils/step.ts` (`makeStep(page)`), dùng thay cho `test.step()` trực tiếp trong file test.
- Tên attachment ảnh cuối giữ **cố định** để so sánh giữa các lần chạy; tên ảnh theo step lấy đúng tên step.
- Ảnh full-page nếu nội dung cần kiểm tra nằm ngoài viewport.

---

## 4. CẤM Đính Kèm stdout / stderr

Report **KHÔNG** được chứa attachment `stdout`, `stderr`.

| Framework | Cách tắt |
|---|---|
| **pytest + allure-pytest** | Thêm `--allure-no-capture` vào `addopts` trong `pyproject.toml` / `pytest.ini` |
| **Playwright TS** | Không attach mặc định — chỉ cần **không** dùng `console.log` trong test |
| **TestNG + allure-testng** | Không attach mặc định — chỉ cần **không** dùng `System.out.println` |

> ⚠️ `--allure-no-capture` tắt luôn cả attachment `log`. Nếu vẫn cần log nghiệp vụ, attach thủ công một khối log đã chọn lọc — **không** đổ toàn bộ output thô vào report.

Ghi log dùng **logger framework** (Log4j / logging / winston), không dùng `print` / `console.log` — đây cũng là anti-pattern đã cấm ở `automation_rules.md`.

---

## 5. Bảng API Theo Framework

| Mục | Playwright + TS | Pytest (Python) | TestNG (Java) |
|---|---|---|---|
| Tên test | `allure.displayName()` | `@allure.title(...)` | `@Description` + `ITestListener` |
| Description | `allure.description()` | `@allure.description(...)` | `@Description(...)` |
| Severity | `allure.severity()` | `@allure.severity(...)` | `@Severity(SeverityLevel.X)` |
| Tag / Label | `allure.tags()` | `@allure.tag(...)` | `@Story` / `@Feature` |
| TC ID | `allure.label('testId', ...)` | `@allure.label('testId', ...)` | `Allure.label("testId", ...)` |
| Step | `test.step('...', async () => {})` | `with allure.step('...')` | `@Step("...")` / `Allure.step(...)` |
| Attach ảnh | `testInfo.attach(name, {body, contentType})` | `allure.attach(png, name, PNG)` | `Allure.addAttachment(name, stream)` |

Cấu hình reporting cho từng stack xem thêm tại [`.claude/skills/skills-framework-architect/SKILL.md`](../skills/skills-framework-architect/SKILL.md) mục **Framework Components → 8. Reporting**.

---

## 6. Thư Mục Output — Gom Hết Vào `reports/`

**Toàn bộ** sản phẩm sinh ra khi chạy test PHẢI nằm trong **một thư mục `reports/` duy nhất** ở gốc project. **CẤM** rải file report ra root.

```text
project-root/
└── reports/                      # ← Toàn bộ output nằm trong đây
    ├── allure-results/           # Raw results (JSON) — input cho allure generate
    ├── allure-report/            # HTML report nhiều file (mở bằng allure open)
    ├── allure-report-single/     # Report gộp 1 file — tiện gửi qua chat/email
    ├── html/                     # HTML report của runner (pytest-html / Playwright HTML)
    ├── logs/                     # Log file thực thi
    └── screenshots/              # Ảnh chụp lưu ra đĩa
```

Thư mục con khác (video, trace…) **được phép thêm**, miễn nằm trong `reports/`.

### Cấu hình theo stack

| Stack | Nơi khai báo | Giá trị |
|---|---|---|
| **Playwright TS** | `playwright.config.ts` | `['html', { outputFolder: 'reports/html' }]` · `['allure-playwright', { resultsDir: 'reports/allure-results' }]` · `outputDir: 'reports/test-artifacts'` |
| **Pytest** | `pyproject.toml` → `addopts` | `--alluredir=reports/allure-results --html=reports/html/index.html` |
| **TestNG + Maven** | `pom.xml` → surefire `systemPropertyVariables` | `allure.results.directory` = `${project.basedir}/reports/allure-results` · surefire `reportsDirectory` = `${project.basedir}/reports/surefire` |
| **Log file** | Log4j2 / `logging` / winston | Ghi vào `reports/logs/` |
| **Screenshot lưu đĩa** | `ScreenshotUtil` | Ghi vào `reports/screenshots/` |

### Lệnh sinh report

```bash
allure generate reports/allure-results -o reports/allure-report --clean
allure generate reports/allure-results -o reports/allure-report-single --single-file --clean
```

### Tự sinh report sau MỌI lần chạy (BẮT BUỘC)

Mọi lần thực thi test — chạy cả suite, 1 file, `--grep`, 1 test lẻ, chạy lại sau self-fix — **PHẢI** tự sinh
**cả hai** `reports/allure-report/` và `reports/allure-report-single/` ngay khi chạy xong, **qua config**, không
phụ thuộc agent/người chạy nhớ gõ lệnh `allure generate`.

| Stack | Cơ chế tự sinh |
|---|---|
| **Playwright TS** | Custom reporter (`src/reporters/allure-generate.reporter.ts`) khai báo trong `reporter[]` của `playwright.config.ts`, đứng **sau** `allure-playwright`, gọi `allure generate` 2 lần trong `onEnd` |
| **Pytest** | Hook `pytest_sessionfinish` trong `conftest.py` gọi `allure generate` 2 lần |
| **TestNG + Maven** | `allure-maven` plugin (`report` + single-file) gắn vào phase `verify`, hoặc `exec-maven-plugin` sau surefire |

**Quy tắc:**
- **CẤM** truyền cờ ghi đè reporter khi chạy (`--reporter=...` của Playwright, `-p no:allure_pytest`…) — cờ này
  **thay thế toàn bộ** reporter trong config, tắt luôn `allure-playwright` + reporter sinh report → report không
  được cập nhật. Muốn log console gọn thì chỉnh reporter console **trong config**, không override trên CLI.
- Reporter tự sinh chỉ generate khi **có test thực sự được thực thi** — lệnh không chạy test (`--list`,
  `--collect-only`, dry-run) **KHÔNG** được ghi đè report của lần chạy thật trước đó.
- Sau mỗi lần chạy, agent **kiểm tra log** có dòng xác nhận sinh report (VD `Allure report: …/index.html`) cho
  **cả 2** thư mục trước khi báo kết quả — thiếu dòng này = report chưa sinh, phải báo user, không được nói "đã có report".
- Khi báo kết quả cho user, kèm đường dẫn mở report: `reports/allure-report-single/index.html` (mở thẳng
  bằng `file://`) và lệnh `npx allure open reports/allure-report` (bản nhiều file cần server).

### Quy tắc kèm theo

- **`.gitignore` PHẢI có dòng `reports/`** — không commit output test lên repo
- **CI upload artifact** trỏ vào `reports/` (1 artifact duy nhất, không upload lẻ từng thư mục)
- **KHÔNG** để thư mục mặc định của tool nằm ở root: `allure-results/`, `test-results/`, `playwright-report/`, `target/surefire-reports/` — phải trỏ lại vào `reports/`
- Ảnh trong `reports/screenshots/` chụp hệ thống thật, **thường chứa dữ liệu khách hàng** — thêm lý do nữa để không commit

---

## 7. Checklist Review Report

Trước khi bàn giao script, mở report lên và kiểm:

- [ ] Tên test hiển thị bằng Tiếng Anh, **không** phải tên hàm — toàn bộ nội dung report bằng Tiếng Anh
- [ ] Có Description giải thích test kiểm tra gì
- [ ] Có Severity + Tags + TC ID
- [ ] Test Body có step Arrange / Act / Assert, tên step đọc hiểu được
- [ ] Có TC nguồn → số step `Act`/`Assert` top-level **bằng đúng** số dòng Steps/Expected của TC; mỗi dòng Steps N = 1 step `Act: Step N — …`, mỗi dòng Expected N = 1 step `Assert: Expected N — …` ngay sau nó; không step gộp `Act & Assert`, không step top-level ngoài TC (cleanup, hậu tố `(create form)`…)
- [ ] Mỗi step Arrange/Act/Assert có 1 ảnh đính kèm ngay sau khi step chạy xong
- [ ] Có ảnh `final_state` ở cuối **mọi** test PASSED
- [ ] Test FAILED có ảnh tại thời điểm fail
- [ ] **Không** có attachment `stdout` / `stderr`
- [ ] Toàn bộ output nằm trong `reports/` — root project sạch, không có `allure-results/` / `test-results/` / `playwright-report/` lạc ra ngoài
- [ ] `.gitignore` đã có `reports/`
- [ ] Mỗi lần chạy tự sinh cả `allure-report/` + `allure-report-single/` qua config — không override reporter trên CLI, `--list` không ghi đè report
