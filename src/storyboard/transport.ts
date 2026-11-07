import {hostReads} from '../host-read';
// Uses the media application's origin and session, ignoring old standalone settings.
export function createStoryboardTransport() {
  const apiBase = '/api/storyboard';
  let instanceId: string | undefined;
  const identityChanged = () => {
    window.dispatchEvent(new Event('shiguang-library-identity-changed'));
    return Object.assign(Error('素材库实例已变化，请刷新页面并核对当前素材库后继续'), { code: 'LOCAL_INSTANCE_CHANGED' });
  };
  const assertCurrent = async (signal?: AbortSignal) => {
    if (!instanceId) throw Object.assign(Error('素材库身份尚未确认，请重新读取'), { code: 'LOCAL_INSTANCE_UNKNOWN' });
    const response = await hostReads.fetch('/api/session', { credentials: 'same-origin', signal });
    if (!response.ok) throw Error('素材管理器会话不可用');
    const session = await response.json();
    if (session.app !== 'shiguang-local-media' || typeof session.token !== 'string' || !session.token || typeof session.instanceId !== 'string') throw Error('本机会话身份无效');
    if (session.instanceId !== instanceId) throw identityChanged();
  };
  const request = (path: string, options: RequestInit = {}) => {
    if (!path.startsWith('/api/')) throw Error('分镜接口路径无效');
    return hostReads.fetch(apiBase + path.slice(4), { ...options, credentials: 'same-origin', signal: options.signal ?? AbortSignal.timeout(20000) }, assertCurrent);
  };
  return {
    origin: location.origin,
    apiBase,
    url: (path: string) => apiBase + path.slice(4),
    request,
    video(projectId:string,path='',options:RequestInit={}) {
      if(path&&!/^\/[a-zA-Z0-9_/?=&%.-]*$/.test(path))throw Error('视频预览接口路径无效');
      return hostReads.fetch('/api/storyboard-video/projects/'+encodeURIComponent(projectId)+path,{...options,credentials:'same-origin',signal:options.signal??AbortSignal.timeout(30000)}, assertCurrent);
    },
    async projectAssets(projectId:string,kind:string,page=1,q='') {
      const params=new URLSearchParams({project_id:projectId,kind,page:String(page),q});
      const res=await hostReads.fetch('/api/project-assets/assets?'+params,{credentials:'same-origin',signal:AbortSignal.timeout(20000)}, assertCurrent);
      const data=await res.json();if(!res.ok)throw Error(data.error??'项目资产读取失败');return data;
    },
    async session() {
      const response = await hostReads.fetch('/api/session', { credentials: 'same-origin', signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw Error('素材管理器会话不可用');
      const session = await response.json();
      if (session.app !== 'shiguang-local-media' || typeof session.token !== 'string' || !session.token || typeof session.instanceId!=='string' || !session.instanceId) throw Error('本机会话身份无效');
      if (instanceId && instanceId !== session.instanceId) throw identityChanged();
      instanceId = session.instanceId;
      const workspace = await request('/api/workspace');
      if (!workspace.ok) throw Error('分镜模块不可用');
      const info = await workspace.json();
      if (info.integrated !== true || typeof info.workspace !== 'string') throw Error('分镜模块版本不匹配');
      return { token: session.token, workspace: info.workspace, instanceId:session.instanceId as string };
    },
  };
}
export type StoryboardTransport = ReturnType<typeof createStoryboardTransport>;
