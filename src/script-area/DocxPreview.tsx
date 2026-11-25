// DOCX 预览：要装一个开源前端包（docx-preview 或 mammoth），装包是下载，等用户批准后接上。
// 在那之前 DOCX 只给下载，列表里不出现「预览」按钮。
import React from 'react';

export const docxPreviewAvailable = false;

export function DocxPreview({ downloadUrl, name }: { url: string; downloadUrl: string; name: string }) {
  return <p className="ca-muted">DOCX 暂时不能在页面里预览。<a href={downloadUrl} download={name}>下载原件</a>后用 Word 或 WPS 打开。</p>;
}
