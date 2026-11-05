import { issueTicket, SELKIES_TICKET_TTL_MS } from "@/services/auth/ws-tickets";
import type { InstanceWsTicketScope } from "@/schemas/ws-ticket";
import type { Instance } from "@/types";

const TICKET_EXPIRES_IN_SECONDS = 30;

export interface InstanceTicketResponse {
  ticket: string;
  expires_in: number;
}

// Mints the single-use ticket the browser puts on a per-instance proxy URL.
// Callers must already have authorized the caller for this instance (owner
// lookup on the user route, admin role on the admin route).
//
// No password rides along: the Selkies proxy adds the instance's basic-auth
// header itself (services/proxy/selkies-proxy.ts), and obs-websocket clients
// get their password from the panel.
export function mintInstanceTicket(userId: string, instance: Instance, scope: InstanceWsTicketScope): InstanceTicketResponse {
  const ticket = issueTicket({ userId, scope, instanceId: instance.id });
  const expiresIn = scope === "selkies" ? SELKIES_TICKET_TTL_MS / 1000 : TICKET_EXPIRES_IN_SECONDS;
  return { ticket, expires_in: expiresIn };
}
