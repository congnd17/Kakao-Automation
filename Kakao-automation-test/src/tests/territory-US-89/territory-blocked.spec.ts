import { test } from '@fixtures/territory.fixture';
import { skipTc, TcPriority } from '@utils/tc-meta';

/**
 * US089 — các TC không tự động hoá được trên dev hiện tại, skip kèm lý do trong report (quy tắc 28/09: TC thiếu điều kiện
 * → skip, ghi lý do). Nguồn TC: input/TESTCASE_US089_v3.1.md. Từ 29/09 cả 2 account đều có quyền ghi Territory, nên TC cần
 * vai trò CHỈ ĐỌC cũng thành không chạy được (không còn account chỉ đọc).
 */
const TAGS = ['ui', 'territory', 'territory-blocked'];
const NO_READ_ONLY =
  'needs an account with a READ-ONLY role on Territory: since 29/09 both available accounts (congnd17.fpt, dungbd.fpt) hold write access (the read-only notice is gone, 저장 enables and a direct PATCH is accepted — verified 29/09)';
const NO_DB = 'needs direct database access (queries, constraints, re-running the seed migration), which the suite does not have';
const NO_ROLES = 'needs accounts for roles that do not exist on this environment (STORE_MANAGER, LABEL_PARTNER, SYSTEM, a portal admin able to revoke permissions)';
const NO_ENV_CONTROL = 'needs control over the environment (stopping the change-history store, forcing a server error, switching the settlement cycle state, enabling query logging)';

const blocked: Array<{ tc: string; priority: TcPriority; title: string; description: string; reason: string }> = [
  { tc: 'TC_US089_02', priority: 'High', title: 'All five read-only roles get the same table, filters, pagination and change history as an ADMIN', description: 'SETTLEMENT_OPERATOR, INVENTORY_OPERATOR, APPROVER, MANAGER and BIPACEN_ADMIN (read-only) get the same list and history as an ADMIN.', reason: `${NO_READ_ONLY}; the other read-only roles have no account either` },
  { tc: 'TC_US089_03', priority: 'High', title: 'A read-only role cannot open a row, gets no pointer cursor and reads all four values from the table', description: 'The read-only notice shows, rows are not clickable and the change history still opens.', reason: NO_READ_ONLY },
  { tc: 'TC_US089_04', priority: 'High', title: 'Roles without the permission code see no menu item and cannot reach the screen by URL', description: 'STORE_MANAGER, LABEL_PARTNER and SYSTEM get no menu item and are blocked server-side.', reason: NO_ROLES },
  { tc: 'TC_US089_05', priority: 'High', title: 'A write sent straight to the server by an account without write access is refused', description: 'A direct PATCH from a read-only account is refused with AUTH-4031 and writes nothing.', reason: NO_READ_ONLY },
  { tc: 'TC_US089_06', priority: 'High', title: 'What a read-only role gets when navigating straight to the edit-screen URL', description: 'A read-only role opening the edit URL cannot save; the JP row stays unchanged.', reason: NO_READ_ONLY },
  { tc: 'TC_US089_14', priority: 'High', title: 'The register holds one row per ISO country code, records the count and the JDK version', description: 'Row count / codes match the ISO list in both directions; the seed records the count and JDK version.', reason: NO_DB },
  { tc: 'TC_US089_15', priority: 'High', title: 'The seeded defaults follow the running formula', description: 'Only KR is taxable with no declaration; every other row is zero-rated and requires a declaration (DB query).', reason: NO_DB },
  { tc: 'TC_US089_16', priority: 'Critical', title: 'Re-running the seed only inserts missing rows and never overwrites a person-set value', description: 'After deleting VN and re-running the seed, VN is recreated and JP keeps its edited value.', reason: `${NO_DB} (deleting a row and re-running the seed migration)` },
  { tc: 'TC_US089_17', priority: 'Medium', title: 'A seeded row carries version 1, SYSTEM, IP 0.0.0.0, six audit columns and no history', description: 'The VN row has version 1, created by SYSTEM at 0.0.0.0 and all six audit columns.', reason: NO_DB },
  { tc: 'TC_US089_18', priority: 'Low', title: 'The country alias table is created and ships empty', description: 'The alias table exists and holds 0 rows.', reason: NO_DB },
  { tc: 'TC_US089_58', priority: 'Medium', title: 'A create call and a delete call are both refused with 405 and the row survives', description: 'POST a new country / DELETE AQ are refused with 405.', reason: 'a DELETE call against a real country row is a destructive attempt on the shared environment — irreversible if the server accepted it, and the accounts now hold write access (decision: no destructive operations on the shared dev)' },
  { tc: 'TC_US089_59', priority: 'High', title: 'Editing works in all three settlement cycle states', description: 'Saves succeed with the cycle OPEN, CLOSED and LOCKED.', reason: NO_ENV_CONTROL },
  { tc: 'TC_US089_63', priority: 'Critical', title: 'A failed history write rolls the flag change back', description: 'With the history store down the save is refused with TER-1007 and nothing changes.', reason: NO_ENV_CONTROL },
  { tc: 'TC_US089_64', priority: 'High', title: 'An accepted orphan history record survives', description: 'An orphan history record inserted directly stays visible and is never cleaned up.', reason: `${NO_DB} (the fixture is inserted directly into the history store)` },
  { tc: 'TC_US089_65', priority: 'Medium', title: 'A server error or timeout leaves the dialog open and keeps every entry', description: 'A forced server error shows the retry message and keeps the dialog and entries.', reason: NO_ENV_CONTROL },
  { tc: 'TC_US089_66', priority: 'High', title: 'A permission revoked mid-session makes the next save be refused', description: 'After revoking MASTER_DATA in another session, Confirm and save is refused with AUTH-4031.', reason: NO_ROLES },
  { tc: 'TC_US089_68', priority: 'High', title: 'One save touches only the country row and one history record', description: 'Query / outbound-call logs show exactly two writes and no other data changed.', reason: NO_ENV_CONTROL },
  { tc: 'TC_US089_77', priority: 'Medium', title: 'What the dialog shows when the change-history store cannot be read', description: 'With the history store down, the dialog must differ from the empty "No changes yet" state.', reason: NO_ENV_CONTROL },
];

test.describe('[Blocked] US089 test cases that cannot run on this environment', () => {
  for (const item of blocked) {
    test(`${item.tc} — ${item.title}`, async () => {
      await skipTc(item.tc, item.priority, TAGS, item.description, item.reason);
    });
  }
});
