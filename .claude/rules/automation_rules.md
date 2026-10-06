# Quy Tắc Chung cho QA Automation

> Áp dụng cho mọi tác vụ automation testing, bất kể framework (Playwright, Selenium, Appium).

## 1. Kiến Trúc & Framework

- Bắt buộc sử dụng mô hình **Page Object Model (POM)**.
- Phân tách rõ ràng:
  - **Page classes:** Khai báo locators + methods tương tác UI
  - **Test classes:** Chứa logic kiểm thử + assertions
  - **Test data:** Tách riêng khỏi code chức năng (JSON, DataProvider, Utils)
- Assertions chỉ đặt trong Test classes, KHÔNG đặt trong Page classes.

## 2. Sinh Dữ Liệu Test (Test Data)

- Tất cả trường yêu cầu unique (Email, Username, Mã KH...) **phải sinh động**, không hardcode.
- Sử dụng UUID, Timestamp hoặc thư viện Faker.
- Dữ liệu phải **traceable** — nhìn vào DB biết ngay test nào tạo ra:
  ```
  Format: [prefix]_[testName]_[timestamp]_[random]
  Ví dụ:  auto_createCustomer_20260402_A3F2@test.com
  ```
- Hỗ trợ chạy parallel: mỗi test method có data riêng biệt, không conflict.
- **Tài khoản đăng nhập:** KHÔNG hardcode username/email/tên hiển thị của account test trong script (locator,
  assertion, filter, description). Tên account phải đọc từ nguồn đăng nhập **lúc chạy** — token/session hoặc config
  `.env` — và gọi trong thân test (sau bước setup đăng nhập), không gọi lúc nạp file.
  - Playwright TS: `getAccountDisplayName(role)` (`src/utils/auth-token.ts`) — `role` = `submitter` / `approver`…
  - Lý do: account test đổi theo môi trường/đợt test; tên ghi cứng làm fail hàng loạt dù logic test không sai.

## 3. Chất Lượng Code

- Không logic trùng lặp — tạo helper methods cho các hành động lặp đi lặp lại.
- Code phải đơn giản, dễ đọc, dễ bảo trì.
- Trước khi deliver code:
  - Xóa toàn bộ `console.log`, `System.out.println`, `print()` sinh ra khi debug
  - Xóa code bị comment (`//`, `/* */`)
  - Xóa locator / biến không sử dụng (unused code)

## 4. Quản Lý File & Thư Mục

- KHÔNG tự động xóa file source khi chưa xác nhận với user.
- Kiểm tra cấu trúc thư mục hiện có trước khi tạo file mới — tránh duplicate.
- Đặt file đúng thư mục theo kiến trúc project (xem `.claude/skills/skills-framework-architect/SKILL.md` mục **Project Structure Templates**).

## 5. Quy Tắc Đặt Tên

### Java

| Thành phần | Quy tắc | Ví dụ |
|---|---|---|
| Page class | PascalCase + hậu tố `Page` | `LoginPage.java`, `CartPage.java` |
| Test class | PascalCase + hậu tố `Test` | `LoginTest.java`, `CartTest.java` |
| Test method | Bắt đầu bằng `test` + mô tả hành vi | `testLoginWithValidCredentials()` |
| Locator biến | lowerCamelCase + hậu tố mô tả element | `loginButton`, `usernameInput` |
| Utils class | PascalCase + mô tả chức năng | `DataGenerator.java`, `WaitHelper.java` |

### TypeScript / Playwright

| Thành phần | Quy tắc | Ví dụ |
|---|---|---|
| Page class | PascalCase + hậu tố `Page` | `LoginPage.ts`, `CartPage.ts` |
| Test file | kebab-case + `.spec.ts` | `login.spec.ts`, `cart.spec.ts` |
| Test block | `test('mô tả hành vi')` | `test('đăng nhập thành công')` |
| Locator biến | lowerCamelCase hoặc readonly | `readonly loginButton` |
| Utils | PascalCase hoặc kebab-case | `DataGenerator.ts`, `data-generator.ts` |

## 6. Assertions (Kiểm Tra Kết Quả)

- Mỗi test case **BẮT BUỘC** có ít nhất 1 assertion ở cuối.
- Nên có assertion xen kẽ ở các bước quan trọng.
- Assert phải mô tả rõ expected behavior:
  ```java
  // Java/TestNG
  Assert.assertTrue(dashboardPage.isDisplayed(), "Dashboard phải hiển thị sau khi đăng nhập");
  ```
  ```typescript
  // Playwright
  await expect(page.getByText('Đăng nhập thành công')).toBeVisible();
  ```

### 6.1 Độ Phủ Assertion Theo Expected Results (BẮT BUỘC khi có TC nguồn)

> Nguyên tắc: **mọi ý** trong dòng Expected của TC phải có assertion tương ứng — hoặc được ghi rõ là *Not automated*.
> Không ý nào được "biến mất" lặng lẽ giữa TC và code.

