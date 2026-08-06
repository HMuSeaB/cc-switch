import { describe, it, expect } from "vitest";
import {
  normalizeUrl,
  getProviderApiUrl,
  getProviderGroupKey,
} from "./providerUrlUtils";
import type { Provider } from "@/types";

describe("providerUrlUtils", () => {
  describe("normalizeUrl", () => {
    it("should strip trailing slashes", () => {
      expect(normalizeUrl("https://www.jisuanyun01.com/")).toBe(
        "https://www.jisuanyun01.com",
      );
      expect(normalizeUrl("https://www.jisuanyun01.com///")).toBe(
        "https://www.jisuanyun01.com",
      );
    });

    it("should handle IP with port", () => {
      expect(normalizeUrl("http://127.0.0.1:8045/")).toBe(
        "http://127.0.0.1:8045",
      );
    });

    it("should preserve path query and hash", () => {
      expect(normalizeUrl("https://api.example.com/v1/chat/")).toBe(
        "https://api.example.com/v1/chat",
      );
    });
  });

  describe("getProviderApiUrl", () => {
    it("should extract ANTHROPIC_BASE_URL from env", () => {
      const provider: Provider = {
        id: "p1",
        name: "Test",
        settingsConfig: {
          env: {
            ANTHROPIC_BASE_URL: "https://www.jisuanyun01.com/",
          },
        },
      };
      expect(getProviderApiUrl(provider, "fallback")).toBe(
        "https://www.jisuanyun01.com",
      );
    });

    it("should extract websiteUrl if present", () => {
      const provider: Provider = {
        id: "p2",
        name: "Test 2",
        websiteUrl: "http://127.0.0.1:8045/",
        settingsConfig: {},
      };
      expect(getProviderApiUrl(provider, "fallback")).toBe(
        "http://127.0.0.1:8045",
      );
    });

    it("should fallback when no url found", () => {
      const provider: Provider = {
        id: "p3",
        name: "Test 3",
        settingsConfig: {},
      };
      expect(getProviderApiUrl(provider, "未配置")).toBe("未配置");
    });
  });

  describe("getProviderGroupKey", () => {
    it("should normalize and convert key to lowercase", () => {
      const p1: Provider = {
        id: "1",
        name: "P1",
        websiteUrl: "HTTPS://WWW.JISUANYUN01.COM/",
        settingsConfig: {},
      };
      const p2: Provider = {
        id: "2",
        name: "P2",
        websiteUrl: "https://www.jisuanyun01.com",
        settingsConfig: {},
      };
      expect(getProviderGroupKey(p1)).toBe(getProviderGroupKey(p2));
    });
  });
});
