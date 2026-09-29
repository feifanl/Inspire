import './tour.css';
import type { DashboardModule, ModuleContext } from '../../core/types';
import { h } from '../../core/dom';

// Guided first-run tour. Each step spotlights one element on the page; steps
// whose element isn't on screen (a panel turned off, notes disabled) are
// skipped. It runs once after a fresh install (background.ts sets TOUR_KEY on
// install) and again whenever Help's "Take the tour" emits 'start-tour'.
export const TOUR_KEY = 'tourPending';

// body is HTML — our own copy, never user input.
interface Step {
  target?: string; // CSS selector; none = centred card over a dimmed page
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    title: 'Welcome to Inspire',
    body:
      '<p>A calmer new tab: a life clock, today’s tasks, a daily quote, sticky notes, and a wall of images that inspire you.</p>' +
      '<p><b>Everything stays in your browser.</b> There’s no account and no server of ours; the only outside calls are ones you switch on, like Trello sync or a Google Photos album.</p>',
  },
  {
    target: '.mod-search .search-bar',
    title: 'Search',
    body: '<p>Focused on every new tab: type and press <kbd>Enter</kbd>. Pick Google, DuckDuckGo, Brave or Bing in settings.</p>',
  },
  {
    target: '.mod-lifeclock .lc-root',
    title: 'Life clock',
    body:
      '<p>How much of today, this week, month and year has already gone. Scroll over it or use <kbd>−</kbd> <kbd>+</kbd> to zoom between views.</p>' +
      '<p>Add your birthday in settings to unlock the decade and life views.</p>',
  },
  {
    target: '.mod-todo',
    title: 'Today’s tasks',
    body:
      '<p>Type a task and press <kbd>Enter</kbd>. Set a priority, drag to reorder, click one to add notes or a link.</p>' +
      '<p>Optionally mirror a Trello list, so tasks follow you everywhere.</p>',
  },
  {
    target: '.mod-quote .quote, .quote-tab', // the card when open, else just its tab
    title: 'Daily quote',
    body: '<p>Pull up this tab for a quote of the day. Write your own in settings and they join the rotation.</p>',
  },
  {
    target: '.mod-notes',
    title: 'Sticky notes',
    body: '<p><b>+ note</b> jots one down; the arrow opens the board, where notes can be dragged anywhere. Press <kbd>B</kbd> to open it from anywhere.</p>',
  },
  {
    target: '.layout-btns',
    title: 'Arrange the page',
    body: '<p>The pencil opens move mode: drag and resize the search bar, clock, tasks and quote, then press the check to keep it.</p>',
  },
  {
    target: '.settings-gear',
    title: 'Make it yours',
    body:
      '<p>Settings hold the rest: wallpapers (including a Google Photos album that shuffles through your photos), a pins wall of images, theme and liquid glass.</p>' +
      '<p>Right-click any image on the web to add it to a pins board.</p>',
  },
  {
    target: '.help-btn',
    title: 'Help',
    body: '<p>The full guide, with every setting and shortcut. You can replay this tour from there any time.</p>',
  },
];

const PAD = 6; // spotlight margin around the target
const GAP = 12; // space between spotlight and card
const EDGE = 16; // min distance from the card to the window edge

let ctx: ModuleContext;
let root: HTMLElement | null = null;
let spot: HTMLElement;
let card: HTMLElement;
let index = 0;
let settle: ReturnType<typeof setTimeout> | undefined;

function rectOf(step: Step): DOMRect | null {
  if (!step.target) return null;
  const r = document.querySelector(step.target)?.getBoundingClientRect();
  return r && r.width && r.height ? r : null;
}

// Next (or previous) step whose element is on screen; -1 / STEPS.length past the ends.
function neighbour(dir: 1 | -1): number {
  let i = index + dir;
  while (i > 0 && i < STEPS.length && !rectOf(STEPS[i])) i += dir;
  return i;
}

function go(dir: 1 | -1): void {
  const i = neighbour(dir);
  if (i >= STEPS.length) return close();
  index = Math.max(0, i);
  draw();
}

