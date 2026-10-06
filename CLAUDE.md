# CLAUDE AI - GLOBAL AUTOMATION AGENT RULES

> **Scope:** Áp dụng cho mọi tác vụ Test Automation do Claude (Claude Code) hoạt động trong dự án này.
> **Mục tiêu:** Sinh ra test scripts hiệu quả, ổn định – dễ debug – dễ scale – CI friendly.

---

## Test Run Confirmation Rule (MANDATORY)

* **KHÔNG** tự chạy test khi chưa được user xác nhận — áp dụng cho **mọi** lệnh thực thi test: `npx playwright test`, `npm test`, `mvn test`, chạy lại sau khi self-fix, chạy lần 2 để xác nhận ổn định, chạy thử 1 test lẻ.
* Trước mỗi lần chạy, hỏi user và nêu rõ:
  - **Lệnh** sẽ chạy và **phạm vi** (file / `--grep` / project)
  - **Tác động dữ liệu**: test nào tạo/sửa dữ liệu trên môi trường (đặc biệt môi trường dùng chung)
  - **Mục đích**: debug, xác nhận fix, hay lần PASS thứ 2 theo Definition of Done
* Chỉ chạy sau khi user đồng ý **cho đúng lần chạy đó** — xác nhận 1 lần không áp dụng cho các lần chạy sau.
* **Được phép** không cần hỏi: `npx tsc --noEmit`, `playwright test --list` (không thực thi test).
* Chạy test **luôn** giữ reporter trong config — **CẤM** cờ `--reporter=...` hay tương đương. Mọi lần chạy phải tự sinh `reports/allure-report/` + `reports/allure-report-single/`; kiểm log có dòng xác nhận sinh report trước khi báo kết quả (xem `reporting_rules.md` mục 6 → *Tự sinh report sau MỌI lần chạy*).
* Rule này **ghi đè** mọi bước "chạy test ngay / tự chạy lại" trong workflows, skills và phần Execution bên dưới.

---

## Script All → Run All Rule (MANDATORY)

Khi sinh automation từ một file test case (hoặc một module), **viết xong script cho TOÀN BỘ TC trước, rồi mới chạy toàn bộ suite một lần**.

1. **Script hết:** mọi TC trong file đều phải có test tương ứng — hoặc tự động hoá, hoặc `skip` kèm lý do rõ ràng trong report (thiếu quyền, thiếu dữ liệu, cần DB…). Không để TC nào "chưa viết".
2. **Kiểm tĩnh:** `npx tsc --noEmit` + `playwright test --list` — xác nhận số TC trong `--list` khớp số TC trong file, không trùng TC ID.
3. **Xin xác nhận một lần** (theo *Test Run Confirmation Rule*) rồi chạy **toàn bộ** suite của module.
4. **Sau lần chạy:** phân loại từng FAIL (lỗi script / issue thật / lệch TC–UI / môi trường) → sửa script → xin xác nhận → chạy lại.

* **CẤM** trong lúc còn đang viết script: chạy từng spec lẻ, `--grep` một phần, hay spec "recon/probe" tạm để thử.
* Inspect DOM trước khi code (MCP / snapshot, **không lưu dữ liệu**) vẫn bắt buộc — đó là khảo sát, không phải chạy suite.
* Lý do: chạy lẻ giữa chừng làm tốn thời hạn token phiên, ghi dữ liệu thừa lên môi trường dùng chung và sinh report rời rạc khó đọc.
* Rule này **ghi đè** các bước "code xong 1 TC → chạy thử ngay" trong workflows / skills.

---

## Git Pull Restriction Rule

* Tuyệt đối KHÔNG dùng lệnh GIT làm thay đổi trạng thái code (như `git pull`, `git checkout`, `git merge`, `git rebase`, `git reset`) để lấy code hoặc thay đổi nhánh.
* Vì có nhiều trường hợp code trên server chưa được cập nhật, việc pull code về sẽ ghi đè và làm sai toàn bộ phần code đang chỉnh sửa ở máy local.
* Luôn giữ nguyên trạng thái code local hiện tại để làm việc.
* Nếu cần file hoặc nội dung mới, hãy yêu cầu người dùng cung cấp thay vì tự ý dùng git.
* **Được phép** dùng lệnh read-only: `git status`, `git diff`, `git log` — để kiểm tra trạng thái mà không thay đổi code.

