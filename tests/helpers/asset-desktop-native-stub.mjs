// 联调用的本机桌面替身：以 `node --import` 预加载进真实服务，只替换 ProjectVideoDesktopNative 最底层的
// helper（不编译 Swift 助手）和 invoke（不启动子进程），按操作返回与原生助手同协议的回执。
// 其余——能力判断、剪贴板串行队列、派发前重新核对、识别结果挑选头部——都走真实服务逻辑。
// 不触碰真实剪贴板、访达和 Vision。每次调用按行写进 ASSET_NATIVE_LOG（JSON），测试据此核对。
// detect-face：按合成 PNG 的宽度决定结果——宽度为偶数时返回一张正脸，奇数时没有脸。
import fs from 'node:fs';
import { ProjectVideoDesktopNative } from '../../server/project-videos/desktop-native.mjs';

const log = process.env.ASSET_NATIVE_LOG;
if (!log) throw Error('ASSET_NATIVE_LOG is required for the desktop native stub');
let changeCount = 7;
const record = entry => fs.appendFileSync(log, JSON.stringify(entry) + '\n');
const png = file => { const b = fs.readFileSync(file); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };
const proto = ProjectVideoDesktopNative.prototype;
proto.helper = async function () { return '/stub-native-helper'; };
proto.invoke = async function (binary, request) {
  const ok = data => ({ protocol: 1, ok: true, ...data });
  switch (request.operation) {
    case 'capabilities': return ok({ clipboard: { available: true }, revealMany: { available: true } });
    case 'clipboard-version': return ok({ changeCount });
    case 'copy-files':
      record({ op: 'copy', paths: request.paths, expectedChangeCount: request.expectedChangeCount });
      if (request.expectedChangeCount !== changeCount) return Promise.reject(Object.assign(Error('CLIPBOARD_CHANGED'), { code: 'CLIPBOARD_CHANGED', effectUnknown: false }));
      changeCount += 1; return ok({ ack: 'written', count: request.paths.length, changeCount });
    case 'reveal-files': record({ op: 'reveal', paths: request.paths }); return ok({ ack: 'dispatched', count: request.paths.length });
    case 'detect-face': {
      const { width, height } = png(request.paths[0]); record({ op: 'detect-face', width, height });
      const faces = width % 2 === 0 ? [{ x: 0.42, y: 0.08, w: 0.16, h: 0.12, confidence: 0.98, yaw: 0 }] : [];
      return ok({ status: 'decoded', width, height, faces });
    }
    default: throw Object.assign(Error('stub: unknown native operation ' + request.operation), { code: 'NATIVE_FAILED' });
  }
};
