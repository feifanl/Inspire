import './layout.css';
import type { DashboardModule, ModuleContext, PanelId, PanelPlace, QuotePos, Settings, SideLR } from '../../core/types';
import { h, clamp } from '../../core/dom';

// Layout editor. Placement is pure CSS: applyLayout() mirrors settings.layout
// onto <html> (data-quote-pos / data-todo-side, plus data-free-<panel> and
// --p-<panel>-x/-y/-scale for panels placed by hand) and layout.css positions
// the panels off those. Editing works on a *draft* of that shape: the pencil
// opens the editor, the ‹ › buttons step between panels, and only the panel
// being moved stays on screen (layout.css hides the others off data-edit). The
// focused panel can be dragged anywhere and scaled from the corner grip; the
// quote and tasks also keep their dock zones, which snap them back into place.
// Nothing is written to settings until the green check (or Enter); the red ×
// (or Esc, or a keybind opening another overlay) restores the saved layout.
// Clicks elsewhere are swallowed rather than ending the edit.

type Target = PanelId;
type Layout = Settings['layout'];

interface Zone {
  value: string; // QuotePos | SideLR
  where: string; // shown on the zone
  cls: string; // geometry class
}

const ZONES: Partial<Record<Target, Zone[]>> = {
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
  lifeclock: '.mod-lifeclock',
};
const PANELS = Object.keys(PANEL_SEL) as Target[];

const NAME: Record<Target, string> = { quote: 'Quote', todo: 'Tasks', search: 'Search bar', lifeclock: 'Life clock' };

const HINT: Record<Target, string> = {
  quote: 'Drag it anywhere, or click a spot to dock it. Corner grip resizes.',
  todo: 'Drag it anywhere, or click a side to dock it. Corner grip resizes.',
  search: 'Drag it anywhere. Corner grip resizes.',
  lifeclock: 'Drag it anywhere. Corner grip resizes.',
};

// Which point of a panel x/y pins down (x is always its horizontal centre).
// Chosen so each panel grows the way it naturally does: the quote card opens
// upward from its tab, the task list and the clock's views grow downward.
const ANCHOR: Record<Target, 'top' | 'center' | 'bottom'> = {
  quote: 'bottom',
  todo: 'top',
  search: 'center',
  lifeclock: 'top',
};

const SCALE_MIN = 0.5;
const SCALE_MAX = 2;

// The dashboard is scaled by --z (main.ts installZoom); the editor overlay sits
// inside that canvas, so screen px / z = overlay px.
function zoom(): number {
  const z = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--z'));
  return z > 0 ? z : 1;
}

// Fold the legacy search height into panels.search so everything downstream
// only deals with one shape.
function normalize(l: Layout): Layout {
  if (l.searchY == null || l.panels.search.x != null) return l;
  return { ...l, searchY: null, panels: { ...l.panels, search: { ...l.panels.search, x: 50, y: l.searchY } } };
}

function isFree(p: PanelPlace): boolean {
  return p.x != null && p.y != null;
}

// Writes a layout (saved or draft) onto <html>. Everything positional reads off
// these; see layout.css. Exported for main.ts, which applies the saved layout at
// boot and whenever settings change.
export function applyLayout(raw: Layout): void {
  const l = normalize(raw);
  const root = document.documentElement;
  root.dataset.quotePos = l.quotePos;
  root.dataset.todoSide = l.todoSide;
  for (const id of PANELS) {
    const p = l.panels[id];
    const flag = `free${id.charAt(0).toUpperCase()}${id.slice(1)}`; // data-free-<id>
    if (isFree(p)) {
      root.dataset[flag] = 'on';
      root.style.setProperty(`--p-${id}-x`, `${p.x}%`);
      root.style.setProperty(`--p-${id}-y`, `${p.y}%`);
    } else {
      delete root.dataset[flag];
      root.style.removeProperty(`--p-${id}-x`);
      root.style.removeProperty(`--p-${id}-y`);
    }
    if (p.scale && p.scale !== 1) root.style.setProperty(`--p-${id}-scale`, String(p.scale));
    else root.style.removeProperty(`--p-${id}-scale`);
  }
}

let ctx: ModuleContext;
let host: HTMLElement;
let editing = false;
let draft: Layout | null = null;
let focus: Target = 'quote';
let overlay: HTMLElement | null = null;
let grip: HTMLElement | null = null;
let scaleLabel: HTMLElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | undefined;
let onDocClick: ((e: MouseEvent) => void) | undefined;
let onDown: ((e: PointerEvent) => void) | undefined;
let onResize: (() => void) | undefined;

function panel(t: Target): HTMLElement | null {
  return document.querySelector<HTMLElement>(PANEL_SEL[t]);
}

// The box that actually gets positioned. The tasks panel lives in the fixed
// sidebar slot, so that's what moves; every other panel moves itself.
function moveEl(t: Target): HTMLElement | null {
  return t === 'todo' ? document.querySelector<HTMLElement>('.slot-sidebar') : panel(t);
}

