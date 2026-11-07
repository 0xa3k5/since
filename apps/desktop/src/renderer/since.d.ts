// `window.since`, the bridge src/preload/preload.ts exposes.
import type { SinceBridge } from '../shared/ipc-contract.ts';

declare global {
  interface Window { since: SinceBridge }
}
