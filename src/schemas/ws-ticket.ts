import { z } from "zod";

// POST /instances/:id/ws-ticket and POST /admin/instances/:id/ws-ticket.
// Only the per-instance proxy scopes are mintable on these routes. The
// viewer scope a node actually serves (novnc or selkies) is checked at mint
// time against its runtime, see services/auth/instance-ticket.ts.
export const instanceWsTicketSchema = z.object({
  scope: z.enum(["novnc", "obsws", "selkies"]),
});

export type InstanceWsTicketScope = z.infer<typeof instanceWsTicketSchema>["scope"];

// POST /admin/ws-ticket: node-wide metrics stream only.
export const metricsWsTicketSchema = z.object({
  scope: z.literal("metrics"),
});
