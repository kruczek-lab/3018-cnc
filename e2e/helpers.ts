import { expect, type Page } from '@playwright/test';

export const LOCAL = 'http://localhost:5180/';
export const PI = 'http://localhost:8030/';

/** Accepts every dialog (prompts with their suggested value) and records the messages. */
export function acceptDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on('dialog', (d) => {
    seen.push(d.message());
    void d.accept(d.type() === 'prompt' ? d.defaultValue() : undefined);
  });
  return seen;
}

export async function connectSimulator(page: Page) {
  await page.click('#btn-simulator');
  await expect(page.locator('#machine-state')).toHaveText('Idle');
}

/** Sets X/Y and Z zero (clears the "zero may have moved" warning after connecting). */
export async function zeroAll(page: Page) {
  await page.click('[data-cmd="G10 L20 P1 X0 Y0"]');
  await page.click('#btn-zero-paper');
  await expect(page.locator('#zero-warning')).toBeHidden();
}

/** A bold black-and-white test picture, made in the page. */
export async function testImage(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 200;
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 400, 200);
    g.fillStyle = '#000';
    g.fillRect(30, 30, 120, 140);
    g.lineWidth = 20;
    g.beginPath();
    g.arc(280, 100, 60, 0, Math.PI * 2);
    g.stroke();
    return c.toDataURL('image/png');
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

export async function generateSurfacing(page: Page, width = 40, height = 30) {
  await page.selectOption('#job-type', 'surface');
  await page.fill('#s-width', String(width));
  await page.fill('#s-height', String(height));
  await page.click('#btn-generate');
  await expect(page.locator('#generate-message')).toContainText('Made 1 file');
}
