import React, { useCallback, useEffect, useState } from 'react';
import { useToast } from '../state/toast.jsx';
import { probeBackends, switchBackend, migrateToPg } from '../lib/memoryBackend.js';

/**
 * 记忆后端切换：本地 sqlite（分区 vec0） ⇄ Postgres + pgvector（多机共享）
 *
 * - 状态来自 GET /api/mem/backend（两个后端各报各的能力）
 * - 切换走 POST /api/mem/backend，服务端只改一个门面变量，前端契约不变
 * - 「搬迁」把 sqlite 里的记忆 + 向量灌进 pgvector，用于真正上多机
 */
export default function MemoryBackendPanel() {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    const r = await probeBackends();
    setInfo(r);
    setErr(r.error || null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const current = info?.memoryBackend || '…';
  const pg = info?.pg;
  const sq = info?.sqlite;

  const doSwitch = async (be) => {
    setBusy(be);
    try {
      await switchBackend(be);
      await load();
      toast(be === 'pg' ? '已切到 pgvector 后端' : '已切回本地 sqlite', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  };

  const doMigrate = async () => {
    setBusy('migrate');
    try {
      const r = await migrateToPg();
      await load();
      toast(`已搬迁 ${r.migrated} 条（含向量 ${r.withVector} 条）到 pgvector`, 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="form-row" style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line-soft)' }}>
      <label>记忆后端（多机部署）</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className={`btn sm ${current === 'sqlite' ? 'primary' : ''}`} disabled={!!busy} onClick={() => doSwitch('sqlite')}>
          本地 sqlite · 分区 vec0
        </button>
        <button
          className={`btn sm ${current === 'pg' ? 'primary' : ''}`}
          disabled={!!busy || (pg && !pg.available)}
          onClick={() => doSwitch('pg')}
          title={pg && !pg.available ? pg.error || 'pgvector 不可用' : 'PGlite / 真实 Postgres'}
        >
          Postgres · pgvector
        </button>
        <button className="btn sm" disabled={!!busy || !(sq?.total > 0)} onClick={doMigrate}>
          {busy === 'migrate' ? '搬迁中…' : '迁移记忆到 pgvector'}
        </button>
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        {err ? <span className="bad">后端探测失败：{err}</span> : null}
        {sq ? (
          <div>
            sqlite：{sq.backend} · 分区键 <code>{sq.partitionKey || '-'}</code> · {sq.total ?? 0} 条 / {sq.vectors ?? 0} 条有向量
            {sq.bm25 ? ' · BM25 就绪' : ' · BM25 不可用'}
          </div>
        ) : null}
        {sq?.hot ? (
          <div>
            冷热分层：热点 <b>{sq.hot.rows}</b> 条（上限 {sq.hot.max}，进热条件 uses ≥ {sq.hot.minUses}）· 短路阈值距离{' '}
            {sq.hot.skipDist} · 命中 {sq.tierStats?.hotShortCircuit || 0} 次
          </div>
        ) : null}
        {sq?.ann && sq.ann.length ? (
          <div>
            二值量化 ANN：
            {sq.ann.map((a) => (
              <span key={a.user}>
                {' '}
                {a.user}
                {a.user === sq.currentUser ? '（当前）' : ''} {a.size} 条 / {(a.bytes / 1048576).toFixed(1)}MB / 建索引 {a.buildMs}ms
                {a.lastParallelMs ? ` / 上次扫描 ${a.lastParallelMs}ms` : ''}
                {a.upserts ? ` / 增量应用 ${a.upserts} 次` : ''}
                {a.dead ? ` / 墓碑 ${a.dead}` : ''}
              </span>
            ))}
            <span>
              {' '}
              · 阈值 {sq.annMin} 条以上自动启用 · 二值候选 {sq.annCand || 256} → 精排 {sq.annRerank || 96} 条
              {sq.annWarm?.warming ? ` · 后台建索引 ${sq.annWarm.done}/${sq.annWarm.total}` : ''}
              {sq.annPending?.length ? ` · 待应用变更 ${sq.annPending.reduce((n, p) => n + p.ups + p.dels, 0)} 条` : ''}
              {' '}· ANN 查询 {sq.tierStats?.annQueries || 0} 次 / 精确 {sq.tierStats?.exactQueries || 0} 次
            </span>
          </div>
        ) : (
          <div>二值量化 ANN：向量数超过 {sq?.annMin ?? 20000} 条后自动启用（当前不足，走精确 KNN）</div>
        )}
        {sq?.annPersist ? (
          <div>
            <span>
              索引落盘：{sq.annPersist.enabled ? '开' : '关'} · 已写 {sq.annPersist.saves} 次
              （全量 {sq.annPersist.full || 0} / 增量 {sq.annPersist.delta || 0}）
              {sq.annPersist.lastMode
                ? ` · 上次${sq.annPersist.lastMode === 'delta' ? '增量' : '全量'}写入 ${
                    sq.annPersist.lastBytes >= 1048576
                      ? `${(sq.annPersist.lastBytes / 1048576).toFixed(1)}MB`
                      : `${(sq.annPersist.lastBytes / 1024).toFixed(1)}KB`
                  } / ${sq.annPersist.lastMs}ms`
                : ''}
              {sq.annPersist.fails ? ` · 失败 ${sq.annPersist.fails}` : ''}
            </span>
            {(() => {
              // files 是「所有用户」的落盘记录，这里只关心当前用户那份文件
              const f = (sq.annPersist.files || []).find((x) => x.user === sq.currentUser);
              if (!f || f.covered == null) return null;
              return (
                <span>
                  {` · 文件覆盖 ${f.covered} 条 / 容量 ${f.capacity} 条`}
                  {f.dirty ? `（待写 ${f.dirty} 行）` : ''}
                </span>
              );
            })()}
            {(() => {
              const mine = (sq.ann || []).find((a) => a.user === sq.currentUser);
              if (!mine) return <span>（当前用户没有内存索引：向量数未达阈值或还没查过）</span>;
              return (
                <span>
                  {' · '}
                  {mine.disk?.fromFile
                    ? `本次从盘热启 ${mine.disk.loadMs}ms（补差 改 ${mine.disk.catchUp?.ups || 0} / 删 ${mine.disk.catchUp?.dels || 0}）`
                    : `本次未热启：${mine.disk?.reason || '内存里新建'}`}
                </span>
              );
            })()}
            <button
              type="button"
              className="mem-act"
              onClick={async () => {
                const r = await fetch('/api/mem/ann', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ action: 'reload' }),
                });
                const j = await r.json();
                toast(j.fromFile ? `已从盘上重载 ${j.size} 条 · ${j.loadMs}ms` : `未能重载：${j.reason}`, j.fromFile ? 'ok' : 'err');
                await load();
              }}
            >
              从盘重载
            </button>
          </div>
        ) : null}
        {pg ? (
          <div>
            pgvector：{pg.available ? pg.backend : '不可用'}
            {pg.pgvector ? ` · 扩展 ${pg.pgvector}` : ''}
            {pg.available ? ` · ${pg.total ?? 0} 条 / ${pg.vectors ?? 0} 条有向量（HNSW）` : ` · ${pg.error || ''}`}
          </div>
        ) : null}
        <div style={{ marginTop: 4 }}>
          sqlite 适合单机（索引即文件）；pgvector 适合多台 IDE 共享一套记忆 —— 两种后端下
          <code> /api/mem/search </code> 的返回结构完全一致，前端无需改动。切换只影响服务端门面，不迁移数据；
          要搬数据点「迁移记忆到 pgvector」。
        </div>
      </div>
    </div>
  );
}