// Only panels actually on screen join the cycle (a hidden quote or search bar
// has an empty host box).
function targets(): Target[] {
  return PANELS.filter((t) => {
    const el = panel(t);
    return !!el && el.getBoundingClientRect().height > 0;
  });
}

// Only the focused panel keeps .le-movable; layout.css hides the other movable
// panels and dims the rest of the dashboard while data-edit is on, so the zones
// sit on an otherwise quiet screen.
function markPanels(): void {
  for (const t of PANELS) {
    panel(t)?.classList.toggle('le-movable', editing && t === focus);
  }
  if (editing) document.documentElement.dataset.editFocus = focus;
  else delete document.documentElement.dataset.editFocus;
}

// Is this event target part of the editor (its overlay, its buttons, or the
// panel being moved)? Everything else is inert while editing.
function inEditor(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.('.layout-edit, .layout-btns, .le-movable');
}

// ---- draft plumbing ----

function setPlace(t: Target, patch: Partial<PanelPlace>): void {
  if (!draft) return;
  draft = { ...draft, panels: { ...draft.panels, [t]: { ...draft.panels[t], ...patch } } };
  applyLayout(draft);
  render();
}

// Docking a panel into a zone also drops any free position it had.
function setQuote(v: QuotePos): void {
  if (!draft) return;
  draft = { ...draft, quotePos: v };
  setPlace('quote', { x: null, y: null });
}
function setTodo(v: SideLR): void {
  if (!draft) return;
  draft = { ...draft, todoSide: v };
  setPlace('todo', { x: null, y: null });
}

// A panel's anchor point (see ANCHOR) in screen px, from where it sits now.
function anchorPx(t: Target): { x: number; y: number } | null {
  const el = moveEl(t);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const y = ANCHOR[t] === 'top' ? r.top : ANCHOR[t] === 'bottom' ? r.bottom : r.top + r.height / 2;
  return { x: r.left + r.width / 2, y };
}

function toPct(px: number, span: number): number {
  return clamp(Math.round((px / span) * 1000) / 10, 0, 100);
}

// ---- overlay ----

// A dock zone is only its label chip, centred where the dock is: the zone box
// itself is transparent to the pointer, so a docked panel under it can still be
// grabbed and dragged. The dock the panel already occupies gets no chip at all
// (the panel sitting there says so) — null.
function zoneEl(z: Zone, target: 'quote' | 'todo'): HTMLElement | null {
  const docked = !!draft && !isFree(draft.panels[target]);
  const here = docked && (target === 'quote' ? draft?.quotePos === z.value : draft?.todoSide === z.value);
  if (here) return null;
  const dock = () => (target === 'quote' ? setQuote(z.value as QuotePos) : setTodo(z.value as SideLR));
  const label = h(
    'div',
    {
      class: 'le-zone-label',
      role: 'button',
      tabindex: '0',
      title: `Dock the ${NAME[target].toLowerCase()} ${target === 'quote' ? 'at the' : 'on the'} ${z.where}`,
      onClick: dock,
    },
    h('span', { class: 'le-zone-name' }, `${NAME[target]} · ${z.where}`),
    h('span', { class: 'le-zone-hint' }, 'Click to dock here'),
  );
  label.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    dock();
  });
  return h('div', { class: `le-zone ${z.cls}` }, label);
}

// Park the resize grip on the focused panel's bottom-right corner.
function placeGrip(): void {
  const el = panel(focus);
  if (!grip || !el) return;
  const r = el.getBoundingClientRect();
  const z = zoom();
  grip.style.left = `${r.right / z}px`;
  grip.style.top = `${r.bottom / z}px`;
}

function fmtScale(s: number): string {
  return `${Math.round(s * 100)}%`;
}

