/** Only allowlisted categories/metadata may reach local logs, never raw SDK errors. */
export class MissingMappedSessionError extends Error {
  constructor() { super("Mapped Pi session is missing; restore its JSONL backup or explicitly /clear."); }
}

export class AssistantResponseError extends Error {
  readonly stopReason: string;
  constructor(stopReason: unknown) {
    super("No fresh successful assistant response");
    this.stopReason = typeof stopReason === "string" && ["error", "aborted", "length", "toolUse", "none"].includes(stopReason)
      ? stopReason : "unknown";
  }
}

const filesystemCodes = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOSPC", "EDQUOT", "EROFS", "EIO", "EEXIST",
  "ENOTDIR", "EISDIR", "ENOTEMPTY", "EMFILE", "ENFILE", "ELOOP", "ENAMETOOLONG",
  "EXDEV", "EBADF", "EINVAL", "EBUSY", "EFBIG",
]);

export function safeDiagnostic(error: unknown): string {
  if (error instanceof MissingMappedSessionError) return "category=missing-mapped-session";
  if (error instanceof AssistantResponseError) {
    const category = error.stopReason === "error" ? "provider-auth" : "assistant-response";
    return `category=${category} stopReason=${error.stopReason}`;
  }
  if (error && typeof error === "object") {
    const detail = error as { code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof detail.code === "string" && filesystemCodes.has(detail.code)) {
      return `category=filesystem errno=${detail.code}`;
    }
    const status = detail.status ?? detail.statusCode;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return `category=provider-auth status=${status}`;
    }
    // SDK auth setup errors may lack a status. Inspect text only to classify; never emit it.
    if (typeof detail.message === "string" && /api[ -]?key|authenticat|unauthoriz|credential|oauth|provider/i.test(detail.message)) {
      return "category=provider-auth";
    }
  }
  return "category=unknown";
}
