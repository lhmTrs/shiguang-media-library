// 联调用的本机桌面替身：以 `node --import` 预加载进真实服务，替换视频与图片共用的
// ProjectVideoDesktopNative，使其不编译、不调用 Swift 助手，不触碰真实剪贴板和访达。
// 每次调用按行写进 ASSET_NATIVE_LOG（JSON），测试据此核对真正交给系统的原图路径。
import fs from 'node:fs';
import { ProjectVideoDesktopNative } from '../../server/project-videos/desktop-native.mjs';

const log = process.env.ASSET_NATIVE_LOG;
if (!log) throw Error('ASSET_NATIVE_LOG is required for the desktop native stub');
let changeCount = 7;
const record = entry => fs.appendFileSync(log, JSON.stringify(entry) + '\n');
const proto = ProjectVideoDesktopNative.prototype;
proto.helper = async function () { return '/stub-native-helper'; };
proto.invoke = async function () { throw Object.assign(Error('stub: real native helper must not run'), { code: 'NATIVE_FAILED' }); };
proto.capabilities = async function () { record({ op: 'capabilities' }); return { clipboard: { available: true }, revealMany: { available: true } }; };
proto.clipboardVersion = async function () { return changeCount; };
proto.copyFiles = async function (paths, { expectedChangeCount } = {}) {
  record({ op: 'copy', paths, expectedChangeCount });
  changeCount += 1; return { ack: 'written', count: paths.length, changeCount };
};
proto.revealFiles = async function (paths) { record({ op: 'reveal', paths }); return { ack: 'dispatched', count: paths.length }; };