---

## Browser Rules (MANDATORY)

### 🖥️ Viewport & Mode

* Tất cả **UI debugging** phải chạy với **desktop viewport**: **`1920x1080`**
* Bắt buộc **mở browser thật** khi debug (headed mode)
* **Headless mode** chỉ được sử dụng **sau khi test đã debug PASS trên UI**
* CI/CD pipeline **được phép chạy headless mặc định**

### 🔄 Thứ Tự Debug Bắt Buộc (Playwright MCP)

Khi dùng Playwright MCP để debug UI, **LUÔN** tuân theo thứ tự:

```
navigate → resize(1920×1080) → wait_for(page_load) → snapshot → interact → screenshot(on_fail)
```

* **KHÔNG** gọi `browser_navigate` lại nếu đã đang ở đúng trang — tránh reload ngoài ý muốn
* **LUÔN** gọi `browser_resize(width=1920, height=1080)` ngay sau `browser_navigate`
* **LUÔN** verify page đã load xong trước khi lấy snapshot hoặc tương tác

### 📸 Screenshot & Snapshot

* Dùng **`snapshot`** để phân tích DOM và xác định locator
* Dùng **`screenshot`** để lưu bằng chứng khi test fail hoặc để báo cáo
* Chụp **screenshot ngay khi assertion fail** để hỗ trợ truy vết lỗi
* **KHÔNG** chụp screenshot tràn lan — chỉ khi cần thiết (fail / milestone quan trọng)

---

## Tools

### 🛠️ Ưu Tiên Sử Dụng

* Ưu tiên sử dụng **Playwright MCP** cho tất cả tác vụ debug UI
* Tham chiếu rule chi tiết: [Quy tắc Playwright](.claude/rules/playwright_rules.md)

### 🔍 Inspect & Debug

* Mở browser thật để debug (headed mode)
* Inspect **DOM / HTML thực tế** trên trình duyệt — **KHÔNG đoán locator**
* Execute và debug test trực tiếp trên UI trước khi sinh code
* **KHÔNG** generate code khi chưa inspect DOM

### ⚡ Nguyên Tắc

* Một locator phải được **verify chạy được** trên browser hiện tại trước khi đưa vào code
* Nếu locator lấy từ code cũ → **bắt buộc verify lại** trước khi dùng

---

## Cleanup & Delivery

### ✅ Điều kiện bàn giao (Definition of Done)

Test chỉ được coi là **hoàn thành** khi đáp ứng **toàn bộ** các tiêu chí sau:

#### 🧹 Code Cleanup

- [ ] Xoá toàn bộ `print()`, `console.log()`, debug log tạm thời
- [ ] Xoá locator không còn sử dụng
- [ ] Không để lại commented-out code
- [ ] Không có `waitForTimeout` / `Thread.sleep` hardcoded
- [ ] Không có test data hardcoded (email, username, ID phải random/traceable)

#### 🏗️ Cấu trúc & POM

- [ ] Tuân thủ mô hình **Page Object Model** — tách biệt Page class, Test class, Utils
- [ ] Locator được định nghĩa trong Page class, không viết inline trong test
- [ ] Tên file, class, method đặt theo convention rõ ràng và nhất quán
- [ ] Import không còn thừa (unused imports)

#### ✔️ Chất lượng Test

- [ ] Test **PASS ổn định** ít nhất **2 lần liên tiếp** trên UI (headed mode)
- [ ] Assertion có message rõ ràng, dễ debug khi fail
- [ ] Có TC nguồn → **mọi ý** trong từng dòng Expected có assertion tương ứng hoặc ghi *Not automated*; "every X" và mọi option TC liệt kê → assert từng cái theo tên; TC lệch UI đã báo user (xem `automation_rules.md` mục 6.1)
- [ ] Mỗi test case độc lập — không phụ thuộc thứ tự chạy
- [ ] Test data được sinh động (timestamp/random) và traceable

#### 📊 Chất Lượng Report (Allure / tương đương)

> Chi tiết: [`.claude/rules/reporting_rules.md`](.claude/rules/reporting_rules.md)

