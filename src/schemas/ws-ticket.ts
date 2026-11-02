import { z } from "zod";

// POST /instances/:id/ws-ticket and POST /admin/instances/:id/ws-ticket.
// Only the per-instance proxy scopes are mintable on these routes.
export const instanceWsTicketSchema = z.object({
  scope: z.enum(["novnc", "obsws"]),
});

export type InstanceWsTicketScope = z.infer<typeof instanceWsTicketSchema>["scope"];

// POST /admin/ws-ticket: node-wide metrics stream only.
export const metricsWsTicketSchema = z.object({
  scope: z.literal("metrics"),
});
