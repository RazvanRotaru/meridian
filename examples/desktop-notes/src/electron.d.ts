/** Minimal Electron surface used by this extraction fixture; the example is not packaged as an app. */

declare module "electron" {
  interface IpcRenderer {
    invoke(channel: string, ...args: any[]): Promise<any>;
    send(channel: string, ...args: any[]): void;
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  }

  interface IpcMain {
    handle(channel: string, listener: (event: unknown, ...args: any[]) => unknown): void;
    on(channel: string, listener: (event: unknown, ...args: any[]) => void): void;
  }

  export const ipcMain: IpcMain;
  export const ipcRenderer: IpcRenderer;
}
