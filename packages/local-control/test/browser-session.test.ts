import { describe, expect, it } from "vitest";
import { BrowserSessions } from "../src/browser-session.js";

describe("local browser launch authority", () => {
  it("exchanges a one-use ticket into an HttpOnly cookie and never accepts the ticket as a session", () => {
    let counter = 0;
    const sessions = new BrowserSessions(() => 1000, () => (++counter).toString(16).padStart(64, "0"));
    const code = sessions.issue();
    expect(sessions.accepts(`ctc_browser=${code}`)).toBe(false);
    const cookie = sessions.exchange(code)!;
    expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/");
    expect(cookie).not.toContain(code);
    expect(sessions.accepts(cookie.split(";")[0])).toBe(true);
    expect(sessions.exchange(code)).toBeNull();
    expect(sessions.accepts(`${cookie.split(";")[0]}; ${cookie.split(";")[0]}`)).toBe(false);
  });
  it("replaces the current browser session without exhausting slots and retires the old cookie", () => {
    let counter = 0;
    const sessions = new BrowserSessions(() => 0, () => (++counter).toString(16).padStart(64, "0"));
    let cookie: string | undefined;
    for (let index = 0; index < 20; index++) {
      const prior = cookie;
      const replacement = sessions.exchange(sessions.issue(), prior);
      expect(replacement).not.toBeNull(); cookie = replacement!.split(";")[0];
      expect(sessions.accepts(cookie)).toBe(true);
      if (prior) expect(sessions.accepts(prior)).toBe(false);
    }
    for (let index = 0; index < 7; index++) expect(sessions.exchange(sessions.issue())).not.toBeNull();
    expect(sessions.exchange(sessions.issue())).toBeNull();
    expect(sessions.exchange(sessions.issue(), cookie)).not.toBeNull();
  });
  it("expires both tickets and sessions using an injected clock", () => {
    let time = 0; let counter = 0;
    const sessions = new BrowserSessions(() => time, () => (++counter).toString(16).padStart(64, "0"));
    const expired = sessions.issue(); time = 120000;
    expect(sessions.exchange(expired)).toBeNull();
    const cookie = sessions.exchange(sessions.issue())!;
    time += 12 * 60 * 60_000;
    expect(sessions.accepts(cookie.split(";")[0])).toBe(false);
  });
  it("bounds outstanding tickets and rejects malformed or ambiguous credentials", () => {
    let counter = 0;
    const sessions = new BrowserSessions(() => 0, () => (++counter).toString(16).padStart(64, "0"));
    for (let index = 0; index < 8; index++) sessions.issue();
    expect(() => sessions.issue()).toThrow();
    for (const value of [null, {}, "", "x".repeat(64), "a".repeat(63), "a".repeat(65)]) expect(sessions.exchange(value)).toBeNull();
    expect(sessions.accepts(undefined)).toBe(false);
  });
});
