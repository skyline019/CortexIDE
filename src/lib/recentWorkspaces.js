const KEY = 'cortex-recent-ws-v1';
const MAX = 9;

export function loadRecentWorkspaces() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((x) => x && x.path).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function rememberWorkspace(root) {
  if (!root) return loadRecentWorkspaces();
  const name = String(root).replace(/[/\\]+$/, '').split(/[/\\]/).pop() || root;
  const next = [
    { path: root, name, at: Date.now() },
    ...loadRecentWorkspaces().filter((x) => x.path !== root),
  ].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

export function removeRecentWorkspace(root) {
  const next = loadRecentWorkspaces().filter((x) => x.path !== root);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}
