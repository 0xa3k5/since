// PR authors' GitHub avatars for the renderer: data: URLs from app:pr-avatars (the main process
// fetches and caches them, avatars.js). A login without one (a bot, GitHub Enterprise, offline)
// keeps its initials avatar.
const urls = new Map(); // login → data URL | null (asked, none)

export const prAvatar = (login) => (login && urls.get(login)) || null;

// The PR authors in `prs` not asked about yet go to fetch(logins) → { [login]: url }. Resolves true
// when a new image arrived (time to re-render). A failed call is asked again on the next refresh.
export async function loadAvatars(prs, fetch) {
  const want = [...new Set((prs || []).map((p) => p?.author).filter((l) => typeof l === 'string' && l && !urls.has(l)))];
  if (!want.length) return false;
  for (const l of want) urls.set(l, null);
  let got;
  try { got = (await fetch(want)) || {}; } catch { for (const l of want) urls.delete(l); return false; }
  let any = false;
  for (const l of want) {
    const u = got[l];
    if (typeof u === 'string' && u.startsWith('data:image/')) { urls.set(l, u); any = true; }
  }
  return any;
}

export const clearAvatars = () => urls.clear();
