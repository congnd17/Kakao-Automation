# Claude Testing Kit 🚀

👋 Chào mừng bạn đến với **Claude Testing Kit** phiên bản dành cho **Claude Code**!

Mục tiêu của repo này là cung cấp sẵn các thiết lập, quy tắc hành vi (Rules), kỹ năng (Skills), và lệnh tùy chỉnh (Commands) chuẩn để hỗ trợ sử dụng AI Agent trên phần mềm **Claude Code** (bao gồm Claude Code CLI và Claude Code Desktop hoặc Claude Code dạng Extention trên VS Code).

Bộ Kit này **không chỉ dành riêng cho Automation** — mà được thiết kế toàn diện cho cả **Manual Testing** lẫn **Automation Testing**, bao phủ toàn bộ vòng đời kiểm thử phần mềm từ phân tích yêu cầu, thiết kế test cases cho đến thực thi và báo cáo kết quả.

Đặc biệt, mọi công đoạn đều được **tích hợp AI một cách có hệ thống**, tạo thành một **quy trình ứng dụng AI hoàn thiện (End-to-End AI Testing Workflow)** — giúp Tester làm việc thông minh hơn, nhanh hơn và hiệu quả hơn trong kỷ nguyên AI.

---

## 🌟 Tính Năng Nổi Bật

- **🔁 Quy Trình AI Hoàn Thiện (End-to-End):** Được xây dựng thành một quy trình ứng dụng AI khép kín — từ phân tích yêu cầu (Requirements), thiết kế test cases (Manual), đến viết script tự động (Automation), tích hợp CI/CD và báo cáo kết quả — tất cả đều có AI hỗ trợ.
- **📋 Manual Testing Tiêu Chuẩn Cao (AI-RBT Framework):**
  - Đánh giá rủi ro theo 3 mức độ `High / Medium / Low Risk`.
  - Checklist validation **15 loại Input Field Types** (Text, Email, Phone, Date, Number, Dropdown, Checkbox/Radio, File Upload, Password, Textarea, OTP/MFA, Date Range, Rich Text, Multi-Select, Range Slider).
  - Tích hợp Scenarios Chuyên Sâu & Non-Functional (Race Condition, Session/Network Resilience, Localization/UTF-8/Emoji, Keyboard A11y, HTTP Status Codes).
  - **AI Self-Quality Gate (7 Tiêu chí):** Đảm bảo Unique TC ID, Step-Expected 1-1, Concrete Test Data, Field Coverage, Automation Metadata Ready, Requirement Coverage (đối soát mọi REQ có ≥1 TC), và **Evidence-verified** (bắt buộc mở hết ảnh evidence trước khi sinh TC — đối soát ảnh nào chống lưng cho TC nào).
  - **Truy vết REQ ID xuyên suốt:** Requirements được gán mã `REQ-<MODULE>-<SỐ>` → mỗi TC có cột `REQ ID` → Bảng Đối Soát Coverage chứng minh "đủ case".
- **🌐 API Testing & OWASP Security Standards:**
  - Bao phủ đủ **12 HTTP Status Codes** tiêu chuẩn (`200`, `201`, `400`, `401`, `403`, `404`, `406`, `409`, `413`, `415`, `429`, `500`).
  - Tích hợp **OWASP API Security Checklist** (BOLA/IDOR, Mass Assignment, SQLi/XSS, ReDoS, Sensitive Data Masking).
  - Response time SLA (< 2 giây), Dynamic Auth Token, Teardown/Cleanup test data tự động.
- **📊 Chất Lượng Report Chuẩn Hoá (Allure):** Tên test Tiếng Việt, Description/Severity/Tags/TC ID, Test Body có step `Arrange`/`Act`/`Assert`, screenshot đính kèm cuối **mọi** test (cả PASS lẫn FAIL), cấm attachment `stdout` — toàn bộ output gom trong `reports/`.
- **🧠 Tối ưu cho QA/Tester:** Tất cả các prompt, rule và command đều được tinh chỉnh dựa trên tư duy và quy trình làm việc thực tế của cả **Manual Tester** lẫn **Automation Engineer**.
- **💻 Hỗ trợ Đa Nền Tảng:** Tương thích với các framework phổ biến như Web (Playwright, Selenium), Mobile (Appium), và API (Playwright API, REST Assured, Pytest Requests, Supertest).
- **🛡️ Tuân thủ Tiêu Chuẩn Cao (Strict Rules):** Đảm bảo AI luôn đi theo cấu trúc Page Object Model (POM), viết code rõ ràng, không đoán bừa locator và tự động sửa lỗi (Self-fix).
- **🇻🇳 Giao Tiếp Bằng Tiếng Việt:** AI được cấu hình để trao đổi, giải thích và báo cáo hoàn toàn bằng Tiếng Việt, thân thiện với người dùng Việt Nam.