- [ ] Tên test hiển thị bằng **Tiếng Anh** mô tả hành vi — KHÔNG phải tên hàm (toàn bộ nội dung report bằng Tiếng Anh)
- [ ] Có **Description**, **Severity**, **Tags**, **TC ID** cho mỗi test
- [ ] Test Body có step `Arrange:` / `Act:` / `Assert:` đọc hiểu được, không phẳng
- [ ] Có TC nguồn → số step `Act`/`Assert` **bằng đúng** số dòng Steps/Expected của TC: `Act: Step N — …` rồi `Assert: Expected N — …`, không gộp `Act & Assert`, không thêm step top-level ngoài TC
- [ ] Có screenshot đính kèm ở cuối **MỌI** test — cả PASS lẫn FAIL
- [ ] **KHÔNG** có attachment `stdout` / `stderr` trong report
- [ ] Mỗi lần chạy tự sinh `allure-report/` + `allure-report-single/` qua config (không override reporter trên CLI)
- [ ] Toàn bộ output report gom trong **`reports/`** — root project sạch, `.gitignore` đã chặn `reports/`

#### 📁 File Output

- [ ] Source code được lưu đúng vị trí trong project structure
- [ ] Không có file tạm, file test thừa trong thư mục source
- [ ] File cấu hình (config, .env) không chứa credentials thật

#### 📋 Báo Cáo Kết Quả

- [ ] Tóm tắt kết quả: số test PASS / FAIL / SKIP
- [ ] Nêu rõ các TC đã implement và TC nào bị skip (kèm lý do)
- [ ] Ghi chú các known issues hoặc limitation nếu có

---

## 1. Ngôn Ngữ & Giao Tiếp

- Luôn giao tiếp, giải thích ý tưởng và báo cáo bằng **Tiếng Việt**.
- Diễn giải **ngắn gọn, rõ ràng, dễ hiểu**.
- Tránh suy đoán lập trình hoặc giải thích mơ hồ về lỗi mà cần có căn cứ trực tiếp.

## 2. Quy Trình Làm Việc (Workflow)

- **Recon (Điều tra):** Luôn inspect giao diện thực tế hoặc DOM/HTML/XML trước khi viết automation. Tuyệt đối KHÔNG ĐOÁN locator.
- **Implementation:** Giữ vững mô hình **Page Object Model (POM)**. Phân tách rõ Page objects, Test execution và Utils/Test data.
- **Execution & Self-fix:** Code xong → **xin user xác nhận rồi mới chạy test** (xem *Test Run Confirmation Rule*). Nếu test FAIL → tự đọc log → phân tích root cause → sửa code → **xin xác nhận** → chạy lại → đến khi PASS ổn định. Chỉ hỏi User về nghiệp vụ khi gặp business rule mâu thuẫn.
- **Cleanup:** Gỡ bỏ debug logs, code thừa, locator không dùng trước khi deliver.

## 3. Tech Stack Hỗ Trợ

| Loại             | Công nghệ                                     |
| ----------------- | ----------------------------------------------- |
| Ngôn ngữ        | Java, TypeScript                                |
| Web Automation    | Playwright (TS/Java), Selenium WebDriver (Java) |
| Mobile Automation | Appium (Java)                                   |
| API Automation    | REST Assured                                    |
| Test Framework    | TestNG, Playwright Test                         |
| Build Tool        | Maven, npm                                      |

## 4. Tham Chiếu Rules Chi Tiết

Agent phải tham chiếu quy tắc chi tiết trong `.claude/rules/`:

- [Quy tắc chung Automation](.claude/rules/automation_rules.md) — POM, Test Data, Naming, Assertions
- [Quy tắc Report (Allure)](.claude/rules/reporting_rules.md) — Metadata test, report Tiếng Anh, screenshot, cấm stdout
- [Chiến lược chọn Locator](.claude/rules/locator_strategy.md) — Thứ tự ưu tiên locator
- [Quy tắc Playwright](.claude/rules/playwright_rules.md) — Browser setup, locator semantic, wait strategy
- [Quy tắc Selenium](.claude/rules/selenium_rules.md) — WebDriverWait, TestNG structure
- [Quy tắc Appium](.claude/rules/appium_rules.md) — Mobile locator, scroll, permission

