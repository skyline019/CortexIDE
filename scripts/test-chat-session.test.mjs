/**
 * 多会话单源：chatSession helpers + reduceChat + coerceChatSource / sealChatForPersist
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeSession,
  titleFromMessages,
  normalizeStore,
  sanitizeMessages,
} from '../src/lib/chatSession.js';
import {
  reduceChat,
  sealChatForPersist,
  coerceChatSource,
  selectActiveMessages,
} from '../src/state/reducers/chat.js';

function baseState(over = {}) {
  const s = makeSession({ id: 'ses_a', title: 'A', messages: [{ id: 'm1', role: 'user', content: '你好世界' }] });
  return {
    chatSessions: [s],
    activeSessionId: s.id,
    messages: s.messages,
    stats: { promptTokens: 0, completionTokens: 0, turns: 0 },
    ...over,
  };
}

test('makeSession / titleFromMessages / sanitizeMessages', () => {
  const s = makeSession({ title: 'T', messages: [{ id: 1, role: 'user', content: 'x', pending: true }] });
  assert.ok(s.id);
  assert.equal(s.title, 'T');
  assert.equal(s.messages[0].pending, false);
  assert.equal(titleFromMessages([{ role: 'user', content: '  短标题  ' }]), '短标题');
  const long = 'a'.repeat(50);
  assert.ok(titleFromMessages([{ role: 'user', content: long }]).endsWith('…'));
  assert.equal(sanitizeMessages(null).length, 0);
});

test('normalizeStore：v1 仅 messages 收成单会话', () => {
  const store = normalizeStore({ messages: [{ role: 'user', content: '旧消息' }] }, '/ws');
  assert.equal(store.version, 2);
  assert.equal(store.sessions.length, 1);
  assert.equal(store.sessions[0].messages[0].content, '旧消息');
  assert.equal(store.activeSessionId, store.sessions[0].id);
});

test('coerceChatSource：空 sessions + 有 messages → 单会话', () => {
  const out = coerceChatSource({
    chatSessions: [],
    activeSessionId: null,
    messages: [{ id: 'u1', role: 'user', content: 'legacy' }],
  });
  assert.equal(out.chatSessions.length, 1);
  assert.equal(out.messages[0].content, 'legacy');
  assert.equal(out.activeSessionId, out.chatSessions[0].id);
});

test('reduceChat：新建 / 切换 / 删除不串台', () => {
  let st = baseState();
  st = reduceChat(st, { type: 'msg/add', message: { id: 'a2', role: 'assistant', content: '答A' } });
  st = reduceChat(st, { type: 'chat/new', title: 'B' });
  assert.equal(st.messages.length, 0);
  assert.equal(st.chatSessions.length, 2);
  const idB = st.activeSessionId;
  st = reduceChat(st, { type: 'msg/add', message: { id: 'b1', role: 'user', content: '只在B' } });
  assert.equal(st.messages.length, 1);
  assert.equal(st.messages[0].content, '只在B');

  const idA = st.chatSessions.find((s) => s.id !== idB).id;
  st = reduceChat(st, { type: 'chat/switch', id: idA });
  assert.ok(st.messages.some((m) => m.content === '你好世界'));
  assert.ok(!st.messages.some((m) => m.content === '只在B'));
  const bMsgs = st.chatSessions.find((s) => s.id === idB).messages;
  assert.equal(bMsgs.length, 1);
  assert.equal(bMsgs[0].content, '只在B');

  st = reduceChat(st, { type: 'chat/delete', id: idB });
  assert.equal(st.chatSessions.length, 1);
  assert.equal(st.activeSessionId, idA);
});

test('reduceChat：rename + bumpTokens 只动活动会话', () => {
  let st = baseState();
  st = reduceChat(st, { type: 'chat/rename', id: st.activeSessionId, title: '  重命名  ' });
  assert.equal(st.chatSessions[0].title, '重命名');
  st = reduceChat(st, { type: 'chat/bumpTokens', prompt: 10, completion: 5, bumpTurn: true });
  assert.equal(st.chatSessions[0].tokenUsage.prompt, 10);
  assert.equal(st.chatSessions[0].tokenUsage.completion, 5);
  assert.equal(st.stats.promptTokens, 10);
  assert.equal(st.stats.turns, 1);
});

test('sealChatForPersist：清 pending 并同步投影', () => {
  let st = baseState({
    messages: [{ id: 'p', role: 'assistant', content: '流式', pending: true }],
  });
  // 把投影写进活动会话后再 seal
  st = {
    ...st,
    chatSessions: st.chatSessions.map((s) =>
      s.id === st.activeSessionId ? { ...s, messages: st.messages } : s,
    ),
  };
  const sealed = sealChatForPersist(st);
  assert.equal(sealed.messages[0].pending, false);
  assert.equal(sealed.chatSessions[0].messages[0].pending, false);
});

test('chat/hydrate + selectActiveMessages', () => {
  const a = makeSession({ id: 'x', messages: [{ id: 1, role: 'user', content: 'x' }] });
  const b = makeSession({ id: 'y', messages: [{ id: 2, role: 'user', content: 'y' }] });
  const st = reduceChat(baseState(), {
    type: 'chat/hydrate',
    sessions: [a, b],
    activeSessionId: 'y',
  });
  assert.equal(st.activeSessionId, 'y');
  assert.equal(selectActiveMessages(st)[0].content, 'y');
});

test('msg/set 与 msg/clear', () => {
  let st = baseState();
  st = reduceChat(st, { type: 'msg/set', messages: [{ id: 'n', role: 'user', content: '替换' }] });
  assert.equal(st.messages.length, 1);
  st = reduceChat(st, { type: 'msg/clear' });
  assert.equal(st.messages.length, 0);
  assert.equal(st.chatSessions[0].messages.length, 0);
});
