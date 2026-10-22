/** 检索引擎的可读名称 */
export function engineLabel(engine) {
  if (!engine || engine === 'vector') return '向量';
  if (engine === 'lexical') return '词频';
  if (engine === 'browser') return '浏览器向量';
  if (engine === 'neural') return '神经向量';
  return engine; // sqlite-vec / pgvector 等后端名直接展示
}
