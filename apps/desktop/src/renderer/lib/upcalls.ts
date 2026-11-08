// Calls from a lower module up to a higher one, such as the git bridge refreshing the views or a
// view re-rendering the sidebar. Each higher module adds its functions here when it loads, so
// imports only point down and never form a cycle. Lower modules read from `up` inside functions,
// which run after every module has loaded.
// A module that registers upcalls declares their types next to its Object.assign:
//   declare module '../lib/upcalls.ts' { interface Upcalls { renderView: typeof renderView } }
// Empty here: each registering module adds its own members (see above).
export interface Upcalls {}
// Empty until the higher modules load; every upcall is registered before any function reads it.
export const up = {} as Upcalls;
