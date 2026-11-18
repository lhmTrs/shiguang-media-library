"""Synthetic producer, real isolated local HTTP. Never contacts a generation platform."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import urllib.request
import uuid

root, origin, project, clip, revision, folder = sys.argv[1:]
sys.path.insert(0, root + '/scripts')
import workflow as w
library = w.Library(origin)
config = {'origin': origin, 'instanceId': library.instance, 'projectId': project,
          'shotIds': ['shot_0', 'shot_1'], 'lastVerifiedRevision': int(revision)}
state = {'name': '合成外置任务', 'readback_verified': True, 'prepare_stage': 'ready', 'count': 1,
         'settings': {'model': 'synthetic', 'resolution': '480p', 'ratio': '16:9', 'duration': 4, 'audio': True},
         'bound_prompt': '合成测试完整提示词', 'original_prompt': '合成测试完整提示词', 'assets': [],
         'project': 'synthetic-updream-project', 'draft_node_id': 'synthetic-node', 'storyboard_binding_v2': config}
journal = Path(root) / 'job.json'
w.save_state(journal, state)

class SyntheticClient:
    calls = 0
    def api(self, method, path):
        payload = w.build_payload(state)
        return {'node_config': {'params': {'prompt': state['bound_prompt'], 'model': 'synthetic',
                'generateType': 'ref2v', 'videoRefs': [], 'paramValues': {'duration': 4, 'resolution': '480p',
                'aspect_ratio': '16:9', 'audio': True, 'output_format': 'mp4'}}}}
    def request_json(self, method, path, payload=None, extra_headers=None):
        assert path == '/ai/generate-video/async'
        assert state['storyboard_origin_v2']['stage'] == 'reserved'
        # Prove the durable reservation exists before the synthetic platform submit.
        saved = json.loads(journal.read_text())
        assert saved['storyboard_origin_v2']['provenance']['provenanceId']
        self.calls += 1
        return {'task_id': 'synthetic-task-1', 'status': 'pending'}

client = SyntheticClient()
w.submit(state, journal, client, apply=True, authorized=True)
assert w.submit(state, journal, client, apply=True, authorized=True)['new_submissions'] == 0
original = state['storyboard_origin_v2']['provenance']
# Simulate a human edit while the platform is rendering, using only this fixture's local session.
view = library.api('GET', '/api/storyboard/projects/' + project)
view['project']['scenes'][0]['shots'][0]['action'] = '合成等待期间的新动作'
body = {'project': view['project'], 'expected_revision': view['revision'], 'request_id': str(uuid.uuid4())}
request = urllib.request.Request(origin + '/api/storyboard/projects/' + project, method='PUT',
          data=json.dumps(body).encode(), headers={**library.headers, 'Content-Type': 'application/json'})
with library.http.open(request) as response:
    assert json.load(response)['revision'] == int(revision) + 1
state['generation'].update(status='completed', video_url='https://example.invalid/not-fetched')
listing = library.api('GET', '/api/project-videos/projects/' + project)
filename = 'synthetic-updream-output.mp4'
state['delivery'] = {'target': {'origin': origin, 'instance': library.instance, 'project': project,
                     'folder_id': folder, 'filename': filename}, 'request_id': str(uuid.uuid4()),
                     'stage': 'downloading', 'download': clip, 'bytes': Path(clip).stat().st_size,
                     'sha256': hashlib.sha256(Path(clip).read_bytes()).hexdigest()}
w.save_state(journal, state)
w.deliver(state, journal, library, project, folder, filename, False)
assert state['delivery']['stage'] == 'ready' and state['delivery']['verified']
assert state['delivery']['binding']['verified']
# A ready reentry still reads the original receipt and binding, with no new import or paid submit.
request_id = state['delivery']['request_id']
w.deliver(state, journal, library, project, folder, filename, False)
assert state['delivery']['request_id'] == request_id and state['delivery']['binding']['verified']
result = library.api('GET', '/api/storyboard-video/v2/source-projects/' + project + '/videos/' + state['delivery']['video_id'] + '/binding')
assert result['binding']['storyboardRevision'] == int(revision)
assert result['review']['needsReview']
assert result['binding']['provenance'] == original
assert client.calls == 1
print(json.dumps({'taskCalls': client.calls, 'videoId': state['delivery']['video_id'],
                  'bindingVerified': True, 'storedRevision': result['binding']['storyboardRevision'],
                  'currentRevision': result['context']['storyboardRevision'], 'needsReview': result['review']['needsReview']}))
