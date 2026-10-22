import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const Ctx = createContext(() => {});

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const seq = useRef(0);

  const push = useCallback((text, kind = 'ok', ttl = 2600) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { id, text, kind }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), ttl);
  }, []);

  const value = useMemo(() => push, [push]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-wrap">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="ic">{t.kind === 'err' ? '✕' : t.kind === 'mem' ? '◆' : '✓'}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
