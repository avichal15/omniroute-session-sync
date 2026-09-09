export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export function publicError(error) {
  if (error instanceof BridgeError) return { code: error.code, message: error.message };
  return { code: 'INTERNAL_ERROR', message: 'The operation failed. Please retry or check the bridge.' };
}
