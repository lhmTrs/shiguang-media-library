import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const MAX_OUTPUT = 16384;
const MAX_PATH = 8192;
const FAILURE = "无法完成系统文件选择。请重试，或填写成片绝对路径";
const windowsScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '选择本时间线导出的成片'
$dialog.Filter = 'Video files|*.mp4;*.mov;*.m4v;*.avi;*.mkv;*.webm;*.mts;*.m2ts|All files|*.*'
$dialog.Multiselect = $false
$dialog.CheckFileExists = $true
$dialog.CheckPathExists = $true
$dialog.RestoreDirectory = $true
try {
  $selected = $null
  if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    $selected = $dialog.FileName
  }
  ConvertTo-Json -Compress -InputObject @{ path = $selected }
} finally {
  $dialog.Dispose()
}
`;
const macScript = `try
  return POSIX path of (choose file with prompt "选择本时间线导出的成片" of type {"public.movie"})
on error number -128
  return ""
end try`;

// A dialog emits precisely one scalar field. Reject duplicate or extra keys
// before JSON.parse; filenames remain JSON data and never enter a script.
const singlePathJSON = /^\{\s*"path"\s*:\s*(?:null|"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*")\s*\}$/;

function fullWindowsPath(value) {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f<>"|?*]/.test(value)) return false;
  // No drive-relative, single-rooted, device/extended namespace or ADS paths.
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    const tail = value.slice(3);
    return !tail.includes(":") && !tail.split(/[\\/]/).some(p => p === "." || p === "..");
  }
  if (!value.startsWith("\\\\") || value.includes(":")) return false;
  const parts = value.slice(2).split("\\");
  return parts.length >= 2 && !!parts[0] && !!parts[1] &&
    !parts[0].includes("/") && !parts[1].includes("/") &&
    !parts.some(p => p === "." || p === ".." || p.includes("/"));
}

export function filePickerAvailable(platform = process.platform, env = process.env) {
  return env.MEDIA_CONTAINER !== "1" && ["darwin", "win32"].includes(platform);
}

// Construction only creates an in-memory lock. It never opens files, starts a
// process, or saves an association; a caller must explicitly invoke the picker.
export function createFilePicker({ platform = process.platform, env = process.env, run = execute } = {}) {
  let active = false;
  return async function chooseFile() {
    if (!filePickerAvailable(platform, env)) throw Error("此环境不支持系统文件选择，请填写成片绝对路径");
    if (active) throw Error("文件选择窗口已打开，请先完成或取消选择");
    active = true;
    try {
      let selected;
      const options = { timeout: 120000, maxBuffer: MAX_OUTPUT, encoding: "utf8", shell: false };
      if (platform === "win32") {
        const systemRoot = env.SystemRoot || env.SYSTEMROOT || "C:\\Windows";
        // The executable is local to a fully rooted system drive, never UNC.
        if (!fullWindowsPath(systemRoot) || !/^[A-Za-z]:\\/.test(systemRoot)) throw Error("INVALID_SYSTEM_ROOT");
        const executable = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const { stdout } = await run(executable, ["-NoLogo", "-NoProfile", "-STA", "-EncodedCommand", Buffer.from(windowsScript, "utf16le").toString("base64")], { ...options, windowsHide: true });
        if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_OUTPUT) throw Error("INVALID_DIALOG_RESULT");
        const text = stdout.replace(/^\uFEFF/, "").trim();
        if (!singlePathJSON.test(text)) throw Error("INVALID_DIALOG_RESULT");
        selected = JSON.parse(text).path;
      } else {
        const { stdout } = await run("/usr/bin/osascript", ["-e", macScript], options);
        if (typeof stdout !== "string" || Buffer.byteLength(stdout) > MAX_OUTPUT) throw Error("INVALID_DIALOG_RESULT");
        selected = stdout.replace(/\r?\n$/, "");
      }
      if (selected === null || selected === "") return { cancelled: true };
      if (typeof selected !== "string" || selected.length > MAX_PATH || /[\x00-\x1f\x7f]/.test(selected) ||
          !(platform === "win32" ? fullWindowsPath(selected) : path.posix.isAbsolute(selected))) throw Error("INVALID_DIALOG_PATH");
      return { cancelled: false, path: selected };
    } catch {
      throw Error(FAILURE);
    } finally {
      active = false;
    }
  };
}

// Separate bounded multi-select entry; single-render picker behavior is unchanged.
export function createVideoFilesPicker({platform=process.platform,env=process.env,run=execute}={}){
 let active=false,closing=false;const work=new Set();const choose=async({single=false}={})=>{
  if(typeof single!=='boolean')throw Object.assign(Error('视频单选参数无效'),{status:400,code:'INVALID_PICKER_MODE'});
  if(closing||active)throw Object.assign(Error('视频选择正在进行或关闭中'),{status:423,code:'PICKER_BUSY'});if(!filePickerAvailable(platform,env))throw Object.assign(Error('此环境不支持系统多选，请填写视频绝对路径'),{status:503,code:'PICKER_UNAVAILABLE'});active=true;
  try{let paths;const options={timeout:120000,maxBuffer:262144,encoding:'utf8',shell:false};if(platform==='win32'){const root=env.SystemRoot||env.SYSTEMROOT||'C:\\Windows';if(!fullWindowsPath(root)||!/^[A-Za-z]:\\/.test(root))throw Error('INVALID_SYSTEM_ROOT');const script=windowsScript.replace('$dialog.Multiselect = $false','$dialog.Multiselect = '+(single?'$false':'$true')).replace('$selected = $dialog.FileName','$selected = @($dialog.FileNames)').replace('@{ path = $selected }','@{ paths = $selected }');const {stdout}=await run(path.win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoLogo','-NoProfile','-STA','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{...options,windowsHide:true});const data=JSON.parse(stdout.replace(/^\uFEFF/,'').trim());if(Object.keys(data).length!==1||!Object.hasOwn(data,'paths'))throw Error('INVALID_RESULT');paths=data.paths??[];}else{const script=`const app=Application.currentApplication();app.includeStandardAdditions=true;try{const files=app.chooseFile({withPrompt:"选择分镜预览视频（可多选）",ofType:["public.movie"],multipleSelectionsAllowed:${single?'false':'true'}});JSON.stringify({paths:[].concat(files).map(String)});}catch(e){if(e.errorNumber===-128)JSON.stringify({paths:[]});else throw e;}`;const {stdout}=await run('/usr/bin/osascript',['-l','JavaScript','-e',script],options);const data=JSON.parse(stdout.trim());if(Object.keys(data).length!==1||!Object.hasOwn(data,'paths'))throw Error('INVALID_RESULT');paths=data.paths;}
   if(!Array.isArray(paths)||paths.length>(single?1:32)||paths.some(p=>typeof p!=='string'||p.length>MAX_PATH||/[\x00-\x1f\x7f]/.test(p)||!(platform==='win32'?fullWindowsPath(p):path.posix.isAbsolute(p))))throw Error('INVALID_RESULT');return{cancelled:paths.length===0,paths};
  }catch(e){throw Object.assign(Error(single?'无法完成视频单选，请取消后使用一个视频绝对路径':'无法完成视频多选，请取消后使用绝对路径输入'),{status:e.status??400,code:e.code??'PICKER_FAILED'});}finally{active=false;}
 };
 return{choose(options){const promise=choose(options);work.add(promise);promise.finally(()=>work.delete(promise)).catch(()=>{});return promise;},async close(){closing=true;let timer;try{await Promise.race([Promise.allSettled([...work]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('文件选择尚未结清'),{code:'PICKER_UNSETTLED'})),1000);})]);}finally{clearTimeout(timer);}}};
}