// Scale from the corner grip: the new size tracks how far the pointer is from
// the panel's anchor compared with where the drag started, so pulling away
// grows it and pushing in shrinks it. Painted straight onto the CSS variable
// while dragging; the draft is written once on release.
function gripEl(): HTMLElement {
  const g = h('div', { class: 'le-grip', title: 'Drag to resize · double-click to reset size' });
  g.addEventListener('pointerdown', (e) => {
    if (!draft || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const t = focus;
    const s0 = draft.panels[t].scale || 1;
    const a = anchorPx(t);
    if (!a) return;
    const d0 = Math.max(24, Math.hypot(e.clientX - a.x, e.clientY - a.y));
    let s = s0;
    try {
      g.setPointerCapture(e.pointerId);
    } catch {
      /* capture is an optimisation */
    }
    g.classList.add('active');
    const move = (ev: PointerEvent) => {
      const d = Math.hypot(ev.clientX - a.x, ev.clientY - a.y);
      s = clamp(Math.round(((s0 * d) / d0) * 20) / 20, SCALE_MIN, SCALE_MAX);
      document.documentElement.style.setProperty(`--p-${t}-scale`, String(s));
      if (scaleLabel) scaleLabel.textContent = fmtScale(s);
      placeGrip();
    };
    const up = () => {
      g.classList.remove('active');
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      setPlace(t, { scale: s });
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', () => setPlace(focus, { scale: 1 }));
  return g;
}

// Pointer-drag the focused panel anywhere. On the first move a docked panel is
// lifted into free placement at exactly where it sits, so it slides from its
// current spot instead of jumping. Moves by the pointer delta (keeping the grab
// offset) and writes CSS variables per move; the draft waits for release.
function startPanelDrag(e: PointerEvent): void {
  if (!editing || !draft) return;
  // Same rule as clicks: presses outside the editor don't start a pin drag etc.
  if (!inEditor(e.target)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.button !== 0) return;
  const t = focus;
  const el = panel(t);
  if (!el || !el.contains(e.target as Node)) return;
  e.preventDefault();
  const a = anchorPx(t);
  if (!a) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const x0 = toPct(a.x, W);
  const y0 = toPct(a.y, H);
  const sx = e.clientX;
  const sy = e.clientY;
  let x = x0;
  let y = y0;
  let lifted = isFree(draft.panels[t]);
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* capture is an optimisation; the window listeners below do the work */
  }
  el.classList.add('le-sliding');
  const root = document.documentElement.style;
  let moved = false;
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 3) return;
    moved = true;
    if (!lifted) {
      lifted = true;
      draft = { ...draft!, panels: { ...draft!.panels, [t]: { ...draft!.panels[t], x: x0, y: y0 } } };
      applyLayout(draft);
    }
    x = toPct(a.x + ev.clientX - sx, W);
    y = toPct(a.y + ev.clientY - sy, H);
    root.setProperty(`--p-${t}-x`, `${x}%`);
    root.setProperty(`--p-${t}-y`, `${y}%`);
    placeGrip();
  };
  const up = () => {
    el.classList.remove('le-sliding');
    // window, not the element: the pointer routinely leaves the panel mid-drag
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (!moved) return; // a plain click: nothing moved
    setPlace(t, { x, y }); // commit the gesture: draft + one overlay rebuild
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

// Rebuilds the overlay for the focused panel: its dock zones (if it has any),
// the resize grip, and the toolbar naming it and its position in the cycle.
function render(): void {
  renderButtons();
  if (!overlay || !draft) return;
  const list = targets();
  const idx = Math.max(0, list.indexOf(focus));
  const place = draft.panels[focus];
  const moved = isFree(place) || place.scale !== 1;
  scaleLabel = h('span', { class: 'le-bar-scale', title: 'Size' }, fmtScale(place.scale || 1));
  const bar = h(
    'div',
    { class: 'le-bar' },
    h('span', { class: 'le-bar-name' }, `${NAME[focus]} · ${idx + 1}/${list.length}`),
    h('span', { class: 'le-bar-hint' }, HINT[focus]),
    scaleLabel,
    moved
      ? h(
          'button',
          {
            class: 'le-bar-reset',
            title: 'Back to its default spot and size',
            onClick: () => setPlace(focus, { x: null, y: null, scale: 1 }),
          },
          'Reset',
        )
      : null,
    list.length > 1 ? h('span', { class: 'le-bar-next' }, '‹ › switches panel') : null,
  );
  const zones =
    focus === 'quote' || focus === 'todo'
      ? (ZONES[focus] ?? []).map((z) => zoneEl(z, focus as 'quote' | 'todo')).filter((el) => el != null)
      : [];
  grip = gripEl();
  overlay.replaceChildren(bar, ...zones, grip);
  markPanels();
  placeGrip();
}

function open(): void {
  const list = targets();
  if (!list.length) return;
  editing = true;
  draft = normalize({ ...ctx.settings.layout });
  focus = list[0];
  document.documentElement.dataset.edit = 'on';
  overlay = h('div', { class: 'layout-edit' });
  (document.querySelector('.zoom-root') ?? document.body).appendChild(overlay);
  render();
  requestAnimationFrame(() => overlay?.classList.add('open'));
  onDown = startPanelDrag;
  window.addEventListener('pointerdown', onDown, true);
  onResize = placeGrip;
  window.addEventListener('resize', onResize);
  // Only the check or the × ends editing, so a stray click must do nothing at
  // all: clicks outside the editor and the focused panel are swallowed before
  // they reach the wall (pin links), help, or anything else. Capture, so this
  // runs ahead of the target's own handlers.
  onDocClick = (e: MouseEvent) => {
    if (inEditor(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
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
  grip = null;
  scaleLabel = null;
  markPanels();
  if (onDocClick) {
    window.removeEventListener('click', onDocClick, true);
    onDocClick = undefined;
  }
  if (onDown) {
    window.removeEventListener('pointerdown', onDown, true);
    onDown = undefined;
  }
  if (onResize) {
    window.removeEventListener('resize', onResize);
    onResize = undefined;
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
      help: 'Or press the pencil button (bottom-right) to drag any panel anywhere and resize it. A panel dragged off its dock ignores these until you Reset it there.',
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
