/**
 * 工作区连接态 / 目录树
 */

export function reduceWorkspace(state, action) {
  switch (action.type) {
    case 'ws/set':
      return { ...state, workspace: { ...state.workspace, ...action.patch } };
    case 'ws/bump':
      return { ...state, workspace: { ...state.workspace, entries: [...state.workspace.entries] } };
    case 'ws/entries':
      return { ...state, workspace: { ...state.workspace, entries: action.entries, loading: false, error: null } };
    case 'ws/mergeEntries': {
      const map = new Map((state.workspace.entries || []).map((e) => [e.path, e]));
      for (const e of action.entries || []) {
        if (e?.path) map.set(e.path, e);
      }
      return { ...state, workspace: { ...state.workspace, entries: [...map.values()] } };
    }
    default:
      return null;
  }
}