## 5. Tham Chiếu Skills

Agent sử dụng skills trong `.claude/skills/` tùy theo nhiệm vụ:

| Skill                      | Vai trò                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| `skills-qa-automation-engineer` | Master skill cho automation — điều phối toàn bộ quy trình                          |
| `skills-rbt-manual-testing`     | Master skill cho manual testing — 2 modes: QUICK (sinh TC nhanh) và FULL RBT (quy trình 6 bước) |
| `skills-framework-architect`     | Thiết kế & scaffold automation framework — project structure, base classes, reporting, CI/CD |
| `skills-requirements-analyzer`  | Phân tích requirements từ website/tài liệu                                           |
| `skills-ui-debug-agent`         | Inspect UI/DOM, thu thập locators                                                        |
| `skills-smart-locator-agent`    | Sinh locator mới ổn định                                                              |
| `skills-locator-healer-agent`   | Sửa locator hỏng                                                                        |
| `skills-test-data-generator`    | Sinh test data unique, traceable — hỗ trợ multi-step pipeline & combinatorial data       |
| `skills-flaky-test-analyzer`    | Phân tích và khắc phục flaky tests                                                   |
| `skills-jira-integration`       | Tích hợp Jira/Xray — lấy requirements, đẩy test results                             |

## 6. Kế Hoạch Kiểm Thử (Plan Templates)

Các bộ prompt template sẵn dùng trong `plans/`:

- **`plans/manual/`** — Quy trình sinh Manual Test Cases (2 modes: QUICK + FULL RBT)

  - Xem `plans/manual/QUICK_START.md` để bắt đầu nhanh
  - Workflow QUICK: `/generate_testcases_from_requirements`
  - Workflow FULL RBT: `/generate_manual_testcases_rbt`
- **`plans/automation/`** — Quy trình 6 bước sinh Automation Scripts

  - Xem `plans/automation/QUICK_START.md` để bắt đầu nhanh
  - One-click: Copy `plans/automation/prompt_automation.txt`
  - Workflow: `/generate_automation_from_testcases`
- **`plans/cross-module/`** — Quy trình phân tích Cross-Module & Ma trận kết hợp

  - Xem `plans/cross-module/QUICK_START.md` để bắt đầu nhanh
  - Workflow phân tích: `/generate_cross_module_test_plan`
  - Workflow sinh data: `/generate_combinatorial_test_data`

## 6b. Cấu Trúc Thư Mục `docs/` (BẮT BUỘC)

Toàn bộ tài liệu tổ chức **theo thư mục từng module**. Mỗi nhánh có một **file danh mục `README.md`** — **đọc file này đầu tiên** khi cần biết module nào đã có tài liệu, prefix nào đã bị chiếm, mã kế tiếp bắt đầu từ đâu.

```
docs/
├── requirements/
│   ├── README.md                              ← DANH MỤC requirements
│   └── <module>/
│       ├── requirements_<module>.md           ← INDEX — TÊN FILE BẤT BIẾN
│       ├── evidence/*.png                     ← bằng chứng khảo sát
│       ├── stories/story_NN_<slug>.md         ← chỉ khi tài liệu bị tách
│       └── analysis/analysis_<TICKET-ID>.md   ← phân tích ticket của module này
│
└── testcases/
    ├── README.md                              ← DANH MỤC test cases
    └── <module>/
        ├── test_cases_<module>.md             ← INDEX — TÊN FILE BẤT BIẾN
        ├── parts/part_NN_<slug>.md            ← khi tách (>40 TC)
        └── archive/test_cases_<module>_vN.md  ← phiên bản cũ
```

### Quy tắc bất biến

