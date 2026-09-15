import { expect, test } from "bun:test";
import { isOpenBotSiteUrl, openBotSiteUrl } from "./openbot-site-url";

test("https company hosts are accepted", () => {
  expect(openBotSiteUrl("https://openbot.example.com")).toBe(
    "https://openbot.example.com",
  );
  expect(isOpenBotSiteUrl("  https://openbot.example.com/app  ")).toBe(true);
});

test("http is only for loopback", () => {
  expect(isOpenBotSiteUrl("http://127.0.0.1:3001")).toBe(true);
  expect(isOpenBotSiteUrl("http://localhost:3001")).toBe(true);
  expect(isOpenBotSiteUrl("http://[::1]:3001")).toBe(true);
  expect(isOpenBotSiteUrl("http://192.168.1.9")).toBe(false);
  expect(isOpenBotSiteUrl("http://openbot.example.com")).toBe(false);
});

test("javascript, file, data, and credentials are refused", () => {
  expect(isOpenBotSiteUrl("javascript:alert(1)")).toBe(false);
  expect(isOpenBotSiteUrl("file:///etc/passwd")).toBe(false);
  expect(isOpenBotSiteUrl("data:text/html,hi")).toBe(false);
  expect(isOpenBotSiteUrl("https://user:pass@openbot.example.com")).toBe(false);
  expect(isOpenBotSiteUrl("")).toBe(false);
});
