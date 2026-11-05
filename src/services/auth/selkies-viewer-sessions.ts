import type { Ticket } from "@/services/auth/ws-tickets";

// The Selkies viewer page runs on this node, not in the panel, so it can't
// mint a fresh ws-ticket for each WebSocket the way the panel's own pages do.
// Instead the panel puts one ticket in the page's URL fragment (#token=...),
// which the Selkies client sends on every API call (Authorization: Bearer)
// and every WebSocket handshake (Sec-WebSocket-Protocol: selkies.token.<b64>).
//
// The first request that presents it spends the ticket and opens a viewer
// session under the same token. The session lives while a WebSocket is open,
// plus RECONNECT_GRACE_MS after the last one closes, so a network blip or a
// Selkies reconnect gets back in; after that the token is dead and the user
// reopens the viewer from the panel. There is no cookie, and the proxy checks
// instance ownership again on every WebSocket connect, so revoked access ends
// with the socket, as it did with noVNC.

export const RECONNECT_GRACE_MS = 2 * 60_000;
// Hard cap, so a viewer left open for days still has to come back through
// the panel eventually.
export const SESSION_MAX_MS = 12 * 60 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

export interface ViewerSession {
  ticket: Ticket;
  containerName: string;
  createdAt: number;
  openSockets: number;
  /** When the last socket closed (or the session started, before any socket). */
  idleSince: number;
}

export class ViewerSessions {
  private readonly sessions = new Map<string, ViewerSession>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;

  constructor(private readonly now: () => number = Date.now) {
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Opens a session for a ticket the caller has just spent and authorized. */
  start(token: string, ticket: Ticket, containerName: string): ViewerSession {
    const at = this.now();
    const session: ViewerSession = { ticket, containerName, createdAt: at, openSockets: 0, idleSince: at };
    this.sessions.set(token, session);
    return session;
  }

  /** The live session for this token and instance, or null. */
  get(token: string, instanceId: string): ViewerSession | null {
    const session = this.sessions.get(token);
    if (!session) return null;
    if (!this.isLive(session)) {
      this.sessions.delete(token);
      return null;
    }
    return session.ticket.instanceId === instanceId ? session : null;
  }

  /** Ends a session at once, e.g. when the ownership re-check fails. */
  end(token: string): void {
    this.sessions.delete(token);
  }

  socketOpened(session: ViewerSession): void {
    session.openSockets++;
  }

  socketClosed(session: ViewerSession): void {
    session.openSockets = Math.max(0, session.openSockets - 1);
    if (session.openSockets === 0) session.idleSince = this.now();
  }

  sweep(): void {
    for (const [token, session] of this.sessions) {
      if (!this.isLive(session)) this.sessions.delete(token);
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  dispose(): void {
    clearInterval(this.sweepTimer);
  }

  private isLive(session: ViewerSession): boolean {
    const at = this.now();
    if (at - session.createdAt > SESSION_MAX_MS) return false;
    return session.openSockets > 0 || at - session.idleSince <= RECONNECT_GRACE_MS;
  }
}
