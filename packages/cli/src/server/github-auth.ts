/**
 * Pure GitHub OAuth Device Flow protocol: shaping the device-code and token responses into typed
 * states. The network calls live in `github.ts`; keeping this network-free lets every branch of
 * GitHub's "HTTP 200 with an `error` field" token protocol be unit-tested.
 */

import { WebError } from "./web-error";
import { asObject, numberOr, optionalString, requireNumber, requireString } from "./json-fields";

const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SLOW_DOWN_FALLBACK_SECONDS = 5;

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type TokenPoll =
  | { status: "authorized"; token: string }
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "error"; message: string };

/** Shape GitHub's device/code response; a returned `error` (e.g. device flow disabled) throws. */
export function parseDeviceCodeResponse(json: unknown): DeviceCode {
  const body = asObject(json);
  if (typeof body.error === "string") {
    throw new WebError(400, `GitHub declined the sign-in request: ${describeError(body)}`);
  }
  return {
    deviceCode: requireString(body, "device_code"),
    userCode: requireString(body, "user_code"),
    verificationUri: requireString(body, "verification_uri"),
    verificationUriComplete: optionalString(body, "verification_uri_complete"),
    intervalSeconds: requireNumber(body, "interval"),
    expiresInSeconds: requireNumber(body, "expires_in"),
  };
}

/** The form body POSTed to the token endpoint while polling. No client secret — device flow. */
export function tokenRedeemBody(clientId: string, deviceCode: string): Record<string, string> {
  return { client_id: clientId, device_code: deviceCode, grant_type: GRANT_TYPE };
}

/** GitHub returns HTTP 200 for pending/slow_down/expired — the state is in the body, not status. */
export function interpretTokenResponse(json: unknown): TokenPoll {
  const body = asObject(json);
  const token = optionalString(body, "access_token");
  if (token) {
    return { status: "authorized", token };
  }
  return interpretPendingError(body);
}

function interpretPendingError(body: Record<string, unknown>): TokenPoll {
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down", intervalSeconds: numberOr(body.interval, SLOW_DOWN_FALLBACK_SECONDS) };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      return { status: "error", message: describeError(body) };
  }
}

function describeError(body: Record<string, unknown>): string {
  return optionalString(body, "error_description") ?? optionalString(body, "error") ?? "unknown error";
}
