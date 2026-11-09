export const ErrorCode = Object.freeze({
  UNSUPPORTED_PLATFORM: "unsupported_platform",
  NOT_SIGNED_IN: "not_signed_in",
  MISSING_CONVERSATION_ID: "missing_conversation_id",
  API_UNAVAILABLE: "api_unavailable",
  PERMISSION_DENIED: "permission_denied",
  INVALID_RESPONSE: "invalid_response",
  EMPTY_CONVERSATION: "empty_conversation",
  CLIPBOARD_FAILED: "clipboard_failed"
});

export class CopyError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "CopyError";
    this.code = code;
  }
}

export function responseError(status, platform) {
  if (status === 401) return new CopyError(ErrorCode.NOT_SIGNED_IN, `Sign in to ${platform} and try again.`);
  if (status === 403) return new CopyError(ErrorCode.PERMISSION_DENIED, `${platform} denied access to this conversation.`);
  return new CopyError(ErrorCode.API_UNAVAILABLE, `${platform} conversation API returned ${status}.`);
}

export function toErrorResult(error) {
  const known = error instanceof CopyError;
  return {
    ok: false,
    code: known ? error.code : ErrorCode.API_UNAVAILABLE,
    error: error?.message || "Could not copy this conversation."
  };
}
