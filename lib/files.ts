/**
 * File handling for the Telegram bot: reading what a user sends, and sending
 * back what the agent produces.
 *
 * Telegram gives a bot a `file_id` rather than the bytes. Retrieval is two
 * steps — resolve the id to a path, then download from a different host — and
 * the download limit for bots is 20 MB regardless of what the client allowed
 * the user to upload.
 */

const API = (method: string) =>
  `https://api.telegram.org/bot${process.env.VELTR_TELEGRAM_BOT_TOKEN}/${method}`;

/** Telegram's own ceiling for bot downloads. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

/** Well past what a model can use, and past what a chat message can carry. */
export const MAX_TEXT_CHARS = 120_000;

export type IncomingFile = {
  fileId: string;
  name: string;
  mimeType: string | null;
  sizeBytes: number;
};

export type FileContent = {
  name: string;
  text: string;
  bytes: number;
  truncated: boolean;
};

/**
 * Extensions worth reading as text.
 *
 * An allow-list rather than a deny-list: handing a model the UTF-8
 * reinterpretation of a PNG produces confident nonsense, and the failure is
 * invisible because it still looks like characters.
 */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "yaml", "yml", "toml", "ini", "env",
  "html", "htm", "css", "scss", "xml", "svg",
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "ps1", "sql", "sol", "vy",
  "log", "conf", "gitignore", "dockerfile", "makefile",
]);

export function isReadableAsText(name: string, mimeType?: string | null): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (!mimeType) return false;
  return mimeType.startsWith("text/") || /json|xml|javascript|yaml/.test(mimeType);
}

/** Resolves a file_id to a download path. */
async function resolveFilePath(fileId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API("getFile")}?file_id=${encodeURIComponent(fileId)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const json = await res.json();
    return json?.ok ? (json.result.file_path as string) : null;
  } catch {
    return null;
  }
}

export async function downloadFile(file: IncomingFile): Promise<FileContent | null> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return null;

  if (file.sizeBytes > MAX_DOWNLOAD_BYTES) {
    return {
      name: file.name,
      text: "",
      bytes: file.sizeBytes,
      truncated: true,
    };
  }

  const path = await resolveFilePath(file.fileId);
  if (!path) return null;

  try {
    // Downloads come from a different host than the API.
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;

    const raw = await res.text();
    const truncated = raw.length > MAX_TEXT_CHARS;

    return {
      name: file.name,
      text: truncated ? raw.slice(0, MAX_TEXT_CHARS) : raw,
      bytes: file.sizeBytes,
      truncated,
    };
  } catch {
    return null;
  }
}

/**
 * Sends a generated file to a chat.
 *
 * Uploaded as multipart rather than a URL: the content exists only in memory,
 * and writing it to disk to serve it back would add a filesystem dependency and
 * a cleanup problem for something that is used once.
 */
export async function sendDocument(
  chatId: string,
  filename: string,
  content: string,
  caption?: string
): Promise<boolean> {
  const token = process.env.VELTR_TELEGRAM_BOT_TOKEN;
  if (!token) return false;

  try {
    const form = new FormData();
    form.append("chat_id", chatId);
    form.append("document", new Blob([content], { type: mimeFor(filename) }), filename);
    if (caption) form.append("caption", caption.slice(0, 1000));

    const res = await fetch(API("sendDocument"), {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      console.warn(`[veltr] sendDocument ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("[veltr] sendDocument failed:", error);
    return false;
  }
}

function mimeFor(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    html: "text/html",
    htm: "text/html",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    js: "text/javascript",
    ts: "text/plain",
    css: "text/css",
    svg: "image/svg+xml",
    xml: "application/xml",
    yaml: "text/yaml",
    yml: "text/yaml",
    txt: "text/plain",
  };
  return map[ext] ?? "text/plain";
}

/** Guards against a model inventing a path or an unsafe name. */
export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/]/g, "-")
    .replace(/[^\w.\- ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^[.\-]+/, "")
    .slice(0, 80);
  return cleaned || "veltr-output.txt";
}
