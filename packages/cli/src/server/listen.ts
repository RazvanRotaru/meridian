/**
 * Binding the server, walking forward over busy ports.
 *
 * The default port is a convenience, not a reservation, so a busy port is recoverable: we try
 * the next twenty before giving up with the dedicated port-bind exit code.
 */

import type { Server } from "node:http";
import { CliError, EXIT } from "../errors";

const MAX_PORT_ATTEMPTS = 20;

export async function listenWithRetry(server: Server, host: string, startPort: number): Promise<number> {
  for (let port = startPort; port <= startPort + MAX_PORT_ATTEMPTS; port += 1) {
    if (await tryListen(server, host, port)) {
      return port;
    }
  }
  throw new CliError(EXIT.portBind, `no free port in ${startPort}..${startPort + MAX_PORT_ATTEMPTS} on ${host}`);
}

function tryListen(server: Server, host: string, port: number): Promise<boolean> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") {
        resolveListen(false);
      } else {
        rejectListen(new CliError(EXIT.portBind, `cannot bind ${host}:${port}: ${error.message}`));
      }
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
