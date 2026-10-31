import { runBrowserRuntime } from './browser-harness.mjs';

self.addEventListener('message', async event => {
  const { kind, version, expectedVersion, fixtures } = event.data;
  try {
    self.postMessage({ result: await runBrowserRuntime(kind, version, expectedVersion, fixtures) });
  } catch (error) {
    self.postMessage({ error: { name: error.name, message: error.message, stack: error.stack } });
  }
}, { once: true });
