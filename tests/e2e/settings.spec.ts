/**
 * SUITE 4 — Settings pages render their core sections.
 */
import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test('11 — Persona Editor loads with key sections', async ({ page }) => {
    await page.goto('/dashboard/settings/persona-editor');
    await page.waitForLoadState('networkidle');

    // Loose substring matches — copy may evolve, but the IDEA of an
    // Admin Bio / Verified Facts / Scope sections should remain.
    await expect(
      page.getByText(/admin bio|owner bio|about you/i).first()
    ).toBeVisible({
      timeout: 15_000
    });
    await expect(
      page
        .getByText(/verified (facts|details)|known facts|verified info/i)
        .first()
    ).toBeVisible();
    await expect(
      page.getByText(/scope( & limits| limits|s &)/i).first()
    ).toBeVisible();

    // At least one save / update button somewhere on the page.
    await expect(
      page.getByRole('button', { name: /save|update/i }).first()
    ).toBeVisible();
  });

  test('12 — Notification Settings loads with toggles', async ({ page }) => {
    await page.goto('/dashboard/settings/notifications');
    await page.waitForLoadState('networkidle');

    // The page redesign (commit 4b42879) restructured into Urgent /
    // Activity / Email Reports groups. We assert the URGENT group
    // rendered + at least one toggle is interactive. "Push Notifications"
    // copy from the old layout was retired, so we don't assert on it.
    await expect(page.getByText(/urgent alerts/i).first()).toBeVisible({
      timeout: 15_000
    });

    const switches = page.getByRole('switch');
    await expect(switches.first()).toBeVisible();
    expect(await switches.count()).toBeGreaterThan(3);

    // Read-only "Notifications sent to:" line proves the account-email
    // display (Fix 1 from the notification-settings rework) is wired.
    await expect(
      page.getByText(/notifications sent to/i).first()
    ).toBeVisible();
  });
});
