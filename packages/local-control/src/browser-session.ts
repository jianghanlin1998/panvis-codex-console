import { createHash, randomBytes } from "node:crypto";

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
const valid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const BROWSER_COOKIE = "ctc_browser";

/** One-use local launch tickets exchange into HttpOnly cookies; CLI credentials never enter the page. */
export class BrowserSessions {
  readonly #launches = new Map<string, number>();
  readonly #sessions = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now, private readonly secret: () => string = () => randomBytes(32).toString("hex")) {}
  #prune() {
    for (const entries of [this.#launches, this.#sessions]) for (const [key, expiry] of entries) if (expiry <= this.now()) entries.delete(key);
  }
  issue(): string {
    this.#prune();
    const code = this.secret();
    if (!valid(code) || this.#launches.size >= 8) throw new Error("BROWSER_SESSION_LIMIT");
    this.#launches.set(fingerprint(code), this.now() + 120_000);
    return code;
  }
  exchange(code: unknown, existingCookie?: string): string | null {
    this.#prune();
    const previous = this.#token(existingCookie);
    const replacesExisting = previous !== null && this.#sessions.has(fingerprint(previous));
    if (!valid(code) || !this.#launches.delete(fingerprint(code)) || this.#sessions.size >= 8 && !replacesExisting) return null;
    const session = this.secret();
    if (!valid(session)) return null;
    if (replacesExisting) this.#sessions.delete(fingerprint(previous!));
    this.#sessions.set(fingerprint(session), this.now() + 12 * 60 * 60_000);
    return `${BROWSER_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`;
  }
  #token(header: string | undefined): string | null {
    const cookies = header?.split(";").map(value => value.trim()).filter(value => value.startsWith(`${BROWSER_COOKIE}=`)) ?? [];
    if (cookies.length !== 1) return null;
    const token = cookies[0]!.slice(BROWSER_COOKIE.length + 1);
    return valid(token) ? token : null;
  }
  accepts(header: string | undefined): boolean {
    this.#prune(); const token = this.#token(header);
    return token !== null && this.#sessions.has(fingerprint(token));
  }
}
