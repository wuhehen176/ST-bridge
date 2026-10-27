/**
 * Bridge error carrying an HTTP status and a stable machine-readable code.
 * The HTTP layer always renders it as {"error":{"message":...}}.
 */
export class BridgeError extends Error {
  constructor(status, code, message, options = {}) {
    super(message, options);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.expose = options.expose ?? true;
  }
}

export function badRequest(message, code = 'invalid_request') {
  return new BridgeError(400, code, message);
}

export function conflict(message, code = 'conflict') {
  return new BridgeError(409, code, message);
}

export function upstreamError(message, code = 'agent_error', status = 502) {
  return new BridgeError(status, code, message);
}

export function timeoutError(message = 'Agent 回合超时') {
  return new BridgeError(504, 'timeout', message);
}

export function sessionGone(message = 'DSH 会话已失效、未知或不属于该聊天') {
  return new BridgeError(410, 'session_gone', message);
}