| Quy tắc | Lý do |
|---|---|
| Tên file index **luôn** `requirements_<module>.md` / `test_cases_<module>.md` | Mọi workflow phía sau đọc theo mẫu `docs/<nhánh>/<module>/<file>`. Đổi tên là vỡ chuỗi RTM |
| **KHÔNG** nhét số phiên bản vào tên index (`_v2`, `_new`, `_index`…) | Bản mới **thay thế** index; bản cũ chuyển vào `archive/` |
| Mỗi module một prefix **duy nhất** (`LOGIN`, `CUST`, `PRJ`…) | Chống trùng mã giữa các module — tra ở danh mục trước khi đặt |
| **KHÔNG đánh lại mã REQ từ `01`** khi module đã có tài liệu | Đụng mã là vỡ toàn bộ traceability |
| **KHÔNG xoá dòng REQ** — tính năng gỡ thì đổi trạng thái 🔴 Deprecated | Xoá dòng là mất dấu vết |
| Mọi thay đổi requirements phải ghi **Nhật ký thay đổi** ở cuối tài liệu module | Bộ nhớ liền mạch giữa các phiên, và là nơi báo TC nào đã stale |
| Evidence nằm **cùng** tài liệu sinh ra nó (recon → `<module>/evidence/`) | Di chuyển/xoá không lạc file; link tương đối không gãy |
| Thêm module = thêm thư mục + 1 dòng ở `README.md` danh mục | Không đụng gì khác trong repo |

Chi tiết: skill `skills-requirements-analyzer` mục 2.1 (nối tiếp mã), 5.3 (thư mục), 5.7 (danh mục), 6.9 (nhật ký) · skill `skills-rbt-manual-testing` mục "Quy Tắc Xuất File" phần 2 và 4.

### Chuyển sang dự án mới — dọn gì

```bash
rm -rf docs .playwright-mcp task.md .claude/settings.local.json
```

| | |
|---|---|
| **Xoá** | `docs/` · `.playwright-mcp/` · `task.md` · `.claude/settings.local.json` |
| **Giữ nguyên** | `.claude/` (trừ `settings.local.json`) · `plans/` · `prompt_templates/` · `CLAUDE.md` · `README.md` · `.gitignore` — khung dùng lại được, không hardcode hệ thống nào |

⚠️ **`.claude/settings.local.json`** là permission tích luỹ theo từng máy/phiên, thường chứa đường dẫn tuyệt đối của dự án cũ. Đã đưa vào `.gitignore` — nếu file còn bị git theo dõi từ trước, gỡ bằng: `git rm --cached .claude/settings.local.json`

⚠️ **Trước khi xoá, kiểm tra ảnh trong `docs/requirements/*/evidence/`** — screenshot chụp hệ thống thật, thường chứa dữ liệu khách hàng (tên, email, số tiền). Quan trọng hơn nữa: **đừng commit chúng lên repo công khai**.

Không cần dọn gì thêm. Agent tự tạo lại `docs/` và 2 file danh mục (`docs/requirements/README.md`, `docs/testcases/README.md`) ở lần chạy workflow đầu tiên — xem skill `skills-requirements-analyzer` mục 5.7.1.

**Chốt trước khi phân tích module đầu tiên** — agent **tự khám phá**, chỉ hỏi user thứ không suy ra được:

| Cần chốt | Ai xác định |
|---|---|
| **Prefix REQ** từng module (`LOGIN`, `CUST`…) — ngắn, HOA, không dấu | Agent tự đặt từ tên module đã recon, ghi vào `docs/requirements/README.md` |
| **Prefix TC ID** `<HỆ_THỐNG>_<MODULE>_TC_<3 số>` — `<HỆ_THỐNG>` đổi theo dự án (`CRM_` → `ERP_`, `HRM_`…) | Agent suy từ tên hệ thống, **xác nhận với user một câu** rồi dùng xuyên suốt. Đổi giữa chừng là phải sửa toàn bộ TC ID |
| **URL · tài khoản test** | User cung cấp lúc chat — lưu ở `.env`, KHÔNG ghi vào tài liệu |
| **Môi trường dùng chung không?** | **Hỏi user một lần** — không suy ra được từ UI. Nếu CÓ → bật quy tắc dọn dữ liệu test, cấm thao tác phá huỷ |
| Business rules ẩn (CAPTCHA, OTP, quy tắc sinh mã…) | Agent phát hiện khi recon → ghi ngay vào tài liệu module. Chỉ hỏi user khi mâu thuẫn |

> **Không có file hồ sơ dự án để điền tay.** Ngữ cảnh dự án nằm trong `docs/` do agent tự sinh — xem `skills-requirements-analyzer` mục 5.7.1.

