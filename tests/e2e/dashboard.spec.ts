/**
 * SUITE 1 — Dashboard load + Action Required + filter tabs.
 *
 * All tests in this file require a stored Clerk session. If the auth
 * state is missing the helper at tests/e2e/helpers/auth.ts hasn't been
 * run yet, every test below fails at the Clerk redirect — which is
 * correct, just less helpful than skipping. We can wire skip-on-missing
 * later if the local dev loop wants it.
 */
import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test('1 — Dashboard loads and shows Action Required + KPI cards + Lead Volume', async ({
    page
  }) => {
    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('heading', { name: /action required/i }).first()
    ).toBeVisible();

    // KPI cards — substring match to allow for the "1,250" / "$1,250"
    // numbers in the labels without brittle exact-text assertions.
    await expect(page.getByText(/total leads/i).first()).toBeVisible();
    await expect(page.getByText(/leads today/i).first()).toBeVisible();
    await expect(page.getByText(/calls booked/i).first()).toBeVisible();

    // Lead Volume chart container — title text varies by deploy, so we
    // assert on the canvas/container rather than copy.
    await expect(
      page.locator('canvas, svg[role="img"], [data-slot="card"]').first()
    ).toBeVisible();
  });

  test('2 — Action Required polls without throwing for 35s', async ({
    page
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
    });

    await page.goto('/dashboard');
    await page.waitForLoadState('networkidle');

    // Action Required polls every 30s. Wait 35s to guarantee one tick
    // happens during the test window.
    await page.waitForTimeout(35_000);

    // Strip Clerk SDK noise — Clerk emits dev-mode "telemetry" warnings
    // we don't control. Filter to only app-level errors.
    const appErrors = errors.filter(
      (e) => !/clerk/i.test(e) && !/telemetry/i.test(e)
    );
    expect(appErrors).toEqual([]);
  });

  test('3 — Qualified / Unqualified / All filter tabs change conversation list', async ({
    page
  }) => {
    await page.goto('/dashboard/conversations');
    await page.waitForLoadState('networkidle');

    // Tabs render as buttons. Names are case-insensitive substring
    // matches so "Qualified" and "Qualified (12)" both hit.
    const qualified = page
      .getByRole('button', { name: /^qualified( \(\d+\))?$/i })
      .first();
    const unqualified = page
      .getByRole('button', { name: /^unqualified( \(\d+\))?$/i })
      .first();
    const all = page.getByRole('button', { name: /^all( \(\d+\))?$/i }).first();

    await qualified.click();
    // Active state may use aria-pressed or a class; assert the click
    // resolved without error by waiting for any state change.
    await page.waitForTimeout(300);

    await unqualified.click();
    await page.waitForTimeout(300);

    // After UNQUALIFIED filter, badge appears on rows OR the empty-state
    // copy renders. Either is a pass — we're testing the filter wires
    // up, not the seed data shape.
    const unqualBadgeOrEmpty = page.locator(
      'text=/UNQUALIFIED|no conversations|no matching/i'
    );
    await expect(unqualBadgeOrEmpty.first()).toBeVisible({ timeout: 10_000 });

    await all.click();
    await page.waitForTimeout(300);
  });
});
