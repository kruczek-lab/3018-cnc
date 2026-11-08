import { expect, test } from '@playwright/test';
import { LOCAL, connectSimulator, generateSurfacing } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

test('quick taps on buttons neither zoom the page nor select their labels', async ({ page }) => {
  await page.goto(LOCAL);
  await connectSimulator(page);
  const jog = page.locator('.jog-x-plus');
  await jog.scrollIntoViewIfNeeded();
  for (let i = 0; i < 4; i++) {
    await jog.tap();
    await jog.tap();
  }
  await page.locator('[data-cmd="G10 L20 P1 X0"]').tap();
  await page.locator('[data-cmd="G10 L20 P1 X0"]').tap();
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
  expect(await page.evaluate(() => String(window.getSelection()))).toBe('');
  const style = await jog.evaluate((b) => getComputedStyle(b));
  expect(style.userSelect).toBe('none');
  expect(style.touchAction).toBe('manipulation');
});

test('text boxes are large enough that iPhones don\'t zoom in on them', async ({ page }) => {
  await page.goto(LOCAL);
  for (const id of ['#img-width', '#job-type', '#console-input', '#jog-feed']) {
    expect(await page.locator(id).evaluate((el) => parseFloat(getComputedStyle(el).fontSize)), id).toBeGreaterThanOrEqual(16);
  }
});

test('two fingers pinch to zoom the preview', async ({ page }) => {
  await page.goto(LOCAL);
  await generateSurfacing(page, 60, 40);
  const canvas = page.locator('#preview');
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const zoom = async () => Number(await canvas.getAttribute('data-zoom'));
  await page.waitForTimeout(300);
  const before = await zoom();
  const cdp = await page.context().newCDPSession(page);
  const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', spread: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x: cx - spread, y: cy, id: 1 }, { x: cx + spread, y: cy, id: 2 }],
    });
  await touch('touchStart', 20);
  for (let spread = 30; spread <= 120; spread += 15) await touch('touchMove', spread);
  await touch('touchEnd', 0);
  await page.waitForTimeout(300);
  // Fingers moved from 40 px to 240 px apart: about six times closer.
  expect((await zoom()) / before).toBeGreaterThan(5);
  expect((await zoom()) / before).toBeLessThan(7);
  // The page itself didn't zoom: the gesture went to the preview.
  expect(await page.evaluate(() => window.visualViewport!.scale)).toBe(1);
});
