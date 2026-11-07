// How a coding agent shows in git (AK-393): one list for the main process (git.js agentGuess, which
// marks lanes) and the renderer (review-rows.js messageAgent, Catch up's reader), so both screens
// name the same agents.
export const AGENT_HINTS = Object.freeze({
  // Branch name prefixes coding agents give the branches they create.
  prefixes: Object.freeze(['claude/', 'codex/', 'copilot/', 'cursor/', 'devin/', 'agent/', 'agents/', 'ai/']),
  // A word in a Co-Authored-By trailer (name or email) that means a coding agent.
  coauthors: Object.freeze(['claude', 'anthropic', 'codex', 'openai', 'copilot', 'cursor', 'devin', 'aider', 'gemini', 'jules', 'openhands', 'sweep', 'cline', 'windsurf', 'codeium']),
  // Trailer keys only agents write.
  trailers: Object.freeze(['generated-by', 'generated-with', 'agent', 'ai-agent', 'assisted-by']),
});
