/**
 * 文件列表 + 打开标签 + 当前活动文件
 */

export function reduceFilesTabs(state, action) {
  switch (action.type) {
    case 'file/write': {
      const { file } = action;
      const exists = state.files.some((f) => f.id === file.id);
      const files = exists ? state.files.map((f) => (f.id === file.id ? file : f)) : [...state.files, file];
      const openTabs = state.openTabs.includes(file.id) ? state.openTabs : [...state.openTabs, file.id];
      return { ...state, files, openTabs, activeFileId: file.id };
    }
    case 'file/update':
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id ? { ...f, content: action.content, updatedAt: Date.now(), dirty: true } : f,
        ),
      };
    case 'file/save':
      return {
        ...state,
        files: state.files.map((f) => (f.id === action.id ? { ...f, dirty: false, savedAt: Date.now() } : f)),
      };
    case 'file/rename':
      return {
        ...state,
        files: state.files.map((f) => (f.id === action.id ? { ...f, path: action.path, updatedAt: Date.now() } : f)),
      };
    case 'file/delete': {
      const files = state.files.filter((f) => f.id !== action.id);
      const openTabs = state.openTabs.filter((id) => id !== action.id);
      const activeFileId =
        state.activeFileId === action.id ? (openTabs.length ? openTabs[openTabs.length - 1] : null) : state.activeFileId;
      return { ...state, files, openTabs, activeFileId };
    }
    case 'files/modeReset': {
      const files = state.files.filter((f) => f.real);
      const openTabs = state.openTabs.filter((id) => files.some((f) => f.id === id));
      return { ...state, files, openTabs, activeFileId: openTabs[openTabs.length - 1] || null };
    }
    case 'file/diskSync':
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id
            ? { ...f, content: action.content, dirty: false, ext: { before: action.before, after: action.content, at: Date.now() } }
            : f,
        ),
      };
    case 'file/extClear':
      return { ...state, files: state.files.map((f) => (f.id === action.id ? { ...f, ext: null } : f)) };
    case 'file/markStale':
      return {
        ...state,
        files: state.files.map((f) => (f.id === action.id ? { ...f, stale: true } : f)),
      };
    case 'file/open': {
      const openTabs = state.openTabs.includes(action.id) ? state.openTabs : [...state.openTabs, action.id];
      return { ...state, activeFileId: action.id, openTabs };
    }
    case 'file/close': {
      const openTabs = state.openTabs.filter((id) => id !== action.id);
      const activeFileId =
        state.activeFileId === action.id ? (openTabs.length ? openTabs[openTabs.length - 1] : null) : state.activeFileId;
      return { ...state, openTabs, activeFileId };
    }
    default:
      return null;
  }
}