## 7. Test Data

- Tất cả field yêu cầu **unique** (Email, Username, Code/ID): **BẮT BUỘC** dùng dữ liệu random.
- Dữ liệu random phải **traceable / deterministic** — có thể truy ngược test gây lỗi.
- Format khuyến nghị: kết hợp `test name + timestamp + prefix`.

Ví dụ:

```
email:    test_login_1712049200@auto.test
username: auto_user_1712049200
code:     TC_LOGIN_1712049200
```

## 8. Code Quality (Smart Waits)

- **KHÔNG** dùng hard sleep (`waitForTimeout`, `Thread.sleep`, fixed delay).
- Chỉ sử dụng **smart waits** / auto-waiting:

| Framework  | Smart Wait                                                           |
| ---------- | -------------------------------------------------------------------- |
| Playwright | `expect().toBeVisible()`, `expect().toBeEnabled()`, Locator APIs |
| Selenium   | `WebDriverWait` + `ExpectedConditions`                           |
| Appium     | `WebDriverWait` + custom conditions                                |

- Hạn chế `waitForSelector` nếu `expect()` đáp ứng được.
- Mọi assertion phải có **timeout rõ ràng** hoặc dùng default timeout hợp lý.

## 9. Anti-Patterns (FORBIDDEN)

| ❌ Anti-Pattern                                   | ✅ Thay thế đúng                            |
| ------------------------------------------------- | ---------------------------------------------- |
| Guess selector / đoán locator                   | Inspect DOM thực tế trước khi code         |
| Hard sleep (`waitForTimeout`, `Thread.sleep`) | Smart waits (`expect()`, `WebDriverWait`)  |
| Copy selector từ code cũ không verify          | Luôn verify selector trên browser hiện tại |
| Viết test không chạy                           | Chạy test sau khi implement — **có user xác nhận** |
| Commit test FAIL                                  | Chỉ commit khi test PASS ổn định           |
| Để debug log / commented code khi deliver       | Cleanup trước khi deliver                    |
| Dùng test data hardcoded trùng lặp             | Sinh data random + traceable                   |

## 10. Tham Chiếu Workflows

Agent sử dụng workflows trong `.claude/commands/` qua slash commands:

| Workflow                                  | Mô tả                                                     |
| ----------------------------------------- | ----------------------------------------------------------- |
| `/generate_requirements_from_website`   | Sinh requirements từ website/module (nhánh UI Recon)        |
| `/analyze_requirement_document`         | Phân tích requirement document (Jira/.docx/.pdf/.xlsx/.csv) — sinh tài liệu phân tích, KHÔNG sinh TC |
| `/generate_manual_testcases_rbt`        | Sinh manual test cases theo AI-RBT 6 bước (FULL RBT mode) |
| `/generate_testcases_from_requirements` | Sinh test cases nhanh từ requirements (QUICK mode)         |
| `/generate_automation_from_testcases`   | Chuyển manual test cases → automation scripts             |
| `/generate_automation_from_ui_flow`     | Sinh automation từ UI flow trực tiếp                     |
| `/generate_application_test_plan`       | Khám phá app, sinh test plan (Mode PLAN) hoặc full suite (Mode FULL) |
| `/generate_automation_framework`        | Thiết kế automation framework                             |
| `/generate_locator`                     | Sinh locator ổn định cho UI element                      |
| `/generate_test_data`                   | Sinh test data có cấu trúc                               |
| `/generate_cross_module_test_plan`    | Phân tích cross-module (2 modes: DOCUMENT/BROWSER), sinh ma trận kết hợp — mặc định Output-Class Coverage, pairwise bằng script |
| `/generate_combinatorial_test_data`   | Sinh test data cho ma trận kết hợp — offline hoặc pipeline qua browser          |
| `/generate_api_tests_from_swagger`      | Sinh API tests từ Swagger spec                             |
| `/analyze_flaky_tests`                  | Phân tích và khắc phục flaky tests                     |
| `/fetch_jira_requirements`              | Lấy requirements/user stories từ Jira                     |
| `/import_test_results_xray`             | Đẩy kết quả test lên Xray                              |
