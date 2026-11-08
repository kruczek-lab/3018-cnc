import { expect, test } from '@playwright/test';
import { PI, acceptDialogs, connectSimulator, generateSurfacing, zeroAll } from './helpers';

test('files and settings are shared between devices, and a job keeps running without the laptop', async ({ browser }) => {
  const laptop = await (await browser.newContext()).newPage();
  acceptDialogs(laptop);
  await laptop.goto(PI);
  await expect(laptop.locator('#conn-badge')).toContainText('Pi');
  await laptop.fill('#v-angle', '20');
  await laptop.locator('#v-angle').dispatchEvent('change');
  await generateSurfacing(laptop, 60, 40);
  await connectSimulator(laptop);
  await zeroAll(laptop);
  await laptop.click('#btn-start');
  await expect(laptop.locator('#run-time')).toContainText('running');
  await laptop.waitForTimeout(800); // let the settings reach the Pi
  await laptop.close();

  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })).newPage();
  acceptDialogs(phone);
  await phone.goto(PI);
  await expect(phone.locator('#run-time')).toContainText('running');
  await expect(phone.locator('#run-name')).toHaveText('surface-60x40.nc');
  await expect(phone.locator('.files .file-name').first()).toHaveText('surface-60x40.nc');
  await expect(phone.locator('#v-angle')).toHaveValue('20');
  // Nothing can be slipped into the running job, from the page or the API.
  await expect(phone.locator('#console-input')).toBeDisabled();
  const status = await phone.evaluate(async () =>
    (await fetch('api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio': '1' }, body: JSON.stringify({ line: 'G0 X0' }) })).status,
  );
  expect(status).toBe(409);
  await phone.click('#btn-pause');
  await expect(phone.locator('#machine-state')).toHaveText('Hold:0');
  await phone.click('#btn-stop');
  await expect(phone.locator('#run-time')).toContainText('stopped');
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);

  // Files stay on the Pi after every browser has gone.
  await phone.reload();
  await expect(phone.locator('.files .file-name').first()).toHaveText('surface-60x40.nc');
  await phone.locator('.files li.file').first().getByRole('button', { name: 'Remove' }).click();
  await expect(phone.locator('.files')).toContainText('Nothing yet.');
  await phone.click('#btn-disconnect');
});
