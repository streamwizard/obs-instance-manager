import { cors } from "hono/cors";
import { debug } from "@/utils/logger";

const allowedOrigins = (process.env.PANEL_ORIGIN ?? "*").split(",");

// REST routes (not the WebSocket upgrades) are called directly from the
// panel's browser with an Authorization header, which triggers a CORS
// preflight OPTIONS request -- without this, that preflight falls through
// to authMiddleware and gets rejected for having no token, before the
// browser ever sends the real request.
//
// origin as a function (vs a plain array) lets us log every cross-origin
// request's outcome -- otherwise a rejected origin just looks like a silent
// browser-side CORS failure with nothing in these logs to explain it.
export const corsMiddleware = cors({
  origin: (requestOrigin) => {
    if (allowedOrigins.includes("*")) {
      debug("cors", `allowing origin ${requestOrigin} (PANEL_ORIGIN=*)`);
      return requestOrigin;
    }
    if (allowedOrigins.includes(requestOrigin)) {
      debug("cors", `allowing origin ${requestOrigin}`);
      return requestOrigin;
    }
    debug("cors", `rejecting origin ${requestOrigin}, allowed: ${allowedOrigins.join(", ")}`);
    return null;
  },
  allowHeaders: ["Authorization", "Content-Type", "X-File-Path"],
  allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
});
