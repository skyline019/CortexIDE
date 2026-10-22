import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../state/toast.jsx';
import {
  fetchPrompts,
  savePrompt,
  composePrompt,
  fetchSkills,
  toggleSkill,
  saveSkill,
  deleteSkill,
} from '../lib/promptClient.js';

/**
 * 技能与提示词面板。
 *
 * 四页：
 *   系统技能   —— 内置、正文只读，可以整体开关（关掉的技能不会进提示词）
 *   当前技能   —— 这个工作区自己的 `.cortex/skills/*.md`，可增删改
 *   系统提示词 —— 内置基座 + 可编辑的覆盖稿（可一键恢复内置原文）
 *   当前提示词 —— 工作区约定，永远排在合成结果最后（压过通用规则）
 *
 * 右侧永远显示「合成预览」：真正会发给模型的那段文本 + 分段字符数 + 估算 token。
 * 这不是装饰 —— 改了提示词/技能到底有没有生效，就看这里。
 */

const TABS = [
  ['system', '系统技能'],
  ['workspace', '当前技能'],
  ['prompt', '系统提示词'],
  ['current', '当前提示词'],
];

const EMPTY_SKILL = { id: '', name: '', description: '', whenToUse: '', body: '', enabled: true };

export default function SkillsModal({ onClose }) {
  const toast = useToast();
  const [tab, setTab] = useState('system');
  const [skills, setSkills] = useState({ system: [], workspace: [] });
  const [prompts, setPrompts] = useState(null);
  const [mode, setMode] = useState('agent');
  const [compose, setCompose] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(null); // 选中的技能 id
  const [draft, setDraft] = useState(EMPTY_SKILL);
  const [systemDraft, setSystemDraft] = useState('');
  const [workspaceDraft, setWorkspaceDraft] = useState('');
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    const [sk, pr] = await Promise.all([fetchSkills(), fetchPrompts()]);
    setSkills({ system: sk.system || [], workspace: sk.workspace || [] });
    setPrompts(pr);
    setSystemDraft(pr.system.override ?? pr.system.effective ?? '');
    setWorkspaceDraft(pr.workspace.text || '');
    setDirty(false);
  }, []);

  useEffect(() => {
    load().catch((e) => toast(`加载失败：${e.message}`, 'err'));
  }, [load, toast]);

  // 合成预览：技能开关、提示词、模式任何一项变化都重新算
  useEffect(() => {
    let alive = true;
    composePrompt({ mode })
      .then((c) => alive && setCompose(c))
      .catch(() => alive && setCompose(null));
    return () => {
      alive = false;
    };
  }, [mode, skills, prompts]);

  const allSkills = useMemo(() => [...skills.system, ...skills.workspace], [skills]);
  const selected = allSkills.find((s) => s.id === sel) || null;

  useEffect(() => {
    if (tab === 'system' || tab === 'workspace') {
      const pool = tab === 'system' ? skills.system : skills.workspace;
      if (!pool.find((s) => s.id === sel)) {
        setSel(pool[0]?.id || null);
        setDraft(pool[0] ? { ...pool[0] } : EMPTY_SKILL);
      }
    }
  }, [tab, skills, sel]);

  const pick = (s) => {
    setSel(s.id);
    setDraft({ ...s });
  };

  const doToggle = async (s) => {
    try {
      const r = await toggleSkill(s.id, !s.enabled);
      setSkills({ system: r.system || [], workspace: r.workspace || [] });
      toast(`${s.name} 已${s.enabled ? '关闭' : '开启'}`, 'ok');
    } catch (e) {
      toast(`切换失败：${e.message}`, 'err');
    }
  };

  const doSaveSkill = async () => {
    if (!draft.name?.trim() || !draft.body?.trim()) {
      toast('技能名和正文都不能为空', 'err');
      return;
    }
    setBusy(true);
    try {
      const r = await saveSkill({
        id: draft.id || draft.name,
        name: draft.name,
        description: draft.description,
        whenToUse: draft.whenToUse,
        body: draft.body,
        enabled: draft.enabled !== false,
      });
      setSkills({ system: r.system || [], workspace: r.workspace || [] });
      toast(`已保存到 .cortex/skills/`, 'ok');
      setSel(draft.id || `ws.${String(draft.name).replace(/[^A-Za-z0-9_-]/g, '-')}`);
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!selected || selected.source === 'system') return;
    setBusy(true);
    try {
      const r = await deleteSkill(selected.id);
      setSkills({ system: r.system || [], workspace: r.workspace || [] });
      setSel(null);
      setDraft(EMPTY_SKILL);
      toast(`已删除 ${r.deleted || selected.id}`, 'ok');
    } catch (e) {
      toast(`删除失败：${e.message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const savePromptScope = async (scope) => {
    setBusy(true);
    try {
      const text = scope === 'system' ? systemDraft : workspaceDraft;
      await savePrompt({ scope, text, mode });
      await load();
      toast(scope === 'system' ? '系统提示词已保存' : '当前提示词已保存', 'ok');
    } catch (e) {
      toast(`保存失败：${e.message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  const resetSystem = async () => {
    setBusy(true);
    try {
      await savePrompt({ scope: 'system', text: '', mode });
      await load();
      toast('已恢复内置系统提示词', 'ok');
    } catch (e) {
      toast(`恢复失败：${e.message}`, 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sk-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="sk-modal">
        <div className="sk-head">
          <span className="sk-title">技能 · 提示词</span>
          <div className="sk-tabs">
            {TABS.map(([id, label]) => (
              <button key={id} className={`sk-tab ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
                {label}
                {id === 'system' ? ` ${skills.system.filter((s) => s.enabled).length}/${skills.system.length}` : ''}
                {id === 'workspace' ? ` ${skills.workspace.length}` : ''}
              </button>
            ))}
          </div>
          <span className="spacer" />
          {compose ? (
            <span className="pm-badge" title="合成结果会被真实发给模型（每轮重新合成）">
              {compose.chars} 字符 · ≈{compose.estTokens} tok · {compose.skillIds.length} 技能
            </span>
          ) : null}
          <button className="btn sm" onClick={onClose}>
            关闭
          </button>
        </div>

        <div className="sk-body">
          {(tab === 'system' || tab === 'workspace') && (
            <>
              <div className="sk-list">
                <div className="sk-group">
                  {tab === 'system' ? '系统技能（内置，只读）' : '当前技能（.cortex/skills）'}
                </div>
                {(tab === 'system' ? skills.system : skills.workspace).map((s) => (
                  <div key={s.id} className={`sk-item ${sel === s.id ? 'on' : ''}`} onClick={() => pick(s)}>
                    <div className="sk-item-top">
                      <span className={`sk-src ${s.source}`}>{s.source === 'system' ? 'SYS' : 'WS'}</span>
                      <span className="sk-name">{s.name}</span>
                      <button
                        type="button"
                        className={`sk-switch ${s.enabled ? 'on' : ''}`}
                        title={s.enabled ? '点击关闭（不进提示词）' : '点击开启'}
                        onClick={(e) => {
                          e.stopPropagation();
                          doToggle(s);
                        }}
                      />
                    </div>
                    <div className="sk-desc">{s.description || s.whenToUse || '（无描述）'}</div>
                  </div>
                ))}
                {tab === 'workspace' ? (
                  <button
                    className="btn sm"
                    style={{ width: '100%', marginTop: 6 }}
                    onClick={() => {
                      setSel(null);
                      setDraft(EMPTY_SKILL);
                    }}
                  >
                    + 新建当前技能
                  </button>
                ) : null}
                {tab === 'workspace' && !skills.workspace.length ? (
                  <div className="sk-empty">还没有当前技能。点上面新建一个，会写成 `.cortex/skills/&lt;id&gt;.md`。</div>
                ) : null}
              </div>

              <div className="sk-detail">
                {selected || draft.name || tab === 'workspace' ? (
                  <>
                    <div className="sk-field">
                      <div className="sk-label">
                        技能名
                        {selected?.source === 'system' ? <span className="sk-src system">系统技能正文只读</span> : null}
                      </div>
                      <input
                        className="sk-input"
                        value={draft.name || ''}
                        readOnly={selected?.source === 'system'}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                        placeholder="例如：发布检查清单"
                      />
                    </div>
                    <div className="sk-field">
                      <div className="sk-label">一句话描述</div>
                      <input
                        className="sk-input"
                        value={draft.description || ''}
                        readOnly={selected?.source === 'system'}
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                        placeholder="给列表里看的一句话"
                      />
                    </div>
                    <div className="sk-field">
                      <div className="sk-label">什么时候该用（会进提示词，模型靠它判断）</div>
                      <input
                        className="sk-input"
                        value={draft.whenToUse || ''}
                        readOnly={selected?.source === 'system'}
                        onChange={(e) => setDraft({ ...draft, whenToUse: e.target.value })}
                        placeholder="例如：用户要求发版 / 上线前检查时"
                      />
                    </div>
                    <div className="sk-field">
                      <div className="sk-label">
                        正文（步骤清单，模型会照着做）
                        <span className="sk-meta">{(draft.body || '').length} 字符</span>
                      </div>
                      <textarea
                        className="sk-textarea"
                        value={draft.body || ''}
                        readOnly={selected?.source === 'system'}
                        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      />
                    </div>
                    <div className="sk-actions">
                      {selected?.source === 'system' ? (
                        <>
                          <span className="sk-meta">
                            系统技能改不了正文，但可以开关；要定制就复制成「当前技能」。
                          </span>
                          <button
                            className="btn sm"
                            onClick={() => {
                              setTab('workspace');
                              setSel(null);
                              setDraft({
                                ...EMPTY_SKILL,
                                name: `${selected.name}（定制）`,
                                description: selected.description,
                                whenToUse: selected.whenToUse,
                                body: selected.body,
                              });
                            }}
                          >
                            复制为当前技能
                          </button>
                        </>
                      ) : (
                        <>
                          <button className="btn primary sm" disabled={busy} onClick={doSaveSkill}>
                            {draft.id ? '保存' : '创建'}
                          </button>
                          {selected ? (
                            <button className="btn sm" disabled={busy} onClick={doDelete}>
                              删除
                            </button>
                          ) : null}
                          <span className="sk-meta">
                            {selected?.file ? selected.file : '会写到 .cortex/skills/<id>.md'}
                          </span>
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="sk-empty">左边选一个技能</div>
                )}
              </div>
            </>
          )}

          {(tab === 'prompt' || tab === 'current') && (
            <div className="pm-wrap">
              <div className="pm-col">
                <div className="pm-head">
                  <b>{tab === 'prompt' ? '系统提示词' : '当前提示词'}</b>
                  <span className="pm-path">
                    {tab === 'prompt' ? '.cortex/prompt/system.md（留空 = 用内置）' : '.cortex/prompt/workspace.md'}
                  </span>
                  {tab === 'prompt' && prompts?.system.overridden ? <span className="pm-badge warn">已覆盖</span> : null}
                </div>
                <div className="pm-col-body">
                  <textarea
                    className="pm-textarea"
                    value={tab === 'prompt' ? systemDraft : workspaceDraft}
                    onChange={(e) => {
                      setDirty(true);
                      if (tab === 'prompt') setSystemDraft(e.target.value);
                      else setWorkspaceDraft(e.target.value);
                    }}
                    spellCheck={false}
                  />
                  <div className="sk-actions">
                    <button className="btn primary sm" disabled={busy} onClick={() => savePromptScope(tab === 'prompt' ? 'system' : 'workspace')}>
                      保存
                    </button>
                    {tab === 'prompt' ? (
                      <>
                        <button className="btn sm" disabled={busy} onClick={resetSystem}>
                          恢复内置
                        </button>
                        <span className="sk-meta">
                          内置版本 v{prompts?.system.version ?? '—'} · {prompts?.system.base.length ?? 0} 字符
                        </span>
                      </>
                    ) : (
                      <span className="sk-meta">{dirty ? '未保存' : '已同步'} · 排在合成结果最后，用来压过通用规则</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="pm-col" style={{ flex: 1.15 }}>
                <div className="pm-head">
                  <b>合成预览</b>
                  <span className="pm-path">真正发给模型的文本</span>
                  <span className="spacer" />
                  <div className="pm-modes">
                    {['agent', 'ask', 'plan'].map((m) => (
                      <button key={m} className={`sk-tab ${mode === m ? 'on' : ''}`} onClick={() => setMode(m)}>
                        {m}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pm-col-body">
                  <div className="pm-sections">
                    {(compose?.sections || []).map((s) => (
                      <span key={s.key} className="pm-sec" title={s.title}>
                        {s.title} <b>{s.chars}</b>
                      </span>
                    ))}
                  </div>
                  <div className="pm-composed">{compose?.composed || '（合成中…）'}</div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
