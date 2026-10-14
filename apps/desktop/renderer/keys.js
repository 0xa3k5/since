// Key and pointer helpers for the commit map, kept out of app.js so they can be unit-tested.

// ⌘↵ (Ctrl+↵ off macOS) checks out the selected commit. Plain ↵ stays Quick view.
export const isCheckoutKey = (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;

// Inner controls of a graph row that must not trigger the row's double-click checkout.
const ROW_CONTROLS = '.pill, .avatar, .avatar-stack, button, a, input';
export const isRowControl = (target) => !!target?.closest?.(ROW_CONTROLS);

// ⌘⌥O (Ctrl+Alt+O off macOS) opens the recent-repository switcher. Uses e.code, since ⌥ turns the key into "ø".
export const isRepoSwitchKey = (e) => e.code === 'KeyO' && (e.metaKey || e.ctrlKey) && e.altKey && !e.shiftKey;
