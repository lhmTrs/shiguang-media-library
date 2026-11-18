"""Reviewable, opt-in Updream adapter candidate. No paid calls or queue discovery.
Install together with the exact workflow patch only after separate approval.
"""
import json
import re
import uuid

PROJECT = re.compile(r"[a-fA-F0-9-]{36}")

def allowed_library_call(method, path):
    if path.startswith('/api/project-videos/projects/'):
        return True
    project = r'[a-fA-F0-9-]{36}'
    return bool(
        method == 'GET' and re.fullmatch('/api/storyboard/projects/' + project, path)
        or method == 'POST' and re.fullmatch('/api/storyboard-video/v2/projects/' + project + '/provenance', path)
        or method == 'GET' and re.fullmatch('/api/storyboard-video/v2/provenance/' + project, path)
        or method == 'GET' and re.fullmatch('/api/storyboard-video/v2/requests/' + project, path)
        or method == 'GET' and re.fullmatch('/api/storyboard-video/v2/source-projects/' + project + '/videos/' + project + '/binding', path)
    )

def reserve_before_submit(state, journal_path, save_state, library_factory):
    config = state.get('storyboard_binding_v2')
    if config is None:
        return None  # Existing unconfigured/in-flight jobs are never retrofitted.
    if not isinstance(config, dict) or not PROJECT.fullmatch(str(config.get('projectId', ''))):
        raise RuntimeError('新任务的分镜目标未明确，不提交生成')
    ids = config.get('shotIds')
    if not isinstance(ids, list) or not ids or len(set(ids)) != len(ids) or any(not isinstance(x, str) or not x for x in ids):
        raise RuntimeError('须明确该次生成使用的有序镜头ID，不按镜号猜测')
    library = library_factory(config['origin'])
    if library.instance != config.get('instanceId'):
        raise RuntimeError('素材库实例变化，不提交生成')
    original = state.get('storyboard_origin_v2')
    if original:
        if original['configuration'] != config:
            raise RuntimeError('出处配置已变化，不复用原预留或生成请求')
        if original.get('provenance'):
            current = library.api('GET', '/api/storyboard-video/v2/provenance/' + original['provenance']['provenanceId'])
            if current['provenance'] != original['provenance'] or current['status'] == 'released':
                raise RuntimeError('固定出处不可核验或已释放，不提交生成')
            return original
    elif state.get('generation'):
        raise RuntimeError('已有生成记录却没有生成前出处，不为旧任务补造')
    if original is None:
        view = library.api('GET', '/api/storyboard/projects/' + config['projectId'])
        if view['revision'] != config.get('lastVerifiedRevision'):
            raise RuntimeError('当前版不是自己最后verified写入版；先按Agent版本规则合并/同步再生成')
        original = {'configuration': dict(config), 'request': {'requestId': str(uuid.uuid4()),
                    'expectedStoryboardRevision': view['revision'], 'expectedAssetStamp': view['asset_stamp'], 'shotIds': list(ids)},
                    'provenance': None, 'stage': 'reserving'}
        state['storyboard_origin_v2'] = original
        save_state(journal_path, state)  # Persist before HTTP; lost responses reuse this exact ID/body.
    reserved = library.api('POST', '/api/storyboard-video/v2/projects/' + config['projectId'] + '/provenance', original['request'])
    p = reserved['provenance']
    if p['instanceId'] != library.instance or p['projectId'] != config['projectId'] or p['storyboardRevision'] != original['request']['expectedStoryboardRevision'] or p['shotIds'] != ids or reserved['status'] != 'reserved':
        raise RuntimeError('出处预留回读不符，不提交生成')
    original.update(provenance=p, revision=reserved['revision'], stage='reserved')
    save_state(journal_path, state)
    return original

def import_origin(state):
    config = state.get('storyboard_binding_v2')
    if config is None:
        return None
    original = state.get('storyboard_origin_v2')
    if not original or not original.get('provenance') or original['configuration'] != config:
        raise RuntimeError('缺少生成前固定出处，不在交付时拿当前版补记')
    return {'provenanceId': original['provenance']['provenanceId'], 'expectedProvenanceRevision': original['revision']}

def verify_bound(state, library, source_project_id, result):
    expected = import_origin(state)
    if expected is None:
        return None
    p = state['storyboard_origin_v2']['provenance']
    bound = result.get('binding', {})
    if result.get('status') != 'ready' or bound.get('status') != 'bound' or bound.get('provenanceId') != expected['provenanceId']:
        raise RuntimeError('视频登记不等于对应完成；保留原回执和下载，不换UUID再导入')
    readback = library.api('GET', '/api/storyboard-video/v2/source-projects/' + source_project_id + '/videos/' + result['videoId'] + '/binding')
    binding = readback.get('binding')
    if not binding or binding['bindingId'] != bound['bindingId'] or binding['origin'] != 'agent' or binding.get('provenance') != p or binding['targetProjectId'] != p['projectId'] or binding['documentId'] != p['documentId'] or binding['initializedAt'] != p['initializedAt'] or binding['storyboardRevision'] != p['storyboardRevision'] or [shot['shotId'] for shot in binding['shots']] != p['shotIds']:
        raise RuntimeError('固定生成出处与实际入库片子回读不符，保留下载')
    return {'bindingId': binding['bindingId'], 'bindingRevision': binding['revision'], 'provenanceId': p['provenanceId'], 'verified': True}
