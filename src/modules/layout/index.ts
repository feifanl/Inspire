import './layout.css';
import type { DashboardModule, ModuleContext, QuotePos, Settings, SideLR } from '../../core/types';
import { h, clamp } from '../../core/dom';

// Layout editor. Placement is pure CSS: applyLayout() mirrors settings.layout
// onto <html> (data-quote-pos / data-todo-side / --search-y) and layout.css
// positions the panels off those. Editing works on a *draft* of that shape: the
// pencil opens the editor, the ‹ › buttons step between panels, and only the
// panel being moved stays on screen (layout.css hides the others off
// data-edit). Nothing is written to settings until the green check; the red
// × (or Esc, or anything else opening) restores the saved layout.

type Target = 'quote' | 'todo' | 'search';

interface Zone {
  value: string; // QuotePos | SideLR
  where: string; // shown on the zone
  cls: string; // geometry class
}

const ZONES: Record<'quote' | 'todo', Zone[]> = {
  quote: [
    { value: 'top', where: 'top', cls: 'le-q-top' },
    { value: 'center', where: 'center', cls: 'le-q-center' },
    { value: 'bottom', where: 'bottom', cls: 'le-q-bottom' },
  ],
  todo: [
    { value: 'left', where: 'left', cls: 'le-t-left' },
    { value: 'right', where: 'right', cls: 'le-t-right' },
  ],
};

const PANEL_SEL: Record<Target, string> = {
  quote: '.mod-quote',
  todo: '.mod-todo',
  search: '.mod-search',
};

const NAME: Record<Target, string> = { quote: 'Quote', todo: 'Tasks', search: 'Search bar' };

const HINT: Record<Target, string> = {
  quote: 'Click a spot to move the quote there.',
  todo: 'Click a side to move the task list there.',
  search: 'Drag the search bar up or down, or click the line.',
};

// How far the search bar may travel down the centre line, as a % of the screen.
const SEARCH_MIN = 5;
const SEARCH_MAX = 94;

// Writes a layout (saved or draft) onto <html>. Everything positional reads off
// these three; see layout.css. Exported for main.ts, which applies the saved
// layout at boot and whenever settings change.
export function applyLayout(l: Settings['layout']): void {
  const root = document.documentElement;
  root.dataset.quotePos = l.quotePos;
  root.dataset.todoSide = l.todoSide;
  if (l.searchY == null) {
    delete root.dataset.searchPos; // default: in the centred column, above the clock
    root.style.removeProperty('--search-y');
  } else {
    root.dataset.searchPos = 'free';
    root.style.setProperty('--search-y', `${l.searchY}%`);
  }
}

let ctx: ModuleContext;
let host: HTMLElement;
let editing = false;
let draft: Settings['layout'] | null = null;
let focus: Target = 'quote';
let overlay: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | undefined;
let onDocClick: ((e: MouseEvent) => void) | undefined;
let marker: HTMLElement | null = null; // the rail marker, moved directly while dragging

function panel(t: Target): HTMLElement | null {
  return document.querySelector<HTMLElement>(PANEL_SEL[t]);
}

// Only panels actually on screen join the cycle (a hidden quote or search bar
// has an empty host box).
function targets(): Target[] {
  return (Object.keys(PANEL_SEL) as Target[]).filter((t) => {
    const el = panel(t);
    return !!el && el.getBoundingClientRect().height > 0;
  });
}

// Only the focused panel keeps .le-movable; layout.css hides the other movable
// panels and dims the rest of the dashboard while data-edit is on, so the zones
// sit on an otherwise quiet screen.
function markPanels(): void {
  for (const t of Object.keys(PANEL_SEL) as Target[]) {
    panel(t)?.classList.toggle('le-movable', editing && t === focus);
  }
  if (editing) document.documentElement.dataset.editFocus = focus;
  else delete document.documentElement.dataset.editFocus;
}

// ---- draft plumbing ----

function setQuote(v: QuotePos): void {
  if (!draft) return;
  draft = { ...draft, quotePos: v };
  applyLayout(draft);
  render();
}
function setTodo(v: SideLR): void {
  if (!draft) return;
  draft = { ...draft, todoSide: v };
  applyLayout(draft);
  render();
}
function clampPct(pct: number): number {
  return clamp(Math.round(pct * 10) / 10, SEARCH_MIN, SEARCH_MAX);
}

