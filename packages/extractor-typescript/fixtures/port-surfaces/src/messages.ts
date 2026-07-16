import type { ExternalWindowChannel } from "dependency-without-declarations";

const READY = "hook-ready";
const readyMessage = { type: READY } as const;
const mutableMessage = { type: "initial" };

export function announceReady(target: Window): void {
  target.postMessage(readyMessage, "https://host.example");
}

function receiveReady(event: MessageEvent): void {
  if (event.data?.type !== READY) return;
  console.info("ready");
}

export function subscribeToReady(): void {
  window.addEventListener("message", receiveReady);
}

export function subscribeToJobs(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    switch (event.data?.kind) {
      case "created":
        console.info("created");
        break;
      case "deleted":
        console.info("deleted");
        break;
    }
  });
}

function notify(target: Window, type: string, origin: string, extra?: Record<string, unknown>): void {
  target.postMessage({ type, ...extra }, origin);
}

export function announceDelegateReady(target: Window): void {
  notify(target, "delegate-ready", "https://host.example");
}

export function announceSessionChanged(target: Window, sessionId: string): void {
  notify(target, "session-changed", "https://host.example", { sessionId });
}

function receiveDelegateReady(event: MessageEvent): void {
  if (event.data?.type !== "delegate-ready") return;
  console.info("delegate ready");
}

export function subscribeToDelegateReady(): void {
  window.addEventListener("message", receiveDelegateReady);
}

function notifyDynamic(target: Window, type: string): void {
  target.postMessage({ type }, "*");
}

export function announceDynamicThroughWrapper(target: Window, type: string): void {
  notifyDynamic(target, type);
}

export function sendDynamic(target: Window, payload: unknown): void {
  target.postMessage(payload, "*");
}

export function sendMutableAlias(target: Window, type: string): void {
  mutableMessage.type = type;
  target.postMessage(mutableMessage, "*");
}

declare const unresolvedExternalChannel: ExternalWindowChannel;

export function announceThroughUnresolvedDependency(): void {
  unresolvedExternalChannel.target.postMessage({ type: "dependency-ready" }, "*");
}

interface ApplicationMailbox {
  postMessage(payload: unknown, destination: string): void;
}

export function callApplicationMethod(mailbox: ApplicationMailbox): void {
  mailbox.postMessage({ type: "not-a-platform-boundary" }, "archive");
}
