import { z } from "zod";

// POST /instances body. obs_ws_password is optional at the schema level so a
// missing one gets its own explicit "obs_ws_password is required" message in
// the route instead of zod's generic one.
export const createInstanceSchema = z.object({
  subscription_id: z.string().uuid(),
  template: z.string().min(1).optional(),
  obs_ws_password: z.string().min(1).optional(),
  obs_ws_password_ciphertext: z.string().min(1).optional(),
  obs_ws_password_iv: z.string().min(1).optional(),
  obs_ws_password_tag: z.string().min(1).optional(),
});

export type CreateInstanceBody = z.infer<typeof createInstanceSchema>;