function setSearchY(pct: number | null): void {
  if (!draft) return;
  draft = { ...draft, searchY: pct == null ? null : clampPct(pct) };
  applyLayout(draft);
  render();
}

// The search bar's current centre as a % of the viewport — the starting point
// when it has never been placed by hand.
function searchPct(): number {
  if (draft?.searchY != null) return draft.searchY;
  const el = panel('search');
  if (!el) return 12;
  const r = el.getBoundingClientRect();
  return clamp(((r.top + r.height / 2) / window.innerHeight) * 100, SEARCH_MIN, SEARCH_MAX);
}

// ---- overlay ----

function zoneEl(z: Zone, target: 'quote' | 'todo'): HTMLElement {
  const here = target === 'quote' ? draft?.quotePos === z.value : draft?.todoSide === z.value;
  const el = h(
    'div',
    {
      class: `le-zone ${z.cls}${here ? ' current' : ''}`,
      role: 'button',
      tabindex: '0',
      title: `${NAME[target]} — ${z.where}`,
      onClick: () =>
        target === 'quote' ? setQuote(z.value as QuotePos) : setTodo(z.value as SideLR),
    },
    h(
      'div',
      { class: 'le-zone-label' },
      h('span', { class: 'le-zone-name' }, `${NAME[target]} · ${z.where}`),
      h('span', { class: 'le-zone-hint' }, here ? 'Currently here' : 'Click to move here'),
    ),
  );
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (target === 'quote') setQuote(z.value as QuotePos);
    else setTodo(z.value as SideLR);
  });
  return el;
}

// The search bar isn't a set of slots: it slides anywhere along the screen's
// vertical centre line, so its "zone" is that line plus a marker at the current
// height. Clicking the line jumps there; dragging the bar itself is wired in
// armSearchDrag().
function trackEl(): HTMLElement {
  marker = h('div', { class: 'le-track-marker', style: { top: `${searchPct()}%` } });
  const track = h('div', { class: 'le-track', title: 'Click to move the search bar here' }, marker);
  track.addEventListener('click', (e) => setSearchY((e.clientY / window.innerHeight) * 100));
  return track;
}

// Cheap per-frame write used while dragging: move the bar and the rail marker
// only. The draft (and the overlay rebuild that follows it) waits for pointerup
// — rebuilding the toolbar and rail on every pointermove made the bar lag the
// cursor badly.
function paintSearchY(pct: number): void {
  document.documentElement.style.setProperty('--search-y', `${pct}%`);
  if (marker) marker.style.top = `${pct}%`;
}

