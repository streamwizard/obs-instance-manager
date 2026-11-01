import { z } from "zod";

// POST /instances body. obs_ws_password is optional at the schema level so a
// missing one gets its own explicit "obs_ws_password is required" message in
// the route instead of zod's generic one.
export const createInstanceSchema = z.object({
  subscription_id: z.string().uuid(),
  template: z.string().min(1).optional(),
  // Plaintext. The node passes it to rest-api, which encrypts it; older web
  // apps also send obs_ws_password_ciphertext/_iv/_tag, which zod drops.
  obs_ws_password: z.string().min(1).optional(),
});

export type CreateInstanceBody = z.infer<typeof createInstanceSchema>;
