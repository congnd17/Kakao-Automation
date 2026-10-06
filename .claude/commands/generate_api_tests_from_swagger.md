---
description: Sinh API test cases và automation scripts từ Swagger/OpenAPI specification. Hỗ trợ 2 mode — SPEC (chỉ test cases) và FULL (test cases + automation scripts).
skills:
  - skills-qa-automation-engineer
  - skills-test-data-generator
---

# Command: Sinh API Tests từ Swagger/OpenAPI

> **BẮT BUỘC (MANDATORY SKILL):** Bạn PHẢI nạp và đọc kỹ nội dung của skill **`skills-qa-automation-engineer`** (tại `.claude/skills/skills-qa-automation-engineer/SKILL.md`) trước khi bắt đầu. Ngoài ra, tham khảo thêm skill **`skills-test-data-generator`** để sinh test data đúng chuẩn.

Command này giúp agent phân tích Swagger/OpenAPI specification, xác định các endpoints, sinh API test cases có cấu trúc, và (tùy mode) tự động sinh automation scripts hoàn chỉnh.

## ⚠️ Nguyên tắc thực thi

- **Tất cả output bằng Tiếng Việt**
- **KHÔNG đoán** schema/endpoint — phải đọc spec thực tế (JSON/YAML)
- **Phải chờ user xác nhận** scope tại Bước 2 trước khi sinh chi tiết
- Nếu user chưa cung cấp Swagger URL/file → hỏi trước khi bắt đầu
- ⚠️ **Rule E3:** Khi test FAIL → tự đọc log → phân tích → sửa → chạy lại. KHÔNG hỏi user trong quá trình fix lỗi

## 2 Chế độ (Mode)

| Mode | Khi nào sử dụng | Output |
|---|---|---|
| **SPEC** (mặc định) | User cần API test cases dưới dạng tài liệu | API Test Cases (Markdown) + Test Data Matrix |
| **FULL** | User yêu cầu cả automation scripts | Như SPEC + Automation Scripts + Project Structure |

> Nếu user nói "generate automation", "viết code test API", hoặc yêu cầu scripts → tự động chuyển sang **Mode FULL**.

## Các bước thực hiện

### Bước 1: Tiếp nhận & Phân tích Spec (Parse & Analyze)

1. **Thu thập Swagger/OpenAPI spec** từ user:
   - **URL trực tiếp** (VD: `https://api.example.com/swagger.json`) → dùng `WebFetch` để fetch
   - **File local** (JSON/YAML) → dùng `Read` để đọc
   - **Swagger UI URL** → trích xuất URL spec gốc (thường là `/v2/api-docs` hoặc `/v3/api-docs`)
   - **Scalar API Reference URL** → inspect HTML để tìm `data-configuration` chứa URL spec (thường là `/swagger/json`, `/reference/json`, hoặc relative path trong attribute `url`). VD: `https://api.example.com/swagger` → spec tại `https://api.example.com/swagger/json`
   - **Các dạng API Doc khác** (Redoc, Stoplight, RapiDoc) → tìm URL spec trong page source hoặc network requests
2. **Parse spec** và trích xuất thông tin:
   - Base URL, API version, authentication scheme (Bearer, API Key, OAuth2, Basic)
   - Danh sách tất cả endpoints: `method + path`
   - Request parameters: path, query, header, body (schema + required fields)
   - Response schemas: status codes, response body structure
   - Models/Definitions: reusable data models
3. **Phân loại endpoints** theo nhóm:
   - **CRUD operations** — Create, Read, Update, Delete
   - **Authentication** — Login, Register, Token refresh
   - **Business Logic** — Các API xử lý nghiệp vụ phức tạp
   - **Utility** — Health check, config, metadata

### Bước 2: Xác nhận Scope & Tech Stack (CHECKPOINT — ⏸️ DỪNG LẠI)

1. **Trình bày tóm tắt** cho user review:
   - Tổng số endpoints phát hiện (phân nhóm)
   - Authentication method
   - Danh sách endpoint groups + số lượng API mỗi nhóm
   - Mode đề xuất (SPEC hay FULL)
2. **Hỏi user xác nhận:**
   - "Bạn muốn test tất cả endpoints hay chỉ tập trung vào nhóm nào?"
   - "Bạn muốn output là test cases (SPEC) hay cả automation scripts (FULL)?"
   - Nếu Mode FULL: "Tech stack mong muốn?" (mặc định theo bảng bên dưới)
3. **Chờ user xác nhận** scope trước khi sang Bước 3

**Tech Stack mặc định (Mode FULL):**

| Framework | Ngôn ngữ | Khi nào dùng |
|---|---|---|
| **REST Assured** | Java | Mặc định cho Java projects, TestNG runner |
| **Playwright API Testing** | TypeScript | Khi user dùng Playwright hoặc TypeScript stack |
| **Supertest + Jest** | TypeScript/JS | Khi user dùng Node.js backend |
| **Requests + Pytest** | Python | Khi user dùng Python stack |

### Bước 3: Sinh API Test Scenarios & Test Data

1. **Bao phủ 12 HTTP Status Codes tiêu chuẩn:**
   - **200/201:** Success
   - **400:** Validation error / Malformed JSON
   - **401:** Missing / Invalid Auth Token
   - **403:** Forbidden / BOLA IDOR User A -> User B
   - **404:** Not Found
   - **406:** Not Acceptable (Accept header mismatch)
   - **409:** Conflict (Duplicate record / Race condition concurrency)
   - **413:** Payload Too Large
   - **415:** Unsupported Media Type (Content-Type mismatch)
   - **429:** Too Many Requests (Rate Limiting)
   - **500:** Server error