**Bước 1 — Lập bảng phủ (coverage map) TRƯỚC khi viết assertion.** Tách từng dòng Expected thành các ý
(danh từ + điều kiện) và map mỗi ý → assertion → locator đã verify:

| Expected | Ý trong TC | Assertion | Locator (đã verify) |
|---|---|---|---|
| 1 | "every table column" | 7 `columnheader` theo **tên** | `list.columnHeader(name)` |
| 1 | "the pager" | total text + 페이지당 + Next + Last | `pagerTotalText`, `pageSizeSelect`… |
| 1 | "hints under the fields are not clipped" | mỗi hint: visible **và** không bị cắt | `pgHint`… + `isClipped()` |
| 2 | "long text shows a tooltip" | — | *Not automated* (ghi trong description) |

Bảng này không cần commit, nhưng **phải trình bày cho user** khi báo cáo nếu có ý Not automated hoặc lệch UI.

**Bước 2 — Quy tắc chuyển ý → assertion:**

| Cách TC diễn đạt | ❌ Assertion thiếu | ✅ Assertion đủ |
|---|---|---|
| "every / all X" (mọi cột, mọi field, mọi hint) | 1 assertion trên **container** (`table` visible) | **liệt kê từng X theo tên/nhãn** thật trên UI, assert từng cái |
| Nhóm có tên (pager, footer row, panel) | 1 phần tử đại diện | **mọi phần tử con** hiển thị trong nhóm đó |
| TC **liệt kê option** (các nút `뒤로 · 확인 및 저장`, các cột, các mã, các giá trị) | kiểm số lượng (`headers.length === 5`) hoặc 1 option | **1 assertion cho MỖI option** theo đúng tên TC/UI — số assertion ≥ số option liệt kê |
| Khối nội dung có tên ("the 변경 내용 block") | chỉ kiểm dialog mở | assert **từng thành phần** của khối (nhãn, giá trị cũ, giá trị mới…) |
| "fully visible" / "not clipped / cut off" | chỉ `toBeVisible()` | `toBeVisible()` **+** kiểm không bị cắt (`scrollWidth/Height ≤ clientWidth/Height`) |
| "does not overflow its container" | chỉ `toBeVisible()` | bounding box nằm trong khung chứa |
| "not pushed out of sight" / "fits in the viewport" | chỉ `toBeVisible()` | nằm trong viewport (`toBeInViewport()` hoặc so bounding box) |
| "no horizontal scrollbar" | — | `scrollWidth ≤ clientWidth` của `documentElement` |
| "clickable" | chỉ `toBeVisible()` | `toBeVisible()` + `toBeEnabled()` (+ trong viewport nếu TC nói về layout) |
| Giá trị / nội dung cụ thể | chỉ kiểm tồn tại | `toHaveText` / `toHaveValue` đúng giá trị TC ghi |

- Ý **cảm quan** không đo được (đọc được, không chồng lấn, bố cục đẹp, tooltip…) → *Not automated*: ghi vào
  `description` của test + nêu trong báo cáo cho user. **CẤM** thay bằng assertion yếu rồi coi như đã phủ.
- UI **có điều kiện** (field chỉ hiện khi WEEKLY…) → đọc trạng thái thật rồi assert theo nhánh, ghi rõ điều kiện
  trong code comment; không hardcode nhánh theo dữ liệu seed có thể bị đổi.

**Bước 3 — TC lệch UI thật:** số lượng/tên phần tử trên UI khác TC (VD TC ghi "three filters", UI có 4) →
assert đúng những gì **TC gọi tên**, **KHÔNG** tự ý sửa kỳ vọng cho khớp UI, và **báo user** để BA xác nhận.

**Bước 4 — Refactor / viết lại script:** **KHÔNG** bê nguyên assertion của code cũ sang — phải dựng lại bảng phủ
từ TC. Code cũ PASS không chứng minh nó phủ đủ TC.

**Bước 5 — Tự review trước khi xin chạy:** đọc lại từng dòng Expected, chỉ ra assertion nào phủ từng ý. Còn ý nào
không có assertion và cũng không được ghi *Not automated* = **chưa xong**, không được xin chạy test.

## 7. Report

Mọi script sinh ra phải tuân thủ [`reporting_rules.md`](reporting_rules.md): tên test + nội dung report bằng Tiếng Anh, Description/Severity/Tags/TC ID, step `Arrange`/`Act`/`Assert` trong Test Body (map 1-1 với dòng Steps/Expected của TC), screenshot cuối **mọi** test (cả PASS), KHÔNG attachment `stdout`.

## 8. Tính Độc Lập Của Test (Test Independence)

- Mỗi test case phải **độc lập** — không phụ thuộc kết quả test khác.
- Setup/teardown rõ ràng (`@BeforeMethod/@AfterMethod` hoặc `beforeEach/afterEach`).
- Không chia sẻ state giữa các test methods.