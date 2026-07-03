/**
 * The pure device-flow protocol: shaping GitHub's device-code and token JSON into typed states.
 * The key invariant is that pending/slow_down/expired arrive as HTTP 200 with an `error` field, so
 * these are read from the body — never a status code. The network call is covered by live smoke.
 */

import { describe, expect, it } from "vitest";
import { interpretTokenResponse, parseDeviceCodeResponse, tokenRedeemBody } from "./github-auth";
import { WebError } from "./web-error";

describe("parseDeviceCodeResponse", () => {
  it("maps GitHub's snake_case fields to the typed device code", () => {
    const device = parseDeviceCodeResponse({
      device_code: "dev-123",
      user_code: "WDJB-MJHT",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
    expect(device).toMatchObject({ deviceCode: "dev-123", userCode: "WDJB-MJHT", intervalSeconds: 5, expiresInSeconds: 900 });
    expect(device.verificationUriComplete).toBeNull();
  });

  it("throws when GitHub returns an error (e.g. device flow disabled)", () => {
    expect(() => parseDeviceCodeResponse({ error: "device_flow_disabled" })).toThrow(WebError);
  });

  it("throws on a missing required field rather than yielding undefined", () => {
    expect(() => parseDeviceCodeResponse({ user_code: "x", verification_uri: "y", expires_in: 1, interval: 1 })).toThrow(WebError);
  });
});

describe("tokenRedeemBody", () => {
  it("builds the device-code grant body with no client secret", () => {
    expect(tokenRedeemBody("client-abc", "dev-123")).toEqual({
      client_id: "client-abc",
      device_code: "dev-123",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });
});

describe("interpretTokenResponse", () => {
  it("returns the token when authorization completes", () => {
    expect(interpretTokenResponse({ access_token: "gho_abc", token_type: "bearer" })).toEqual({
      status: "authorized",
      token: "gho_abc",
    });
  });

  it("reads pending / slow_down / expired / denied from the body's error field", () => {
    expect(interpretTokenResponse({ error: "authorization_pending" })).toEqual({ status: "pending" });
    expect(interpretTokenResponse({ error: "slow_down", interval: 10 })).toEqual({ status: "slow_down", intervalSeconds: 10 });
    expect(interpretTokenResponse({ error: "expired_token" })).toEqual({ status: "expired" });
    expect(interpretTokenResponse({ error: "access_denied" })).toEqual({ status: "denied" });
  });

  it("surfaces an unknown error's description as a message", () => {
    const poll = interpretTokenResponse({ error: "incorrect_client_credentials", error_description: "bad client" });
    expect(poll).toEqual({ status: "error", message: "bad client" });
  });
});
