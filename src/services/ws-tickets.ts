import { randomBytes } from "node:crypto";

// Browsers can't set an Authorization header on `new WebSocket()`, so the only
// place to carry auth into a WS upgrade is the URL -- and a long-lived Supabase
// JWT in a URL leaks into node/proxy access logs and browser history. Instead,
// the panel mints a short-lived, single-use, scope+instance-bound ticket over
// an authenticated HTTPS POST (real credential stays in the header), and only
// that ticket ever rides on the socket. This mirrors how Twitch EventSub keeps
// the OAuth token off the WebSocket and references an ephemeral session handle.
//
// Single-use + a 30s TTL means a ticket leaked into a log is inert: it's
// already consumed, or expired, before anyone could replay it.

export type TicketScope = "metrics" | "novnc" | "obsws";

export interface Ticket {
  userId: string;
  scope: TicketScope;
  // null for node-wide scopes like "metrics"; the instance id for the
  // per-instance novnc/obsws proxies.
  instanceId: string | null;
  expiresAt: number;
}

const TICKET_TTL_MS = 30_000;
const SWEEP_INTERVAL_MS = 60_000;

// Tickets are minted and consumed on the same node process, so an in-memory
// map is sufficient -- no shared store needed, and it scales per-node.
const tickets = new Map<string, Ticket>();

export function issueTicket(input: {
  userId: string;
  scope: TicketScope;
  instanceId?: string | null;
}): string {
  const token = randomBytes(32).toString("base64url");
  tickets.set(token, {
    userId: input.userId,
    scope: input.scope,
    instanceId: input.instanceId ?? null,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  return token;
}

// Validates and atomically consumes a ticket. Returns the ticket on success
// (and deletes it, so a second call with the same token fails), or null if the
// token is missing, expired, or doesn't match the required scope/instance.
export function consumeTicket(
  token: string | undefined | null,
  requiredScope: TicketScope,
  instanceId?: string | null,
): Ticket | null {
  if (!token) return null;

  const ticket = tickets.get(token);
  if (!ticket) return null;

  // Single-use: remove first so even a same-tick concurrent consume can't
  // double-spend the ticket.
  tickets.delete(token);

  if (ticket.expiresAt < Date.now()) return null;
  if (ticket.scope !== requiredScope) return null;
  if ((instanceId ?? null) !== ticket.instanceId) return null;

  return ticket;
}

// Drops expired tickets that were issued but never consumed, so the map can't
// grow unbounded from abandoned mint requests. `unref()` keeps this timer from
// holding the process open during shutdown.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [token, ticket] of tickets) {
    if (ticket.expiresAt < now) tickets.delete(token);
  }
}, SWEEP_INTERVAL_MS);
sweep.unref?.();
