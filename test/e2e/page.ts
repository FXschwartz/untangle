// Reading the page and returning it to the review's resting view. Clicks stay in the tests.
import type { Browser } from '../helpers/browser.ts';

export async function rest(page: Browser): Promise<void> {
  for (let i = 0; i < 4; i += 1) await page.key('Escape');
}

export async function read(page: Browser, expression: string): Promise<string> {
  return String(await page.eval(expression));
}

/**
 * Watches a box (a thread, a note, a file's comments) until the page draws it with other parts,
 * then sets window.__motion to how it moves: its own height easing, a stand-in of what went
 * closing (where, what it holds, from what height) and the parts fading in.
 */
export const motionOf = (box: string) => `(() => {
  const at = () => document.querySelector(${JSON.stringify(box)});
  const shape = (el) => (el ? [...el.children].map((part) => part.className.split(' ')[0]).filter((name) => name !== 'ghost').join() : 'none');
  const from = shape(at());
  window.__motion = null;
  const watch = new MutationObserver(() => {
    const el = at();
    if (shape(el) === from) return;
    watch.disconnect();
    const px = (a, i) => parseFloat(a.effect.getKeyframes().at(i).height).toFixed(1) + 'px';
    const tall = (part) => part.getAnimations().find((a) => a.effect.getKeyframes()[0].height != null);
    const fades = (part) => part.getAnimations().some((a) => a.effect.getKeyframes()[0].opacity != null);
    const name = (part) => part.className.split(' ')[0];
    const out = [];
    const eases = el && tall(el);
    if (eases) out.push('it eases from ' + px(eases, 0) + ' to ' + px(eases, -1));
    const ghost = el && el.querySelector(':scope > .ghost');
    if (ghost) {
      const where = ghost.previousElementSibling ? 'after ' + name(ghost.previousElementSibling) : 'before ' + name(ghost.nextElementSibling);
      out.push('a stand-in ' + where + ', holding ' + [...ghost.children].map(name).join(', ') + ', closes from ' + px(tall(ghost), 0) + (fades(ghost) ? ', fading' : ''));
    }
    const fading = el ? [...el.children].filter((part) => part !== ghost && fades(part)).map(name) : [];
    if (fading.length) out.push(fading.join(', ') + ' fade in');
    window.__motion = out.join('; ') || 'still';
  });
  watch.observe(document.querySelector('#vw-main'), { childList: true, subtree: true });
})()`;

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
