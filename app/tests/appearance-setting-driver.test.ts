import { expect, test } from "bun:test";

if (process.env.APPEARANCE_SETTING_CHILD === "1") {
  await import("./appearance-setting.test");
} else {
  test("appearance setting child driver is inert without explicit child mode", () => {
    expect(process.env.APPEARANCE_SETTING_CHILD).toBeUndefined();
  });
}
