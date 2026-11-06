/**
 * Whether a student's page is open, and in front. The page polls for TAi's messages all the time it is open (a request held up to 25 s, then
 * the next at once), and says with each poll, and again whenever the tab goes behind another or comes back, whether it is in front
 * (`document.visibilityState`): `GET api/poll?...&c=<this page's id>&v=<1 or 0>`. The server calls `begin` for each of those requests and the
 * returned function when it is answered.
 *
 *   visible   a page of this student is in front: a request of its that said so is held, or one was answered in the last 5 s (a live page asks
 *             again at once, so the 5 s only covers the gap between two polls)
 *   hidden    a page is open but behind another tab or window: a push is welcome, the tab title counts the message too
 *   closed    no request of any page is held and none was answered in the last 5 s, or the one that was held was seen to disconnect (a closed
 *             tab drops its held poll at once, and that is taken as the page being gone, not as five more seconds of presence: a reply that
 *             comes ten seconds after the tab was closed must still be pushed)
 *
 * A page that dies without a word (a laptop lid closed, a phone off the network: no FIN or RST ever reaches Node) is not seen to disconnect. Its held poll
 * is answered by the server's own 25 s timer into the dead socket, and that looks like any answer (`res.writableEnded` is true), so such a page reads as
 * visible until then plus the 5 s: about 30 s after its last request at worst (55 s when the grace after an answer was 30 s). Nothing here can know sooner.
 *
 * `lastVisibleAt` is what the e-mail channel calls "seen" (a message counts as seen once a page of the student's was in front after it was written): now
 * while a request that said "in front" is held, otherwise the moment the last such request arrived, and never the moment a poll was answered. An answer
 * cannot be told from one into a dead socket, and TAi's own message is exactly what ends a held poll early. A live page that is sent the message asks again
 * at once, and that request, made after the message, is the proof it arrived.
 *
 * Pages are told apart by an id they make up (one per page load), so two tabs of one student, one in front and one not, are "visible".
 * Nothing here is trusted for anything but this decision: a student who lies about it only changes whether *they* get a push.
 */
import type { PageState } from './core.js';

const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Client {
  visible: boolean;
  lastSeen: number;
  inFlight: number;
}

export interface PresenceOptions {
  /** How long a page with no request held still counts as open after its last one was answered (ms). Default 5 s: a live page asks again at once. */
  idleGraceMs?: number;
  /** Pages remembered per student (the least recently seen goes first). Default 8. */
  maxClients?: number;
  now?: () => number;
}

export class Presence {
  private readonly clients = new Map<string, Map<string, Client>>();
  private readonly lastVisible = new Map<string, number>();
  private readonly idleGraceMs: number;
  private readonly maxClients: number;
  private readonly now: () => number;

  constructor(opts: PresenceOptions = {}) {
    this.idleGraceMs = opts.idleGraceMs ?? 5_000;
    this.maxClients = opts.maxClients ?? 8;
    this.now = opts.now ?? Date.now;
  }

  /**
   * A request from a page: it is there, and in front or not. Returns what to call when the request has been answered, with `true` when
   * it was not answered because the page went away (a held poll whose connection dropped).
   */
  begin(folder: string, client: string | null | undefined, visible: boolean): (gone?: boolean) => void {
    const id = client && CLIENT_ID.test(client) ? client : '';
    const now = this.now();
    let pages = this.clients.get(folder);
    if (!pages) {
      pages = new Map();
      this.clients.set(folder, pages);
    }
    let page = pages.get(id);
    if (!page) {
      page = { visible, lastSeen: now, inFlight: 0 };
      pages.set(id, page);
      this.trim(pages);
    }
    page.visible = visible;
    page.lastSeen = now;
    page.inFlight++;
    if (visible) this.lastVisible.set(folder, now);
    let ended = false;
    const mine = pages;
    return (gone = false) => {
      if (ended) return;
      ended = true;
      page.inFlight = Math.max(0, page.inFlight - 1);
      page.lastSeen = this.now();
      // (`lastVisible` is not moved here: the answer may have gone into a dead socket, and a message that woke the poll would then count as seen)
      if (gone && page.inFlight === 0) mine.delete(id);
    };
  }

  state(folder: string): PageState {
    const pages = this.clients.get(folder);
    if (!pages) return 'closed';
    const now = this.now();
    let open = false;
    for (const [id, page] of pages) {
      if (page.inFlight === 0 && now - page.lastSeen > this.idleGraceMs) {
        pages.delete(id);
        continue;
      }
      open = true;
      if (page.visible) return 'visible';
    }
    if (pages.size === 0) this.clients.delete(folder);
    return open ? 'hidden' : 'closed';
  }

  /**
   * When a page of this student was last seen in front: now while a request that said so is held, otherwise when the last such request arrived (a message
   * held for quiet hours is dropped if they have looked since, and the e-mail channel counts a message as seen by it). 0: never. The grace after an answer
   * is not "in front now": a page that died is in it too.
   */
  lastVisibleAt(folder: string): number {
    for (const page of this.clients.get(folder)?.values() ?? []) if (page.visible && page.inFlight > 0) return this.now();
    return this.lastVisible.get(folder) ?? 0;
  }

  private trim(pages: Map<string, Client>): void {
    while (pages.size > this.maxClients) {
      let oldest: string | undefined;
      let at = Infinity;
      for (const [id, page] of pages) {
        if (page.lastSeen < at) {
          at = page.lastSeen;
          oldest = id;
        }
      }
      if (oldest === undefined) return;
      pages.delete(oldest);
    }
  }
}
