import { test, expect } from '../fixtures';

test('Validate REQ-001: Only team administrators may start new discussions', async ({ page }) => {
  const suffix = Date.now();
  const teamName = `TeamREQ001_${suffix}`;
  const adminEmail = `admin.req001.${suffix}@test.com`;
  const memberEmail = `member.req001.${suffix}@test.com`;
  const password = 'Password1!';

  await test.step('Setup: register team administrator (ADMIN)', async () => {
    await page.goto('/auth/register');
    await expect(page.getByRole('heading', { name: 'Register your account' })).toBeVisible();
    await page.getByLabel('First Name').fill('Admin');
    await page.getByLabel('Last Name').fill('Founder');
    await page.getByLabel('Email Address').fill(adminEmail);
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('Team Name').fill(teamName);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Your role is : ADMIN/ })).toBeVisible();
  });

  await test.step('Setup: register member joining existing team (USER)', async () => {
    await page.getByRole('button', { name: 'Open user menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Sign Out' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Sign Out' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    await page.goto('/auth/register');
    await expect(page.getByRole('heading', { name: 'Register your account' })).toBeVisible();
    await page.getByRole('switch').click();
    await expect(page.getByRole('switch')).toBeChecked();
    await page.getByLabel('First Name').fill('Member');
    await page.getByLabel('Last Name').fill('User');
    await page.getByLabel('Email Address').fill(memberEmail);
    await page.getByLabel('Password').fill(password);
    await page.getByLabel('Team Name').fill(teamName);
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome Member User' })).toBeVisible();
  });

  await test.step('AC-1: member cannot create a discussion', async () => {
    await page.goto('/app/discussions');
    await expect(page).toHaveURL(/\/app\/discussions/);
    await expect(page.getByRole('heading', { name: 'Discussions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Discussion' })).not.toBeVisible();
  });

  await test.step('Setup: sign in as team administrator', async () => {
    await page.getByRole('button', { name: 'Open user menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Sign Out' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Sign Out' }).click();
    await expect(page).toHaveURL(/\/auth\/login/);
    await page.getByLabel('Email Address').fill(adminEmail);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('heading', { name: /Your role is : ADMIN/ })).toBeVisible();
  });

  await test.step('AC-2: administrator can create a discussion', async () => {
    await page.goto('/app/discussions');
    await expect(page).toHaveURL(/\/app\/discussions/);
    await expect(page.getByRole('heading', { name: 'Discussions' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Discussion' })).toBeVisible();
  });
});
