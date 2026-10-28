import { expect, type Page } from '@playwright/test';

/**
 * DESIGN D3 (AC-X-6): every visible control on the page is at least 44 × 44 px. Links inside a
 * sentence are exempt (WCAG 2.5.8's inline exception).
 */
export async function expectTapTargets(page: Page, screen: string): Promise<void> {
  const small = await page.evaluate(() => {
    const MIN = 44;
    const selector =
      'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="switch"], [role="tab"], [role="radio"], [role="checkbox"]';
    const found: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
      // A native checkbox or radio inside its label: the label is the target.
      const label = element.closest('label');
      const target = label !== null && element instanceof HTMLInputElement ? label : element;
      const rect = target.getBoundingClientRect();
      // A link in running text: the sentence around it is the target (WCAG 2.5.8).
      const inline =
        element.tagName === 'A' &&
        style.display === 'inline' &&
        (element.parentElement?.textContent ?? '').trim() !== element.textContent.trim();
      if (inline) continue;
      if (rect.width + 0.5 < MIN || rect.height + 0.5 < MIN) {
        const text = element.textContent.trim().slice(0, 40);
        const name = element.getAttribute('aria-label') ?? (text === '' ? element.tagName : text);
        found.push(
          `${element.tagName.toLowerCase()} "${name}" ${String(Math.round(rect.width))}×${String(Math.round(rect.height))}`,
        );
      }
    }
    return found;
  });
  expect(small, `tap targets under 44 px on ${screen}`).toEqual([]);
}
