import { runBrowserRuntime } from './browser-harness.mjs';
import { describeBrowserError } from './browser-errors.mjs';

self.addEventListener('message', async event => {
  const { kind, version, expectedVersion, fixtures } = event.data;
  try {
    self.postMessage({ result: await runBrowserRuntime(kind, version, expectedVersion, fixtures) });
  } catch (error) {
    self.postMessage({ error: describeBrowserError(error) });
  }
}, { once: true });
