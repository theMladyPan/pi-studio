/**
 * pi-studio — a local daemon that owns pi agents.
 *
 * The entry does one thing: start the daemon in `server/core.ts`. Everything else lives in a module
 * under `server/`, so importing any of them is free of side effects.
 */
import { start } from "./server/core.ts";

start();
