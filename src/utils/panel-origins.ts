// PANEL_ORIGIN: the StreamWizard app origin(s) that call this node from a
// browser, comma-separated. CORS (middleware/cors.ts) and the Selkies viewer's
// relay page (services/proxy/viewer-relay) both read it. "*" (the default)
// keeps CORS open but turns the relay off: it only pairs with origins named
// here.

export function parsePanelOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : ["*"];
}

export const PANEL_ORIGINS = parsePanelOrigins(process.env.PANEL_ORIGIN);