---

## 📂 Cấu Trúc Thư Mục Chính

Repo chia làm 2 phần rõ rệt: **khung** (dùng lại cho mọi dự án) và **đầu ra** (dữ liệu của dự án đang làm).

```
claude-testing-kit/
│
│ ══════════ KHUNG — dùng lại cho mọi dự án ══════════
├── .claude/
│   ├── commands/            # 16 lệnh tùy chỉnh (slash commands)
│   ├── rules/               # 6 quy tắc bắt buộc AI phải tuân theo
│   ├── skills/              # 10 kỹ năng chuyên biệt cho AI
│   └── settings.json        # Cấu hình quyền hạn cho Claude Code
├── plans/
│   ├── manual/              # Quy trình 6 bước sinh Manual Test Cases (AI-RBT)
│   ├── automation/          # Quy trình 6 bước sinh Automation Scripts
│   └── cross-module/        # Quy trình phân tích Cross-Module & Ma trận kết hợp
├── prompt_templates/        # Prompt mẫu dùng nhanh (copy → paste → gửi)
├── CLAUDE.md                # Rule chung cho AI Agent (Claude Code đọc tự động)
│
│ ══════════ ĐẦU RA — dữ liệu của dự án đang làm ══════════
└── docs/
    ├── requirements/
    │   ├── README.md                          # DANH MỤC module: prefix đã chiếm, mã REQ kế tiếp
    │   └── <module>/
    │       ├── requirements_<module>.md       # INDEX — tên file bất biến
    │       ├── evidence/*.png                 # ảnh chụp khi khảo sát
    │       ├── stories/                       # khi tài liệu bị tách
    │       └── analysis/                      # phân tích ticket của module
    └── testcases/
        ├── README.md                          # DANH MỤC bộ TC: prefix TC ID, độ phủ REQ↔TC
        └── <module>/
            ├── test_cases_<module>.md         # INDEX — tên file bất biến
            ├── parts/                         # khi > 40 TC
            └── archive/                       # phiên bản TC cũ
```

> **Chuyển sang dự án mới:** chỉ cần xoá phần **ĐẦU RA** — `rm -rf docs .playwright-mcp task.md .claude/settings.local.json`. Agent tự tạo lại cấu trúc `docs/` ở lần chạy workflow đầu tiên. Chi tiết xem [CLAUDE.md](CLAUDE.md) mục 6b.

### `.claude/` — Bộ não của AI Agent trên Claude Code

| Thư mục | Vai trò |
|---------|--------|
| `commands/` | 16 slash commands: `/generate_requirements_from_website`, `/analyze_requirement_document`, `/generate_manual_testcases_rbt`, `/generate_automation_from_testcases`, `/generate_cross_module_test_plan`, `/generate_combinatorial_test_data`... |
| `rules/` | 6 quy tắc bắt buộc: automation chung, **report (Allure)**, locator strategy, Playwright, Selenium, Appium |
| `skills/` | 10 kỹ năng chuyên biệt: requirements analyzer, automation engineer, manual testing (RBT), UI debug, smart locator, locator healer, test data generator, framework architect, flaky test analyzer, jira integration |
| `settings.json` | Cấu hình quyền hạn: cho phép/cấm các hành động cụ thể (đọc file, chạy test, push code...). Riêng `settings.local.json` là cấu hình **cục bộ từng máy** — đã gitignore, không commit |

> **📌 Lưu ý về cấu trúc:** Trong Claude Code, **workflows** được gọi là **commands** và đặt trong `.claude/commands/`. Tên file dùng dấu gạch dưới (`_`). Ví dụ: `generate_automation_from_testcases.md`.

---

## `plans/` — Quy Trình 6 Bước Chuyên Sâu

Dành cho các tác vụ phức tạp, cần thực hiện **tuần tự trong cùng 1 conversation**.

| Plan | Mô tả | Bắt đầu nhanh |
|------|-------|---------------|
| `plans/manual/` | Sinh Manual Test Cases theo quy trình **AI-RBT 6 bước** (Risk-Based Testing, 15 field types, OWASP & AI Quality Gate) | Xem `plans/manual/QUICK_START.md` |
| `plans/automation/` | Sinh Automation Scripts theo **6 bước** từ context → review | Xem `plans/automation/QUICK_START.md` |
| `plans/cross-module/` | Phân tích tính năng **đa module** & sinh **ma trận kết hợp** (Output-Class/Pairwise/Cartesian) | Xem `plans/cross-module/QUICK_START.md` |

**Cách dùng:** Mở `QUICK_START.md` → Làm theo từng bước → Gửi prompt mỗi bước vào Claude Code.

