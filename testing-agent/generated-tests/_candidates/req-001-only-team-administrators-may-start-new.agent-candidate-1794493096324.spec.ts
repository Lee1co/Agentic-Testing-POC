import { test, expect } from '../fixtures';

test('REQ-001: Only team administrators may start new discussions', async ({ page }) => {
  const suffix = Date.now();
  const teamName = `TeamReq001${suffix}`;
  const adminEmail = `admin${suffix}@test.com`;
  const memberEmail = `member${suffix}@test.com`;
  const password = 'Password1!';

  await test.step('Setup: team administrator registers and creates a team', async () => {
    await page.goto('/auth/register');
    await page.getByLabel('First Name').fill('Team');
    await page.getByLabel('Last Name').fill('Admin');
    await page.getByLabel('Email Address').fill(adminEmail);
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('Team Name').fill(teamName);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Your role is : ADMIN/ })).toBeVisible();
  });

  await test.step('Setup: regular member registers by joining the existing team', async () => {
    await page.getByRole('button', { name: 'Open user menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign Out' }).click();
    await page.getByRole('link', { name: 'Register' }).click();
    await page.getByRole('switch').check();
    await page.getByLabel('First Name').fill('Team');
    await page.getByLabel('Last Name').fill('Member');
    await page.getByLabel('Email Address').fill(memberEmail);
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('Team Name').fill(teamName);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome Team Member' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Your role is : USER/ })).toBeVisible();
  });

  await test.step('AC-1: member cannot create a discussion — Discussions page shown without Create Discussion action', async () => {
    await page.goto('/app/discussions');
    await expect(page).toHaveURL(/\/app\/discussions/);
    await expect(page.getByRole('heading', { name: 'Discussions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Discussion' })).not.toBeVisible();
  });

  await test.step('AC-2: team administrator has Create Discussion action on Discussions page', async () => {
    await page.getByRole('button', { name: 'Open user menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign Out' }).click();
    await page.goto('/auth/login');
    await page.getByLabel('Email Address').fill(adminEmail);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: /Your role is : ADMIN/ })).toBeVisible();
    await page.goto('/app/discussions');
    await expect(page.getByRole('heading', { name: 'Discussions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Discussion' })).toBeVisible();
  });
});
