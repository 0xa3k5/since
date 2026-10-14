// Where a commit author lives on their code host, worked out offline from the email and the
// repo's web remote (no API calls). GitHub only for now.

const GITHUB = 'https://github.com';

// GitHub's private commit emails carry the login: "123+octo@users.noreply.github.com" or,
// for older accounts, "octo@users.noreply.github.com".
export function githubLogin(email) {
  const m = /^(?:\d+\+)?([a-z\d](?:[a-z\d-]{0,38}))@users\.noreply\.github\.com$/i.exec(String(email || '').trim());
  return m ? m[1] : null;
}

const onGithub = (web) => typeof web === 'string' && web.startsWith(`${GITHUB}/`);

// { url, label } for a person's profile link, or null when we can't place them.
// A noreply email gives the exact profile. Any other email on a GitHub repo opens that repo's
// commits by the author, where GitHub matches the email to the account and links its profile.
export function authorProfile(email, remoteWeb) {
  const login = githubLogin(email);
  if (login) return { url: `${GITHUB}/${login}`, label: `Open @${login} on GitHub` };
  const e = String(email || '').trim();
  if (onGithub(remoteWeb) && /^[^\s@]+@[^\s@]+$/.test(e)) {
    return { url: `${remoteWeb}/commits?author=${encodeURIComponent(e)}`, label: `Show ${e}’s commits on GitHub` };
  }
  return null;
}
