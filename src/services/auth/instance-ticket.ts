import { issueTicket } from "@/services/auth/ws-tickets";
import { resolveVncPassword } from "@/services/instances/instance-lifecycle";
import type { InstanceWsTicketScope } from "@/schemas/ws-ticket";
import type { Instance } from "@/types";

const TICKET_EXPIRES_IN_SECONDS = 30;

export interface InstanceTicketResponse {
  ticket: string;
  expires_in: number;
  vnc_password?: string;
}

// Mints the single-use ticket the browser puts on a per-instance WS proxy URL.
// Callers must already have authorized the caller for this instance (owner
// lookup on the user route, admin role on the admin route).
//
// The novnc WS proxy is a blind byte relay -- the actual RFB auth handshake
// happens directly between the browser's VNC client and x11vnc inside the
// container, so the browser needs the password to complete it itself.
// Riding along on this response (not the ticket/URL) keeps it out of logs
// and off the WS URL query string.
export async function mintInstanceTicket(
  userId: string,
  instance: Instance,
  scope: InstanceWsTicketScope,
): Promise<InstanceTicketResponse> {
  const ticket = issueTicket({ userId, scope, instanceId: instance.id });

  if (scope === "novnc") {
    const vncPassword = await resolveVncPassword(instance);
    return { ticket, expires_in: TICKET_EXPIRES_IN_SECONDS, vnc_password: vncPassword };
  }

  return { ticket, expires_in: TICKET_EXPIRES_IN_SECONDS };
}