// Pointer-drag the search bar along the line, keeping the grab offset so the
// bar doesn't jump to centre under the cursor. The host element outlives every
// edit session, so this is wired once and gates itself on the current focus.
let searchArmed = false;
function armSearchDrag(): void {
  const el = panel('search');
  if (!el || searchArmed) return;
  searchArmed = true;
  el.addEventListener('pointerdown', (e) => {
    if (!editing || focus !== 'search' || !draft) return;
    e.preventDefault();
    const r = el.getBoundingClientRect();
    const grab = e.clientY - (r.top + r.height / 2);
    // Lift it into the fixed dock at exactly where it sits now, so the first
    // move slides from the current spot instead of jumping out of the column.
    if (draft.searchY == null) {
      draft = { ...draft, searchY: clampPct(searchPct()) };
      applyLayout(draft);
    }
    let pct = draft.searchY ?? clampPct(searchPct());
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is an optimisation; the window listeners below do the work */
    }
    el.classList.add('le-sliding');
    // Written straight through (two style writes; the browser already coalesces
    // pointermove to one per frame) so the bar tracks the cursor exactly.
    const move = (ev: PointerEvent) => {
      pct = clampPct(((ev.clientY - grab) / window.innerHeight) * 100);
      paintSearchY(pct);
    };
    const up = () => {
      el.classList.remove('le-sliding');
      // window, not the element: the pointer routinely leaves the bar mid-drag
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      setSearchY(pct); // commit the gesture: draft + one overlay rebuild
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
}

// Rebuilds the overlay for the focused panel: its zones (or the search line),
// plus the toolbar naming it and its position in the cycle.
function render(): void {
  renderButtons();
  if (!overlay || !draft) return;
  const list = targets();
  const idx = Math.max(0, list.indexOf(focus));
  const bar = h(
    'div',
    { class: 'le-bar' },
    h('span', { class: 'le-bar-name' }, `${NAME[focus]} · ${idx + 1}/${list.length}`),
    h('span', { class: 'le-bar-hint' }, HINT[focus]),
    focus === 'search' && draft.searchY != null
      ? h('button', { class: 'le-bar-reset', onClick: () => setSearchY(null) }, 'Reset')
      : null,
    list.length > 1 ? h('span', { class: 'le-bar-next' }, '‹ › switches panel') : null,
  );
  const body =
    focus === 'search' ? [trackEl()] : ZONES[focus].map((z) => zoneEl(z, focus as 'quote' | 'todo'));
  overlay.replaceChildren(bar, ...body);
  markPanels();
}

function open(): void {
  const list = targets();
  if (!list.length) return;
  editing = true;
  draft = { ...ctx.settings.layout };
  focus = list[0];
  document.documentElement.dataset.edit = 'on';
  overlay = h('div', { class: 'layout-edit' });
  (document.querySelector('.zoom-root') ?? document.body).appendChild(overlay);
  armSearchDrag();
  render();
  requestAnimationFrame(() => overlay?.classList.add('open'));
  // Anything outside the editor — the gear, the notes buttons, help, the wall —
  // means the user moved on, so the draft is dropped. Capture, so it runs before
  // the target's own handler opens whatever it opens. The focused panel itself
  // is exempt: it is what's being moved.
  onDocClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement | null;
    if (!el || el.closest('.layout-edit') || el.closest('.layout-btns') || el.closest('.le-movable')) return;
    cancel();
  };
  window.addEventListener('click', onDocClick, true);
}

// Step to the previous/next panel in the cycle (the ‹ › buttons).
function step(dir: -1 | 1): void {
  const list = targets();
  if (!list.length) return;
  const i = list.indexOf(focus);
  focus = list[(i + dir + list.length) % list.length];
  render();
}

function close(): void {
  editing = false;
  draft = null;
  delete document.documentElement.dataset.edit;
  delete document.documentElement.dataset.editFocus;
  overlay?.remove();
  overlay = null;
  marker = null;
  markPanels();
  if (onDocClick) {
    window.removeEventListener('click', onDocClick, true);
    onDocClick = undefined;
  }
  renderButtons();
}

function commit(): void {
  if (!editing || !draft) return;
  const saved = draft;
  close();
  ctx.saveSettings({ layout: saved });
}

function cancel(): void {
  if (!editing) return;
  close();
  applyLayout(ctx.settings.layout); // undo the preview
}

// ---- proximity reveal for hidden collapsed handles ----
// With ui.hideCollapsed on, the tab/handle a collapsed panel leaves behind is
// invisible. Requiring a direct hover to find it is a guessing game, so the
// cursor fades each one in as it gets close: full strength within NEAR_FULL px
// of the handle's box, gone again past NEAR_FADE. The distance drives --near-op,
// which layout.css reads as the handle's opacity.
const HANDLE_SEL = '.quote-tab:not(.open), .todo-handle, .lc-pill';
const NEAR_FULL = 56;
const NEAR_FADE = 190;

let nearOn = false;
let nearX = -1;
let nearY = -1;

// Shortest distance from a point to a rect (0 when inside it).
function distToRect(r: DOMRect, x: number, y: number): number {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

function paintNear(): void {
  for (const el of document.querySelectorAll<HTMLElement>(HANDLE_SEL)) {
    const d = distToRect(el.getBoundingClientRect(), nearX, nearY);
    const op = d <= NEAR_FULL ? 1 : d >= NEAR_FADE ? 0 : (NEAR_FADE - d) / (NEAR_FADE - NEAR_FULL);
    el.style.setProperty('--near-op', String(Math.round(op * 100) / 100));
  }
}

// Written straight through rather than via requestAnimationFrame: rAF is
// throttled when the tab isn't painting, which would leave the handles stuck at
// their last opacity. At most three tiny fixed elements are measured, and a
// small movement threshold skips the sub-pixel jitter.
function onNearMove(e: PointerEvent): void {
  if (Math.abs(e.clientX - nearX) < 3 && Math.abs(e.clientY - nearY) < 3) return;
  nearX = e.clientX;
  nearY = e.clientY;
  paintNear();
}

// Watch the pointer only while the setting is on; clear the inline opacity when
// it goes off so the handles return to their normal look.
function syncProximity(on: boolean): void {
  if (on === nearOn) return;
  nearOn = on;
  if (on) {
    window.addEventListener('pointermove', onNearMove);
    return;
  }
  window.removeEventListener('pointermove', onNearMove);
  nearX = -1;
  nearY = -1;
  for (const el of document.querySelectorAll<HTMLElement>('.quote-tab, .todo-handle, .lc-pill')) {
    el.style.removeProperty('--near-op');
  }
}

// ---- corner buttons: the pencil, swapped for ‹ › + confirm/cancel while editing ----

function icon(paths: string, extra = ''): HTMLElement {
  const span = document.createElement('span');
  span.className = 'le-icon';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${paths}</svg>`;
  return span;
}

function renderButtons(): void {
  if (!editing) {
    host.replaceChildren(
      h(
        'div',
        { class: 'layout-btns' },
        h(
          'button',
          {
            class: 'layout-btn pencil',
            title: 'Move panels',
            'aria-label': 'Move panels',
            onClick: open,
          },
          icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
        ),
      ),
    );
    return;
  }
  const many = targets().length > 1;
  host.replaceChildren(
    h(
      'div',
      { class: 'layout-btns' },
      h(
        'button',
        {
          class: 'layout-btn step',
          title: 'Previous panel',
          'aria-label': 'Previous panel',
          disabled: !many,
          onClick: () => step(-1),
        },
        icon('<path d="M15 5 8 12l7 7"/>'),
      ),
      h(
        'button',
        {
          class: 'layout-btn step',
          title: 'Next panel',
          'aria-label': 'Next panel',
          disabled: !many,
          onClick: () => step(1),
        },
        icon('<path d="m9 5 7 7-7 7"/>'),
      ),
      h(
        'button',
        { class: 'layout-btn ok', title: 'Save layout (Enter)', 'aria-label': 'Save layout', onClick: commit },
        icon('<path d="M5 12.5 10 17.5 19 6.5"/>'),
      ),
      h(
        'button',
        { class: 'layout-btn no', title: 'Discard changes (Esc)', 'aria-label': 'Discard changes', onClick: cancel },
        icon('<path d="M6 6l12 12"/><path d="M18 6 6 18"/>'),
      ),
    ),
  );
}

export const layout: DashboardModule = {
  id: 'layout',
  slot: 'overlay',
  order: 15, // left of the help button (order 20)
  settingsSchema: [
    {
      key: 'layout.quotePos',
      label: 'Quote position',
      type: 'select',
      options: [
        { value: 'top', label: 'Top' },
        { value: 'center', label: 'Center (in the column)' },
        { value: 'bottom', label: 'Bottom' },
      ],
    },
    {
      key: 'layout.todoSide',
      label: 'Tasks side',
      type: 'select',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'right', label: 'Right' },
      ],
      help: 'Or press the pencil button (bottom-right) and click where each panel should go.',
    },
    {
      key: 'layout.searchY',
      label: 'Search bar height (%)',
      type: 'text',
      placeholder: 'Default',
      help: `Distance down the screen, ${SEARCH_MIN}-${SEARCH_MAX}. Blank keeps it in the centre column, above the life clock.`,
      parse: (raw) => {
        const n = Number(raw.trim());
        return raw.trim() === '' || Number.isNaN(n) ? null : clamp(n, SEARCH_MIN, SEARCH_MAX);
      },
    },
    {
      key: 'ui.hideCollapsed',
      label: 'Hide collapsed handles',
      type: 'toggle',
      help: 'Fades out the tab or handle a collapsed panel leaves behind. It stays where it was — hover the spot to bring it back.',
    },
  ],

  init(c) {
    ctx = c;
    onKey = (e) => {
      if (!editing) return;
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter') commit();
    };
    window.addEventListener('keydown', onKey);
    // Overlays opened by a keybind (B) never share the screen with the editor.
    c.bus.on('open-notes-board', cancel);
    c.bus.on('open-settings', cancel);
    syncProximity(c.settings.ui.hideCollapsed);
    c.bus.on('settings-changed', () => syncProximity(c.settings.ui.hideCollapsed));
  },

  render(el) {
    host = el;
    renderButtons();
  },

  destroy() {
    if (onKey) window.removeEventListener('keydown', onKey);
    syncProximity(false);
    cancel();
  },
};
