// Reading the page and returning it to the review's resting view. Clicks stay in the tests.
import type { Browser } from '../helpers/browser.ts';

export async function rest(page: Browser): Promise<void> {
  for (let i = 0; i < 4; i += 1) await page.key('Escape');
}

export async function read(page: Browser, expression: string): Promise<string> {
  return String(await page.eval(expression));
}

/** The page saves marks a moment after the click. Resolves when that save has been answered. */
export async function waitForSave(page: Browser): Promise<void> {
  const before = Number(await page.eval(`performance.getEntriesByType('resource').filter((entry) => String(entry.name).includes('api/state')).length`));
  await page.until(`performance.getEntriesByType('resource').filter((entry) => String(entry.name).includes('api/state')).length > ${before}`);
}

export function dayOf(iso: string): string {
  const date = new Date(iso);
  const withYear = date.getFullYear() !== new Date().getFullYear();
  return date.toLocaleDateString('en-US', withYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' });
}

export function whenOf(iso: string): string {
  const time = new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${dayOf(iso)}, ${time}`;
}

export function fullWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'short',
  });
}

export const historySubjects = `[...document.querySelectorAll('.hs-s')].map((el) => el.textContent).join('\\n')`;

export const historyDots = `[...document.querySelectorAll('.hs-row')].flatMap((row) => {
  const subject = row.querySelector('.hs-s')?.textContent;
  if (!subject) return [];
  const dot = [...(row.querySelector('.dot')?.classList ?? [])].filter((name) => name !== 'dot').join(' ');
  return [subject + ' | ' + dot];
}).join('\\n')`;

export function dotOf(dots: string, subject: string): string {
  const line = dots.split('\n').find((item) => item.startsWith(`${subject} | `));
  if (!line) throw new Error(`no row for ${subject}\n${dots}`);
  return line.slice(subject.length + 3);
}
