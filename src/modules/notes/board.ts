import type { ModuleContext, NoteColor, StickyNote } from '../../core/types';
import { h } from '../../core/dom';

const NOTES_KEY = 'notes';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Free-canvas geometry. CARD_W must match .note-card's width in notes.css;
// CARD_H is only an auto-placement estimate (real cards grow with their text).
const CARD_W = 220;
const CARD_H = 190;
const GAP = 24;
const CANVAS_PAD = 40; // slack kept past the furthest note so the canvas can grow

// Persistence helpers (single storage key "notes", a StickyNote[]).
export function loadNotes(ctx: ModuleContext): Promise<StickyNote[]> {
  return ctx.storage.get<StickyNote[]>(NOTES_KEY, []);
}
export function saveNotes(ctx: ModuleContext, notes: StickyNote[]): Promise<void> {
  return ctx.storage.set(NOTES_KEY, notes);
}
export function addNote(list: StickyNote[], text: string, color: NoteColor): StickyNote[] {
  const note: StickyNote = { id: crypto.randomUUID(), text: text.slice(0, 500), color, createdAt: Date.now() };
  return [note, ...list];
}
export function updateNote(list: StickyNote[], id: string, text: string): StickyNote[] {
  return list.map((n) => (n.id === id ? { ...n, text: text.slice(0, 500) } : n));
}

// Do two CARD_W x CARD_H boxes at these origins overlap (gutter included)?
function hits(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.abs(ax - bx) < CARD_W + GAP / 2 && Math.abs(ay - by) < CARD_H + GAP / 2;
}

