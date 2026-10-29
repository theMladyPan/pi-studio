/**
 * pi-studio — a local daemon that owns pi agents.
 *
 * The entry does one thing: start the daemon assembled in `server/main.ts`. Every other module under
 * `server/` is a library, so importing one never binds a socket or writes a file.
 */
import { start } from "./server/main.ts";

start();
