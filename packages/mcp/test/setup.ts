// Quiet the server's stderr log lines during tests (privacy.test.ts installs
// its own capturing sink on top of this one).
import { beforeEach } from "vitest";

import { setLogSink } from "../src/log.js";

beforeEach(() => {
  setLogSink(() => undefined);
});
