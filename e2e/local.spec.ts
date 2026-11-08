import { expect, test } from '@playwright/test';
import { LOCAL, acceptDialogs, connectSimulator, generateSurfacing, testImage, zeroAll } from './helpers';

test('the dev server runs in USB mode, not Pi mode', async ({ page }) => {
  await page.goto(LOCAL);
  await expect(page.locator('#btn-connect')).toHaveText('Connect USB');
  await expect(page.locator('#conn-badge')).toHaveText('Disconnected');
  await expect(page.locator('#pi-section')).toBeHidden();
});

test('carve a placed linocut, run it, stop it and pick it up part-way', async ({ page }) => {
  const dialogs = acceptDialogs(page);
  await page.goto(LOCAL);
  await connectSimulator(page);
  // Connecting restarts the board, so the old zero can't be trusted.
  await expect(page.locator('#zero-warning')).toContainText('X, Y and Z');
  await zeroAll(page);

  await page.setInputFiles('#image-file', { name: 'lino.png', mimeType: 'image/png', buffer: await testImage(page) });
  await page.fill('#img-width', '40');
  await page.fill('#place-x', '10');
  await page.fill('#place-y', '5');
  await page.selectOption('#place-rotation', '90');
  await page.click('#btn-generate');
  await expect(page.locator('#generate-message')).toContainText('Made 2 files');
  // 40 × 20 mm turned a quarter turn becomes 20 wide and 40 tall, starting at (10, 5).
  await expect(page.locator('#run-stats')).toContainText(/^(2\d|30)\.\d × 4\d\.\d mm/);

  await page.click('#btn-start');
  await expect(page.locator('#run-time')).toContainText('running');
  await page.click('[data-ov="feedPlus"]');
  await expect(page.locator('#ov-feed')).toHaveText('110%');
  await page.click('[data-ov="feedReset"]');
  await page.waitForTimeout(1500);
  await page.click('#btn-stop');
  await expect(page.locator('#run-time')).toContainText('stopped');

  await page.click('#btn-start-from');
  await expect(page.locator('#run-time')).toContainText('running');
  await expect(page.locator('#run-name')).toContainText('(from line');
  expect(dialogs.some((d) => d.includes('The last run got to about line'))).toBe(true);
  await page.click('#btn-stop');
  await expect(page.locator('#run-time')).toContainText('stopped');
});

test('travel limits catch a job that runs off the end', async ({ page }) => {
  const dialogs = acceptDialogs(page);
  await page.goto(LOCAL);
  await connectSimulator(page);
  await page.click('#btn-set-reference');
  await expect(page.locator('#limits-status')).toContainText('Set from the reference corner');
  await page.selectOption('#jog-step', '10');
  await page.click('.jog-z-minus');
  await page.click('.jog-z-minus');
  await page.selectOption('#jog-step', '50');
  for (let i = 0; i < 5; i++) await page.click('.jog-x-plus');
  await expect(page.locator('#machine-state')).toHaveText('Idle');
  await zeroAll(page);
  await generateSurfacing(page, 120, 30);
  await expect(page.locator('#run-limits')).toContainText('past the X+ end');
  await page.click('#btn-trace');
  expect(dialogs.at(-1)).toContain('past the X+ end');
});
