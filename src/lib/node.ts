const nodeId = process.env.NODE_ID;
const nodeAdminToken = process.env.NODE_ADMIN_TOKEN;

if (!nodeId) {
  throw new Error("NODE_ID must be set");
}

if (!nodeAdminToken) {
  throw new Error("NODE_ADMIN_TOKEN must be set");
}

export const NODE_ID = nodeId;
export const NODE_ADMIN_TOKEN = nodeAdminToken;
