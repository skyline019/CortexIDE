/** 桌面布局偏好：侧栏 / 对话是否展开（功能入口都还在） */
const KEY = 'cortex-layout-v1';

const defaults = () => ({
  sidebarOpen: true,
  chatOpen: true,
});

export function loadLayoutPrefs() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

export function saveLayoutPrefs(patch) {
  try {
    const next = { ...loadLayoutPrefs(), ...patch };
    localStorage.setItem(KEY, JSON.stringify(next));
    return next;
  } catch {
    return patch;
  }
}