2. **Với mỗi endpoint** trong scope đã xác nhận, sinh test scenarios theo 7 loại:
   - **✅ Happy Path** — Request hợp lệ, response đúng schema + status code
   - **❌ Negative — Validation** — Thiếu required fields, sai data type, vượt max length
   - **❌ Negative — Auth** — Không có token, token hết hạn, token sai role
   - **🔲 Boundary** — Min/max values, empty string, null, special characters
   - **⚡ Edge Cases** — Concurrent requests, duplicate creation, large payload, unicode/emoji
   - **🔒 Security** — SQL injection, XSS, IDOR, Mass Assignment, ReDoS, sensitive data exposure
   - **📄 Pagination & Filtering** — Phân trang, sắp xếp, tìm kiếm

3. **Sinh Test Data Matrix** (sử dụng skill `skills-test-data-generator`):
   - Data valid cho Happy Path
   - Data invalid cho Negative cases (mỗi field 1 bộ negative)
   - Boundary values theo schema constraints (minLength, maxLength, min, max, pattern)
   - Data phải **unique + traceable** (VD: `auto_api_1712049200@test.com`)

4. **Field-Level Validation cho Request Body (BẮT BUỘC):**

   Với mỗi endpoint có request body (POST/PUT/PATCH), agent **PHẢI liệt kê từng field** trong body và sinh negative TCs riêng cho TỪNG field (String, Email, Phone, Number, Boolean, Date, Enum, Array, Nested Object, File).

5. **OWASP API Security Testing Checklist:**

   | Loại | Test Scenarios |
   |---|---|
   | **Injection** | SQL injection trong query params (`?id=1 OR 1=1`) · SQL injection trong body fields · XSS trong input fields · Command injection (nếu API xử lý shell) |
   | **BOLA / IDOR (403)** | Truy cập resource của user khác bằng ID (`GET /users/999` khi user chỉ có quyền xem user 123) · Thay đổi ID trong PUT/DELETE để sửa/xóa resource không phải của mình |
   | **Mass Assignment** | Gửi kèm trường đặc quyền trong request body (như `role: "admin"`, `is_admin: true`) xem API có tự gán quyền không |
   | **Auth Bypass (401/403)** | Gọi API không có token → 401 · Token hết hạn → 401 · Token role thấp gọi API role cao → 403 · Token bị tamper → 401 |
   | **ReDoS** | Truyền chuỗi quá dài (> 10.000 chars) vào các field validate regex để kiểm tra Denial of Service |
   | **Sensitive Data Exposure** | Response không trả về password/hash/secretKeys · Response không leak internal IDs/stack traces · Headers không leak server info (`X-Powered-By`, `Server`) |
   | **Rate Limiting (429)** | Gửi nhiều request liên tục → phải bị giới hạn (429) · Brute force login → lock account |
   | **CORS & Headers** | Kiểm tra `Access-Control-Allow-Origin` header · Content-Type header (`415`) · Accept header (`406`) |

6. **Pagination & Filtering Tests (cho GET List endpoints):**

   Pagination (page/limit), Sorting (sort/order), Filtering (by status, date, name), Search (partial match, case-insensitive).

7. **Phân biệt PUT vs PATCH (nếu API có cả 2):**
   - **PUT:** Gửi đầy đủ fields -> update toàn bộ, reset missing optional fields.
   - **PATCH:** Gửi partial fields -> chỉ update field chỉ định, giữ nguyên các field khác.

### Bước 4: Đóng gói API Test Cases (Output — Mode SPEC)

1. Tạo **artifact** `api_test_cases.md` với cấu trúc:
   - **Tổng quan API** — Base URL, Version, Auth method, Tổng endpoints
   - **Endpoint Catalog** — Bảng: `| # | Method | Path | Mô tả | Số Test Cases |`
   - **Test Cases chi tiết** — Theo từng endpoint
   - **Test Data Matrix** — Bảng data valid/invalid/boundary cho mỗi model
   - **Dependencies & Execution Order** — Thứ tự chạy test

2. Nếu user chọn **Mode SPEC** → **KẾT THÚC** tại đây

### Bước 5: Sinh Automation Scripts (Mode FULL)

1. **Thiết kế project structure** phù hợp với framework (REST Assured / Playwright API / Pytest Requests / Supertest).
2. **Sinh code:** Base API class, Model/DTO classes, API client classes, Test Data generators, Test classes.
3. **Assertions bắt buộc:**
   - ✅ HTTP Status Code (exact match)
   - ✅ Response body structure & JSON Schema validation
   - ✅ Response time SLA (< 2 giây)
   - ✅ Headers & Sensitive Data masking check
4. **Best practices:**
   - Dynamic Auth Token (không hardcode)
   - Parameterized tests
   - Teardown/Cleanup data sau khi test (DELETE record vừa tạo)

### Bước 6: Chạy thử nghiệm & Tự sửa lỗi (Execution & Auto-Heal)

1. **Chạy test** bằng `run_command`.
2. **Theo dõi** qua `command_status`.
3. **Auto-Heal:** Nếu FAIL → tự đọc log, sửa code và chạy lại (tối đa 5 lần) mà KHÔNG làm phiền user.

## Output

### Mode SPEC
- Artifact `api_test_cases.md` với đầy đủ 12 Status Codes, 7 loại Test Scenarios, OWASP Security, Test Data Matrix.

### Mode FULL
- Tất cả output của Mode SPEC, cộng thêm source code automation hoàn chỉnh, chạy PASS 100%.