import axios from "axios";
import { ipcMain } from "electron";

export function callReassignedAxios(): void {
  let client = axios.create();
  client = { get: () => undefined } as typeof client;
  client.get("/not-an-http-boundary");
}

export function callReassignedElectron(): void {
  let main = ipcMain;
  main = { on: () => undefined } as typeof main;
  main.on("not-an-ipc-boundary", () => undefined);
}

function originalHandler(): void {}
function replacementHandler(): void {}

export function registerReassignedHandler(): void {
  let handler = originalHandler;
  handler = replacementHandler;
  ipcMain.on("mutable-handler", handler);
}