// Give every note without saved coordinates a free slot, scanning the canvas
// row by row and skipping cells already taken. Covers notes made before drag
// existed, and every freshly composed note. Returns true if anything moved.
export function ensurePositions(notes: StickyNote[], canvasWidth: number): boolean {
  const cols = Math.max(1, Math.floor((canvasWidth + GAP) / (CARD_W + GAP)));
  const taken = notes.filter((n) => n.x != null && n.y != null).map((n) => [n.x!, n.y!] as const);
  let changed = false;
  for (const n of notes) {
    if (n.x != null && n.y != null) continue;
    // Unbounded downward scan: the canvas grows, so a free slot always exists.
    for (let row = 0; ; row++) {
      let placed = false;
      for (let col = 0; col < cols; col++) {
        const x = col * (CARD_W + GAP);
        const y = row * (CARD_H + GAP);
        if (taken.some(([tx, ty]) => hits(x, y, tx, ty))) continue;
        n.x = x;
        n.y = y;
        taken.push([x, y]);
        placed = true;
        break;
      }
      if (placed) break;
    }
    changed = true;
  }
  return changed;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Full-screen board overlay in .slot-overlay. Opens on 'open-notes-board',
// closes on Esc / x / backdrop. Notes reload from storage each open so freshly
// saved notes appear. onChange lets the caller refresh its count badge.
export function mountBoard(ctx: ModuleContext, onChange: () => void): void {
  const overlay = document.querySelector<HTMLElement>('.slot-overlay');
  if (!overlay) return;

  let notes: StickyNote[] = [];
  let open = false;
  let closing = false; // true while the close fade is running (before detach)
  let editingId: string | null = null; // note whose text is being edited inline
  let topZ = 1; // monotonic stacking counter — the last-dragged note sits on top

  // .notes-grid scrolls; .notes-canvas is the positioned surface inside it.
  const canvas = h('div', { class: 'notes-canvas' });
  const grid = h('div', { class: 'notes-grid' }, canvas);
  const backdrop = h('div', { class: 'notes-backdrop', onClick: close });
  const panel = h(
    'div',
    { class: 'notes-board' },
    h(
      'div',
      { class: 'notes-board-head' },
      h('h2', { class: 'notes-board-title' }, 'Notes'),
      h('span', { class: 'notes-board-hint' }, 'Drag to arrange'),
      h('button', { class: 'notes-board-close', title: 'Close (Esc)', 'aria-label': 'Close', onClick: close }, '✕'),
    ),
    grid,
  );
  const root = h('div', { class: 'notes-overlay' }, backdrop, panel);

  // Stretch the canvas past the furthest note so dragging outward keeps room
  // (and the scroll container knows how far it can go).
  function sizeCanvas(): void {
    const maxX = notes.reduce((m, n) => Math.max(m, n.x ?? 0), 0);
    const maxY = notes.reduce((m, n) => Math.max(m, n.y ?? 0), 0);
    canvas.style.minWidth = `${maxX + CARD_W + CANVAS_PAD}px`;
    canvas.style.minHeight = `${maxY + CARD_H + CANVAS_PAD}px`;
  }

  function render(): void {
    if (!notes.length) {
      canvas.replaceChildren(h('p', { class: 'notes-empty' }, 'No notes yet. Press + note to add one.'));
      canvas.style.minWidth = '';
      canvas.style.minHeight = '';
      return;
    }
    canvas.replaceChildren(...notes.map((n) => (editingId === n.id ? editCard(n) : viewCard(n))));
    sizeCanvas();
    // focus the edit box (and drop the cursor at the end) once it's in the DOM
    if (editingId) {
      const ta = canvas.querySelector<HTMLTextAreaElement>('.note-card.editing .note-edit-text');
      if (ta) {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
    }
  }

  // Place a card at its stored coordinates.
  function position(card: HTMLElement, n: StickyNote): void {
    card.style.left = `${n.x ?? 0}px`;
    card.style.top = `${n.y ?? 0}px`;
  }

  // Pointer-drag a card around the canvas. The pointer is captured on press so
  // the card keeps tracking once the cursor leaves it — which also retargets
  // the trailing click to the card, so the tap-to-edit decision is made here
  // (from where the press landed) rather than by a handler on .note-text.
  const DRAG_SLOP = 4;
  function makeDraggable(card: HTMLElement, n: StickyNote, onTap: () => void): void {
    let startX = 0;
    let startY = 0;
    let originX = 0;
    let originY = 0;
    let down = false;
    let moved = false;
    let tapTarget = false; // press landed on the note text → a still click edits

    card.addEventListener('pointerdown', (e) => {
      // Buttons, links and the inline editor keep their own behaviour.
      if ((e.target as HTMLElement).closest('button, textarea, input, a')) return;
      if (e.button !== 0) return;
      down = true;
      moved = false;
      tapTarget = !!(e.target as HTMLElement).closest('.note-text');
      startX = e.clientX;
      startY = e.clientY;
      originX = n.x ?? 0;
      originY = n.y ?? 0;
      card.style.zIndex = String(++topZ);
      card.setPointerCapture(e.pointerId);
    });

    card.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      moved = true;
      card.classList.add('dragging');
      n.x = Math.max(0, originX + dx);
      n.y = Math.max(0, originY + dy);
      position(card, n);
    });

    const end = (e: PointerEvent) => {
      if (!down) return;
      down = false;
      if (card.hasPointerCapture(e.pointerId)) card.releasePointerCapture(e.pointerId);
      if (!moved) {
        if (tapTarget) onTap(); // pressed and released on the text without moving
        return;
      }
      moved = false;
      card.classList.remove('dragging');
      sizeCanvas();
      saveNotes(ctx, notes);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  // Static card. Clicking the text switches it into the edit form; dragging the
  // paper moves it.
  function viewCard(n: StickyNote): HTMLElement {
    const card = h(
      'div',
      { class: `note-card note-${n.color}`, 'data-id': n.id },
      h('button', {
        class: 'note-del',
        title: 'Delete',
        'aria-label': 'Delete note',
        onClick: () => remove(n.id),
      }, '×'),
      h('div', { class: 'note-text', title: 'Click to edit · drag to move' }, n.text),
      h('div', { class: 'note-date' }, fmtDate(n.createdAt)),
    );
    position(card, n);
    makeDraggable(card, n, () => beginEdit(n.id));
    return card;
  }

  // Edit form: textarea + Save/Cancel. Ctrl/Cmd+Enter saves, Esc cancels.
  function editCard(n: StickyNote): HTMLElement {
    const ta = h('textarea', {
      class: 'note-edit-text',
      maxlength: 500,
      value: n.text,
    }) as HTMLTextAreaElement;
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation(); // don't let Esc also close the board
        cancelEdit();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        commitEdit(n.id, ta.value);
      }
    });
    const card = h(
      'div',
      { class: `note-card note-${n.color} editing`, 'data-id': n.id },
      ta,
      h(
        'div',
        { class: 'note-edit-actions' },
        h('button', { onClick: cancelEdit }, 'Cancel'),
        h('button', { class: 'primary', onClick: () => commitEdit(n.id, ta.value) }, 'Save'),
      ),
      h('div', { class: 'note-date' }, fmtDate(n.createdAt)),
    );
    position(card, n);
    return card;
  }

  function beginEdit(id: string): void {
    editingId = id;
    render();
  }

  function cancelEdit(): void {
    editingId = null;
    render();
  }

  async function commitEdit(id: string, text: string): Promise<void> {
    const t = text.trim();
    editingId = null;
    if (t) {
      notes = updateNote(notes, id, t);
      await saveNotes(ctx, notes);
      onChange();
    }
    render();
  }

  async function commitRemove(id: string): Promise<void> {
    notes = notes.filter((n) => n.id !== id);
    await saveNotes(ctx, notes);
    render();
    onChange();
  }

  // Peel the card off (curl-up transition), then drop it from state. Skips the
  // animation under prefers-reduced-motion or if the element is already gone.
  function remove(id: string): void {
    const card = canvas.querySelector<HTMLElement>(`.note-card[data-id="${id}"]`);
    if (!card || reducedMotion) {
      commitRemove(id);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      card.removeEventListener('transitionend', onEnd);
      commitRemove(id);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === card && e.propertyName === 'transform') finish();
    };
    card.addEventListener('transitionend', onEnd);
    setTimeout(finish, 420); // guard a missed transitionend
    requestAnimationFrame(() => card.classList.add('peeling'));
  }

  async function show(): Promise<void> {
    notes = await loadNotes(ctx);
    editingId = null;
    if (!root.isConnected) overlay!.appendChild(root);
    // Lay out anything without saved coordinates against the live board width
    // (the panel is attached by now, so clientWidth is real).
    if (ensurePositions(notes, grid.clientWidth || CARD_W * 4)) await saveNotes(ctx, notes);
    render();
    if (open) return;
    open = true;
    closing = false; // cancel any pending close so it can't yank a reopened board
    // next frame so the opacity transition has a start state
    requestAnimationFrame(() => root.classList.add('open'));
  }

  function close(): void {
    if (!open) return;
    root.classList.remove('open');
    open = false;
    closing = true;
    // Only detach if we're still closing — a reopen during the fade clears the flag.
    const finish = () => {
      if (!closing) return;
      closing = false;
      root.removeEventListener('transitionend', onEnd);
      root.remove();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === root) finish();
    };
    root.addEventListener('transitionend', onEnd);
    setTimeout(finish, 260); // guard a missed transitionend
  }

  ctx.bus.on('open-notes-board', show);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) close();
  });
}
