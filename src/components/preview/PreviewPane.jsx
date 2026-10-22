import React, { Suspense, lazy, useMemo } from 'react';
import { MarkdownDocument } from '../Markdown.jsx';
import { previewKind } from '../../lib/preview-kind.js';
import { XlsxPreview, DocxPreview, PptxPreview, CsvPreview, ImagePreview, BinaryPreview } from './Previewers.jsx';
import { VideoPreview, AudioPreview } from './MediaPreview.jsx';
// pdfjs 有 1MB+，只有真打开 PDF 时才加载 —— 平时不该为它付首屏代价
const PdfPreview = lazy(() => import('./PdfPreview.jsx'));

/**
 * 预览路由：按扩展名 / MIME 选渲染器。
 *
 * 为什么要按「文件类型」而不是「是不是二进制」分：
 * 之前二进制文件（pdf/docx/xlsx）点开之后是一个**空的代码编辑器**，用户以为文件坏了。
 * 现在二进制一律走预览，源码类文件仍然进 CodeMirror（Markdown 额外给一个「阅读」开关）。
 */

/** Markdown 的渲染器（阅读视图） */
export function MarkdownPreview({ file }) {
  // basePath 决定文档里相对图片路径按哪个目录解析（README 在根目录、docs/*.md 在 docs/）
  return <MarkdownDocument text={file?.content || ''} title={file?.path} basePath={file?.path || ''} />;
}

export default function PreviewPane({ file }) {
  const kind = useMemo(() => previewKind(file?.path, file), [file]);
  if (!file) return null;
  const { path, content } = file;

  // key=path：换文件整树复位（缩放/页码/活动表），避免 effect 里同步 setState
  switch (kind) {
    case 'image':
      return <ImagePreview key={path} path={path} />;
    case 'video':
      return <VideoPreview key={path} path={path} size={file.size} />;
    case 'audio':
      return <AudioPreview key={path} path={path} size={file.size} />;
    case 'pdf':
      return (
        <Suspense key={path} fallback={<div className="pv-center"><div className="pv-spinner" /><div>加载 PDF 渲染器…</div></div>}>
          <PdfPreview path={path} />
        </Suspense>
      );
    case 'docx':
      return <DocxPreview key={path} path={path} />;
    case 'xlsx':
      return <XlsxPreview key={path} path={path} />;
    case 'pptx':
      return <PptxPreview key={path} path={path} />;
    case 'csv':
      return <CsvPreview key={path} path={path} text={content} />;
    case 'markdown':
      return <MarkdownPreview key={path} file={file} />;
    case 'unsupported':
      return (
        <BinaryPreview
          key={path}
          path={path}
          hint="旧版 .doc / .ppt 是二进制格式，需要先另存为 .docx / .pptx（在线转换会泄露文件内容，这里不做）"
        />
      );
    case 'binary':
    default:
      return <BinaryPreview key={path} path={path} size={file.size} />;
  }
}