function draw(): void {
  if (!root) return;
  const step = STEPS[index];
  const r = rectOf(step);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(360, vw - EDGE * 2);
  const last = neighbour(1) >= STEPS.length;

  const next = h(
    'button',
    { class: 'primary', onClick: () => (last ? close() : go(1)) },
    last ? 'Done' : index === 0 ? 'Show me around' : 'Next',
  );
  card.replaceChildren(
    h(
      'div',
      { class: 'tour-top' },
      h('span', { class: 'tour-count' }, `${index + 1} of ${STEPS.length}`),
      last ? null : h('button', { class: 'tour-skip', onClick: close }, 'Skip tour'),
    ),
    h('h3', { class: 'tour-title' }, step.title),
    h('div', { class: 'tour-body' }),
    h('div', { class: 'tour-actions' }, index > 0 ? h('button', { onClick: () => go(-1) }, 'Back') : null, next),
  );
  card.querySelector('.tour-body')!.innerHTML = step.body;

  // No target: shrink the spotlight to a point mid-screen (the whole page dims)
  // and centre the card a little above the middle.
  if (!r) {
    spot.classList.add('none');
    Object.assign(spot.style, { top: `${vh / 2}px`, left: `${vw / 2}px`, width: '0px', height: '0px' });
    Object.assign(card.style, { width: `${w}px`, left: `${(vw - w) / 2}px`, top: `${vh * 0.26}px`, bottom: '' });
  } else {
    spot.classList.remove('none');
    const s = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    Object.assign(spot.style, { top: `${s.top}px`, left: `${s.left}px`, width: `${s.width}px`, height: `${s.height}px` });

    // Card goes below the target, else above it, else beside it.
    const clampX = (x: number) => Math.min(Math.max(EDGE, x), vw - w - EDGE);
    const centred = clampX(s.left + s.width / 2 - w / 2);
    const below = s.top + s.height + GAP;
    const est = card.offsetHeight || 200; // measured after the first paint
    let pos: Record<string, string>;
    if (below + est + EDGE < vh) {
      pos = { left: `${centred}px`, top: `${below}px`, bottom: '' };
    } else if (s.top - GAP - est > EDGE) {
      pos = { left: `${centred}px`, top: '', bottom: `${vh - s.top + GAP}px` };
    } else {
      const right = s.left + s.width + GAP;
      const x = right + w + EDGE <= vw ? right : s.left - GAP - w;
      pos = { left: `${clampX(x)}px`, top: `${Math.max(EDGE, Math.min(s.top, vh - est - EDGE))}px`, bottom: '' };
    }
    Object.assign(card.style, { width: `${w}px`, ...pos });
  }
  next.focus({ preventScroll: true });
}

// Captured first so the page's own shortcuts (Esc closing settings, arrow keys
// on the clock) don't also fire while the tour is up.
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowRight') go(1);
  else if (e.key === 'ArrowLeft') go(-1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

function onResize(): void {
  draw();
}

function start(): void {
  if (root) return;
  // Close whatever is open so the spotlight lands on the dashboard itself.
  document.querySelector<HTMLElement>('.settings-backdrop.open')?.click();
  document.querySelector<HTMLElement>('.help-backdrop')?.click();

  index = 0;
  spot = h('div', { class: 'tour-spot none' });
  card = h('div', { class: 'tour-card' });
  root = h('div', { class: 'tour', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tutorial' }, spot, card);
  // Outside the zoom root: the card stays full size however small the window.
  document.body.appendChild(root);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  draw();
}

function close(): void {
  if (!root) return;
  clearTimeout(settle);
  root.remove();
  root = null;
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  ctx.storage.remove(TOUR_KEY);
}

export const tour: DashboardModule = {
  id: 'tour',
  slot: 'overlay',
  order: 30,
  settingsSchema: [],

  async init(c) {
    ctx = c;
    ctx.bus.on('start-tour', start);
    // First run: let the panels finish their entrance animations before
    // measuring them.
    if (await ctx.storage.get<boolean>(TOUR_KEY, false)) settle = setTimeout(start, 700);
  },

  render() {
    /* nothing on screen until the tour starts */
  },

  destroy() {
    close();
  },
};
