const nodeId = process.env.NODE_ID;

if (!nodeId) {
  throw new Error("NODE_ID must be set");
}

export const NODE_ID = nodeId;
