// Calls from a lower module up to a higher one, such as the git bridge refreshing the views or a
// view re-rendering the sidebar. Each higher module adds its functions here when it loads, so
// imports only point down and never form a cycle. Lower modules read from `up` inside functions,
// which run after every module has loaded.
export const up = {};
