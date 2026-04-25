/**
 * SUITE 2 — Conversation list, conversation view, AI toggle, manual send.
 */
import { test, expect } from '@playwright/test';

test.describe('Conversations', () => {
  test('4 — Conversation list loads with at least one row', async ({
    page
  }) => {
    await page.goto('/dashboard/conversations');
    await page.waitForLoadState('networkidle');

    // Each row is a clickable button with the lead's name as primary
    // text. Wait for the list to settle, then assert >=1 row + an AI
    // toggle (visible only when a conversation is selected, but the
    // header AI status is always present once one row renders).
    const rows = page.locator(
      'button[class*="conv-item"], button:has(.conv-name)'
    );
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });

    // Lead name selector is intentionally loose — anything inside .conv-name.
    const firstName = page.locator('.conv-name').first();
    await expect(firstName).toBeVisible();
    expect((await firstName.textContent())?.trim().length ?? 0).toBeGreaterThan(
      0
    );
  });

  test('5 — Opening a conversation reveals thread + input + sidebar', async ({
    page
  }) => {
    await page.goto('/dashboard/conversations');
    await page.waitForLoadState('networkidle');

    const firstRow = page.locator('button:has(.conv-name)').first();
    await firstRow.waitFor({ timeout: 15_000 });
    await firstRow.click();

    // Thread renders messages with role-or-text identifiers — settle
    // for the input box and at least one sidebar tab.
    await expect(
      page.getByPlaceholder(/type a message|message|reply/i).first()
    ).toBeVisible({ timeout: 10_000 });

    // Sidebar tabs vary slightly by deploy. Hit "Summary" if present;
    // fall back to "Stage" if it isn't named "Summary".
    const sidebarTab = page
      .getByRole('tab', { name: /summary|stage|score/i })
      .first();
    await expect(sidebarTab).toBeVisible({ timeout: 10_000 });
  });

  test('6 — AI toggle persists across reload', async ({ page }) => {
    await page.goto('/dashboard/conversations');
    await page.waitForLoadState('networkidle');
    const firstRow = page.locator('button:has(.conv-name)').first();
    await firstRow.click();

    // The AI toggle is a Switch / "Pause AI" / "AI On" control. Locate
    // by role + accessible name; the exact label varies per design.
    const toggle = page
      .getByRole('switch', { name: /ai/i })
      .or(
        page.getByRole('button', {
          name: /(ai (on|off|pause)|pause ai|enable ai)/i
        })
      )
      .first();
    await expect(toggle).toBeVisible({ timeout: 10_000 });

    const beforeChecked = (await toggle.getAttribute('aria-checked')) ?? 'null';
    const beforeText = (await toggle.textContent())?.trim() ?? '';

    await toggle.click();
    await page.waitForTimeout(800); // wait for PATCH to land

    await page.reload();
    await page.waitForLoadState('networkidle');
    const firstRowReloaded = page.locator('button:has(.conv-name)').first();
    await firstRowReloaded.click();

    const toggleAfter = page
      .getByRole('switch', { name: /ai/i })
      .or(
        page.getByRole('button', {
          name: /(ai (on|off|pause)|pause ai|enable ai)/i
        })
      )
      .first();
    await expect(toggleAfter).toBeVisible({ timeout: 10_000 });
    const afterChecked =
      (await toggleAfter.getAttribute('aria-checked')) ?? 'null';
    const afterText = (await toggleAfter.textContent())?.trim() ?? '';

    // State changed AND survived reload (different from `before` value).
    expect(
      afterChecked !== beforeChecked || afterText !== beforeText
    ).toBeTruthy();
  });

  test('7 — Human can send a message from the dashboard', async ({ page }) => {
    await page.goto('/dashboard/conversations');
    await page.waitForLoadState('networkidle');
    await page.locator('button:has(.conv-name)').first().click();

    const input = page
      .getByPlaceholder(/type a message|message|reply/i)
      .first();
    await input.waitFor({ timeout: 10_000 });
    const stamp = `e2e ping ${Date.now()}`;
    await input.fill(stamp);
    await input.press('Enter');

    // The new message appears in the thread. We match on the unique
    // timestamp so this test isn't flaky against existing messages.
    const stampedMessage = page.getByText(stamp).first();
    await expect(stampedMessage).toBeVisible({ timeout: 10_000 });

    // The "Human Setter" sender label is rendered for HUMAN messages.
    // Loose match — could be "Daniel · Human Setter" or just
    // "Human Setter" depending on whether sentByUserId is populated.
    await expect(page.getByText(/human setter/i).first()).toBeVisible();
  });
});
