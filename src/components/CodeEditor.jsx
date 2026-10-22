import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, rectangularSelection, crosshairCursor, placeholder } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { oneDark } from '@codemirror/theme-one-dark';
import { langOf } from '../lib/vfs.js';

function langExt(lang) {
  switch (lang) {
    case 'javascript':
    case 'typescript':
      return javascript({ jsx: true, typescript: lang === 'typescript' });
    case 'json':
      return json();
    case 'markdown':
      return markdown();
    case 'css':
      return css();
    case 'html':
      return html();
    default:
      return [];
  }
}

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: '#dbe3ef', height: '100%' },
  '.cm-content': { caretColor: '#2dd4bf', padding: '10px 0 60px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#4a5668', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(45,212,191,0.07)', color: '#2dd4bf' },
  '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.025)' },
  '.cm-selectionBackground, ::selection': { backgroundColor: 'rgba(45,212,191,0.22) !important' },
  '.cm-cursor': { borderLeftColor: '#2dd4bf' },
  '.cm-foldPlaceholder': { background: '#172030', border: 'none', color: '#8593a8' },
  '.cm-panels': { backgroundColor: '#0c1017', color: '#dbe3ef' },
});

export default function CodeEditor({ file, onChange }) {
  const applying = useRef(false);
  const host = useRef(null);
  const view = useRef(null);
  const currentPath = useRef('');

  // 切换文件时重建
  useEffect(() => {
    if (!host.current || !file) return;
    const state = EditorState.create({
      doc: file.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        foldGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true }),
        highlightSelectionMatches(),
        history(),
        placeholder('开始写点什么，或者让 Agent 帮你生成…'),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        langExt(langOf(file.path)),
        oneDark,
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          // 外部同步（磁盘变更 / Agent 写入）不算用户编辑，不应打上"未保存"标记
          if (u.docChanged && !applying.current) onChange?.(u.state.doc.toString());
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    currentPath.current = file.id;
    return () => {
      v.destroy();
      view.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // 外部（Agent 写入）改动同步进来
  useEffect(() => {
    const v = view.current;
    if (!v || !file) return;
    const cur = v.state.doc.toString();
    if (cur !== file.content) {
      applying.current = true;
      v.dispatch({ changes: { from: 0, to: cur.length, insert: file.content } });
      applying.current = false;
    }
  }, [file?.content, file?.id]);

  return <div className="editor-host" ref={host} />;
}
