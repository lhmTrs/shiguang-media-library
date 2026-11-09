import {INTAKE_API, type IntakeRequest} from './types';

type Session = {app: string; instanceId: string; token: string};
export async function intakeSession(signal?: AbortSignal): Promise<IntakeRequest> {
  async function session() {
    const response = await fetch('/api/session', {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])])});
    const value = await response.json() as Session;
    if (!response.ok || value.app !== 'shiguang-local-media' || !value.instanceId || !value.token) throw Error('无法确认拾光本机服务，请启动拾光后重新读取');
    return value;
  }
  const original = await session();
  return async <T,>(url: string, body?: unknown, method?: string, options?: {signal?: AbortSignal}): Promise<T> => {
    if (!url.startsWith(INTAKE_API + '/') || url.includes('://')) throw Error('收纳请求地址无效');
    const headers = new Headers(), verb = (method || (body === undefined ? 'GET' : 'POST')).toUpperCase();
    if (verb !== 'GET') {
      const current = await session();
      if (current.instanceId !== original.instanceId) throw Object.assign(Error('素材库实例已变化，请刷新并核对原收纳回执'), {code: 'LOCAL_INSTANCE_CHANGED'});
      headers.set('x-local-token', current.token);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetch('/api' + url, {method: verb, headers, ...(body === undefined ? {} : {body: JSON.stringify(body)}), credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(20000), ...(options?.signal ? [options.signal] : [])])});
    const value = await response.json();
    if (!response.ok) throw Object.assign(Error(value.error || value.message || '收纳请求未完成'), {status: response.status, code: value.code, accepted: value.accepted, requestId: value.requestId});
    return value as T;
  };
}
