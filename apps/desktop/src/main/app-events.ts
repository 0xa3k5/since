// The application menu shows state that several modules change (theme, tabs, updates, pull
// request settings). They ask for a rebuild here; menu.js listens. This keeps menu.js, which
// reads from all of them, out of their requires.

const menuListeners: (() => void)[] = [];
export function onMenuChange(fn: () => void): void { menuListeners.push(fn); }
export function menuChanged(): void { for (const fn of menuListeners) fn(); }

