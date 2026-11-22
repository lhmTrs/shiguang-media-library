// Translate only author-supplied static UI messages. Never apply to a response
// tree, a user draft, a filename, or arbitrary database content.
export function platformWords(message,platform=process.platform){
 if(platform==='darwin')return message;
 const manager=platform==='win32'?'资源管理器':'文件管理器';
 return message.replaceAll('在访达中显示','在文件夹中显示').replaceAll('访达次数','定位次数').replaceAll('访达',manager).replaceAll('废纸篓','回收站').replaceAll('这台 Mac','这台电脑').replaceAll('Mac 原生组件','系统组件');
}
