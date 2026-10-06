import { test } from '@playwright/test';
import { allure } from 'allure-playwright';

/** Priority của manual TC → Severity Allure (Critical→blocker, High→critical, Medium/Edge→normal, Low→minor). */
export type TcPriority = 'Critical' | 'High' | 'Medium' | 'Low';

const SEVERITY: Record<TcPriority, string> = { Critical: 'blocker', High: 'critical', Medium: 'normal', Low: 'minor' };

/** Khai báo đủ metadata report cho 1 TC: Description, Severity, Tags, TC ID (reporting_rules.md mục 1). */
export async function tcMeta(testId: string, priority: TcPriority, tags: string[], description: string): Promise<void> {
  await allure.description(description);
  await allure.severity(SEVERITY[priority]);
  await allure.tags('regression', ...tags);
  await allure.label('testId', testId);
}

/** TC không tự động hoá được trên môi trường này — vẫn có metadata + lý do skip hiện trong report. */
export async function skipTc(testId: string, priority: TcPriority, tags: string[], description: string, reason: string): Promise<void> {
  await tcMeta(testId, priority, tags, `${description} Not automated: ${reason}`);
  test.skip(true, reason);
}
