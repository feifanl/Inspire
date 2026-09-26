import type { Priority, Todo } from '../../core/types';

// Offline-first Trello client. Every call has a 2 s timeout and returns
// null / swallows on ANY failure — callers treat that as "offline, stay local".
export interface TrelloConfig {
  key: string;
  token: string;
  listId: string;
}

const BASE = 'https://api.trello.com/1';
const TIMEOUT = 2000;

function auth(cfg: TrelloConfig): string {
  return `key=${encodeURIComponent(cfg.key)}&token=${encodeURIComponent(cfg.token)}`;
}

interface TrelloLabel {
  name?: string;
}
interface TrelloAttachment {
  id: string;
  url: string;
  isUpload?: boolean;
}
interface TrelloCard {
  id: string;
  name: string;
  desc?: string;
  shortUrl?: string;
  attachments?: TrelloAttachment[];
  labels?: TrelloLabel[];
  dueComplete?: boolean; // Trello's card-level "done" checkmark (needs a due date to toggle in-app)
  pos?: number; // Trello's fractional card order within its list
}

interface TrelloList {
  id: string;
  name: string;
}

// Fetch open lists on a board → [{id, name}]. null on any failure.
// key/token only — no listId needed to enumerate a board's lists.
export async function trelloListsForBoard(
  key: string,
  token: string,
  boardId: string,
): Promise<TrelloList[] | null> {
  try {
    const q = `key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(`${BASE}/boards/${boardId}/lists?filter=open&fields=name&${q}`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    return (await res.json()) as TrelloList[];
  } catch {
    return null;
  }
}

// Pick the list whose name contains today's weekday (e.g. "Monday").
// Case-insensitive substring so "Mon — deep work" still matches. null = no hit.
export function weekdayListId(lists: TrelloList[], now = new Date()): string | null {
  const day = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  const short = day.slice(0, 3); // "mon" — matches abbreviated list names too
  const hit = lists.find((l) => {
    const n = l.name.toLowerCase();
    return n.includes(day) || n.includes(short);
  });
  return hit?.id ?? null;
}

function priorityFromLabels(labels: TrelloLabel[] | undefined): Priority {
  for (const l of labels ?? []) {
    const n = (l.name ?? '').toLowerCase();
    if (n.includes('high')) return 'high';
    if (n.includes('low')) return 'low';
  }
  return 'med';
}

// A card's sidebar link lives in Trello as a URL attachment: the most recent
// non-upload one. Absent → the link falls back to the card's own shortUrl.
function linkAttachment(atts: TrelloAttachment[] | undefined): TrelloAttachment | undefined {
  return (atts ?? []).filter((a) => !a.isUpload && a.url).pop();
}

// Pull open cards from the configured list → Todo[]. null on any failure.
export async function trelloPull(cfg: TrelloConfig): Promise<Todo[] | null> {
  try {
    const q = `filter=open&attachments=true&attachment_fields=url,isUpload&${auth(cfg)}`;
    const res = await fetch(`${BASE}/lists/${cfg.listId}/cards?${q}`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    const cards = (await res.json()) as TrelloCard[];
    return cards.map((c, i) => ({
      id: crypto.randomUUID(),
      text: c.name,
      done: c.dueComplete === true,
      priority: priorityFromLabels(c.labels),
      createdAt: Date.now(),
      pos: typeof c.pos === 'number' ? c.pos : i + 1,
      desc: c.desc || undefined,
      link: linkAttachment(c.attachments)?.url || c.shortUrl || undefined,
      trelloCardId: c.id,
    }));
  } catch {
    return null;
  }
}

// Create a card, returning its id. null on any failure.
export async function trelloCreate(cfg: TrelloConfig, todo: Todo): Promise<string | null> {
  try {
    const res = await fetch(`${BASE}/cards?${auth(cfg)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idList: cfg.listId, name: todo.text, desc: todo.desc ?? '' }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    const card = (await res.json()) as { id: string };
    return card.id ?? null;
  } catch {
    return null;
  }
}

// Push a row's text/desc/link onto its card. true only when every write landed,
// so the caller keeps the row dirty (and retries on the next sync) otherwise.
export async function trelloPushEdit(cfg: TrelloConfig, cardId: string, todo: Todo): Promise<boolean> {
  try {
    const card = `${BASE}/cards/${cardId}`;
    const put = await fetch(`${card}?${auth(cfg)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: todo.text, desc: todo.desc ?? '' }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!put.ok) return false;

    // Link: replace the attachment the sidebar shows. A link equal to what's
    // already shown (incl. the card's own shortUrl fallback) is a no-op.
    const info = await fetch(`${card}?fields=shortUrl&attachments=true&attachment_fields=url,isUpload&${auth(cfg)}`, {
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!info.ok) return false;
    const { shortUrl, attachments } = (await info.json()) as TrelloCard;
    const cur = linkAttachment(attachments);
    const link = todo.link ?? '';
    if (link === (cur?.url ?? shortUrl ?? '')) return true;
    if (cur) {
      const del = await fetch(`${card}/attachments/${cur.id}?${auth(cfg)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!del.ok) return false;
    }
    if (!link || link === shortUrl) return true; // cleared → shortUrl fallback
    const add = await fetch(`${card}/attachments?url=${encodeURIComponent(link)}&${auth(cfg)}`, {
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT),
    });
    return add.ok;
  } catch {
    return false;
  }
}

// Set a card's done state via dueComplete (Trello's card-level checkmark), so
// checking/unchecking syncs both ways. Failures are swallowed.
export async function trelloSetDone(
  cfg: TrelloConfig,
  cardId: string,
  done: boolean,
): Promise<void> {
  try {
    await fetch(`${BASE}/cards/${cardId}?dueComplete=${done}&${auth(cfg)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    /* offline: local copy already updated */
  }
}

// Reposition a card via its fractional pos. Local order already updated; a
// failure just means Trello keeps the old order until the next successful move.
export async function trelloSetPos(
  cfg: TrelloConfig,
  cardId: string,
  pos: number,
): Promise<void> {
  try {
    await fetch(`${BASE}/cards/${cardId}?pos=${pos}&${auth(cfg)}`, {
      method: 'PUT',
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    /* offline: local order already updated */
  }
}

// Delete a card. Failures are swallowed.
export async function trelloDelete(cfg: TrelloConfig, cardId: string): Promise<void> {
  try {
    await fetch(`${BASE}/cards/${cardId}?${auth(cfg)}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    /* offline: local copy already removed */
  }
}
