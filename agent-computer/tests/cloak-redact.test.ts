import { describe, expect, test } from "bun:test";
import { redactSecrets } from "../src/cloak-redact";

describe("redacting proxy secrets from computer errors", () => {
  test("strips userinfo so neither the password nor its encoding remain", () => {
    const redacted = redactSecrets(
      "launch failed proxy http://user:p%40ss@proxy:8080",
    );
    expect(redacted).not.toContain("p@ss");
    expect(redacted).not.toContain("p%40ss");
    expect(redacted).toContain("http://***:***@proxy:8080");
  });

  test("strips password= argv forms", () => {
    expect(redactSecrets("password=s3cret rest")).toBe("password=*** rest");
  });
});
