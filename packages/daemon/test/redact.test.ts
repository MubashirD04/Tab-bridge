import { describe, expect, it } from "vitest";
import { redactHeaders, redactTokenLikeQueryParams } from "../src/redact.js";

describe("redactHeaders", () => {
  it("redacts Authorization, Cookie, and Set-Cookie regardless of case", () => {
    const input = {
      Authorization: "Bearer secret-token",
      cookie: "session=abc123",
      "Set-Cookie": "session=abc123; HttpOnly",
      "Content-Type": "application/json",
    };
    const out = redactHeaders(input);
    expect(out.Authorization).toBe("[redacted]");
    expect(out.cookie).toBe("[redacted]");
    expect(out["Set-Cookie"]).toBe("[redacted]");
    expect(out["Content-Type"]).toBe("application/json");
  });

  it("never leaves a sensitive header unredacted, exhaustively", () => {
    const sensitiveNames = ["authorization", "Authorization", "AUTHORIZATION", "cookie", "Cookie", "set-cookie", "Set-Cookie"];
    for (const name of sensitiveNames) {
      const out = redactHeaders({ [name]: "super-secret-value" });
      expect(Object.values(out)).not.toContain("super-secret-value");
      expect(out[name]).toBe("[redacted]");
    }
  });

  it("handles missing/undefined headers gracefully", () => {
    expect(redactHeaders(undefined)).toEqual({});
    expect(redactHeaders({})).toEqual({});
  });
});

describe("redactTokenLikeQueryParams", () => {
  it("redacts common token-shaped query params", () => {
    const url = "https://api.example.com/data?api_key=xyz&other=1";
    const out = redactTokenLikeQueryParams(url);
    expect(out).toContain("api_key=redacted");
    expect(out).toContain("other=1");
  });

  it("leaves URLs with no token-like params unchanged in substance", () => {
    const url = "https://api.example.com/data?other=1";
    expect(redactTokenLikeQueryParams(url)).toBe(url);
  });

  it("returns the input unchanged if it isn't a parseable URL", () => {
    expect(redactTokenLikeQueryParams("not a url")).toBe("not a url");
  });
});