### `prompt_templates/` — Prompt Mẫu Dùng Nhanh

Dành cho tác vụ **đơn lẻ**, chỉ cần copy → thay `[...]` bằng dữ liệu thực → paste → gửi.

| # | Prompt | Mục đích |
|---|--------|----------|
| 01 | `prompt_01_generate_requirements.txt` | Phân tích website sinh Requirements |
| 02 | `prompt_02_generate_test_cases.txt` | **[Mới]** Sinh manual TCs RBT chuẩn 15 field types & Quality Gate |
| 03 | `prompt_03_create_framework_playwright.txt` | Dựng framework Playwright TS |
| 03 | `prompt_03_create_framework_selenium.txt` | Dựng framework Selenium Java |
| 03 | `prompt_03_create_framework_appium.txt` | **[Mới]** Dựng framework Appium Java (Mobile) |
| 04 | `prompt_04_generate_script_playwright.txt` | Viết test script Playwright TS |
| 04 | `prompt_04_generate_script_selenium.txt` | Viết test script Selenium Java |
| 05 | `prompt_05_convert_manual_to_automation.txt` | Chuyển manual TC sang automation |
| 06 | `prompt_06_generate_test_data.txt` | Sinh test data có cấu trúc |
| 07 | `prompt_07_analyze_flaky_tests.txt` | Phân tích test không ổn định |
| 08 | `prompt_08_generate_api_tests.txt` | **[Mới]** Viết test API 12 status codes & OWASP Security |

---

## ✳️ Hướng Dẫn Sử Dụng Trong Claude Code

### Cách 1: Claude Code CLI (Terminal)

1. **Clone Repo này về máy:**
   Hoặc bạn có thể copy trực tiếp thư mục `.claude` từ repo này.

2. **Tích hợp vào dự án của bạn:**
   Copy thư mục `.claude` vào thư mục gốc (root directory) của dự án Automation hoặc Manual Test mà bạn đang làm việc.

3. **Mở terminal và khởi chạy Claude Code:**
   ```bash
   claude
   ```
   Claude Code tự động nhận diện thư mục `.claude` và file `CLAUDE.md` ở thư mục gốc, áp dụng ngay các Rule, Skill, Command đã thiết lập sẵn.

4. **Sử dụng slash commands:**
   Gõ `/` trong Claude Code để xem danh sách commands có sẵn. Ví dụ:
   ```
   /generate_automation_from_testcases
   /generate_manual_testcases_rbt
   /generate_cross_module_test_plan
   ```

### Cách 2: Claude Code trong VS Code

1. **Cài đặt extension Claude Code** từ VS Code Marketplace.

2. **Mở dự án** đã chứa thư mục `.claude` trong VS Code.

3. **Mở Claude Code panel** (Ctrl+Shift+P → "Claude Code: Open").

4. **Bắt đầu trò chuyện** — Claude Code sẽ tự động nhận diện cấu hình `.claude` và `CLAUDE.md`.

---

## 🔌 Kết nối Playwright MCP

Copy `.claude` vào dự án là AI đã có **Rule / Skill / Command**. Nhưng để AI **mở được browser thật** (bắt buộc cho `/generate_requirements_from_website`, `/generate_automation_from_ui_flow`), cần thêm Playwright MCP.

Chạy đúng 1 lệnh ở thư mục gốc dự án:

```bash
claude mcp add --scope project playwright -- npx -y @playwright/mcp@latest --viewport-size "1920,1080"
```

---

## 🔄 So Sánh Antigravity vs Claude Code

| Tiêu chí | Antigravity (`.agent/`) | Claude Code (`.claude/`) |
|-----------|------------------------|--------------------------|
| Thư mục gốc | `.agent/` | `.claude/` |
| File rule chính | `GEMINI.md` | `CLAUDE.md` |
| Slash commands | `.agent/workflows/` | `.claude/commands/` |
| Quy tắc | `.agent/rules/` | `.claude/rules/` |
| Kỹ năng | `.agent/skills/` | `.claude/skills/` |
| Naming convention | Gạch dưới (`_`) | Dấu gạch dưới (`_`) trong `.claude/commands/` |
| Cấu hình quyền | Không có | `.claude/settings.json` |

> **💡 Tip:** Cả hai phiên bản đều dùng chung thư mục `plans/`, `prompt_templates/`, `scripts/`, và `practices/`. Bạn có thể giữ cả `.agent/` và `.claude/` trong cùng một repo nếu muốn hỗ trợ cả hai nền tảng.

---

## 🤝 Hỗ Trợ & Đóng Góp

- Nếu bạn gặp khó khăn trong quá trình sử dụng hoặc muốn đóng góp để bộ công cụ này hoàn thiện hơn, đừng ngần ngại tạo **Issue** hoặc **Pull Request**.
