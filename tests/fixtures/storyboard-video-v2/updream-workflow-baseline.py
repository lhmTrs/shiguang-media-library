#!/usr/bin/env python3
"""已准备草稿的单条生成、状态查询、拾光入库。无自动批量或失败后新任务重试。"""
import argparse
import fcntl
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
import uuid
from prepare import Client, NoRedirect, save_state


def request(client, method, path, data=None, extra_headers=None):
    allowed = (method == "POST" and path == "/ai/generate-video/async") or (
        method == "GET" and bool(re.fullmatch(r"/ai/task/[a-zA-Z0-9-]+", path)))
    if not allowed:
        raise RuntimeError("超出生成/查询接口范围")
    return client.request_json(method, path, payload=data, extra_headers=extra_headers)


def build_payload(state):
    if not state.get("readback_verified") or state.get("prepare_stage") != "ready" or state.get("count") != 1:
        raise RuntimeError("仅接受已回读的一条视频草稿")
    settings = state["settings"]
    prompt = state["bound_prompt"]
    refs = [a["url"] for a in state["assets"]]
    for i, asset in enumerate(state["assets"], 1):
        chip = "@[" + asset["name"] + "](" + asset["url"] + ")"
        if chip not in prompt:
            raise RuntimeError("提示词缺少对应素材绑定")
        prompt = prompt.replace(chip, f"[参考图{i}]")
    return {"prompt": prompt, "prompt_source": "original", "model_name": settings["model"],
            "project_id": str(state["project"]), "node_id": state["draft_node_id"],
            "generate_type": "ref2v", "ref_images": refs, "resolution": settings["resolution"],
            "aspect_ratio": settings["ratio"], "duration": settings["duration"],
            "supports_audio": settings["audio"], "num_videos": 1, "output_format": "mp4", "use_local": False}


def submit(state, path, client, apply=False, authorized=False, retry_uncertain=False):
    payload = build_payload(state)
    record = state.get("generation")
    if record and record.get("task_id"):
        return {"task_id": record["task_id"], "action": "existing_task", "new_submissions": 0}
    if not apply:
        return {"action": "preview", "count": 1, "node": payload["node_id"], **state["settings"]}
    if not authorized:
        raise RuntimeError("仅预填不构成生成授权；需当前任务明确授权后使用 --authorized-generation")
    node = client.api("GET", f'/canvas-nodes/{state["draft_node_id"]}')
    p = node["node_config"]["params"]
    expected = {"prompt": state["bound_prompt"], "model": state["settings"]["model"],
                "generateType": "ref2v", "videoRefs": payload["ref_images"]}
    expected_params = {"duration": payload["duration"], "resolution": payload["resolution"], "aspect_ratio": payload["aspect_ratio"], "audio": payload["supports_audio"], "output_format": "mp4"}
    if any(p.get(k) != v for k, v in expected.items()) or p.get("paramValues") != expected_params:
        raise RuntimeError("草稿内容或参数已变化，停止提交")
    # A lost response may already have created a paid task. Reuse the persisted key and body only.
    if record:
        if record["payload"] != payload or not retry_uncertain:
            raise RuntimeError("有结果未明的提交；先核对原任务，必要时用原幂等键 --retry-uncertain")
    else:
        if node.get("task_id"):
            raise RuntimeError("节点已有生成任务；先关联原任务，不能重复提交")
        record = {"status": "submitting", "idempotency_key": "video-" + uuid.uuid4().hex, "payload": payload}
        state["generation"] = record
        save_state(path, state)
    accepted = request(client, "POST", "/ai/generate-video/async", record["payload"], {"Idempotency-Key": record["idempotency_key"]})
    record.update(task_id=accepted["task_id"], status=accepted["status"], frozen_credits=accepted.get("frozen_credits"))
    state["generation_submitted"] = True
    save_state(path, state)
    return {k: record.get(k) for k in ["task_id", "status", "frozen_credits"]}


def status(state, path, client, wait_seconds=0):
    record = state.get("generation", {})
    if not record.get("task_id"):
        raise RuntimeError("没有已确认的任务编号，先处理提交结果不明")
    deadline = time.monotonic() + wait_seconds
    while True:
        response = request(client, "GET", "/ai/task/" + record["task_id"])
        record.update(status=response["status"], progress=response.get("progress"))
        if response["status"] in {"failed", "cancelled"}:
            record.update(error_code=response.get("error_code"), error=str(response.get("error") or "")[:240])
        if response["status"] == "completed":
            videos = response.get("result", {}).get("videos", [])
            if len(videos) != 1 or not videos[0].get("video_url"):
                raise RuntimeError("单条任务结果结构不符，保留现场")
            record["video_url"] = videos[0]["video_url"]
        save_state(path, state)
        if response["status"] not in {"pending", "processing"} or time.monotonic() >= deadline:
            return {k: record[k] for k in ["task_id", "status", "progress", "error_code", "error"] if k in record}
        time.sleep(min(10, max(0, deadline - time.monotonic())))


class Library:
    def __init__(self, origin):
        u = urlparse(origin)
        if u.scheme != "http" or u.hostname != "127.0.0.1" or not u.port or u.path or u.query or u.fragment or u.username:
            raise RuntimeError("素材库地址必须是本机 http://127.0.0.1:端口")
        self.origin = origin
        self.http = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        with self.http.open(origin + "/api/session", timeout=15) as r:
            session = json.load(r)
        self.headers = {"X-Local-Token": session["token"], "X-Shiguang-Library-Id": session["instanceId"]}
        self.instance = session["instanceId"]

    def api(self, method, path, payload=None, raw=None):
        if not path.startswith("/api/project-videos/projects/"):
            raise RuntimeError("只允许项目生成视频接口")
        h = {**self.headers, "Content-Type": "application/json" if payload is not None else "application/octet-stream"}
        data = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else raw
        try:
            with self.http.open(urllib.request.Request(self.origin + path, data=data, headers=h, method=method), timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"素材库 HTTP {e.code}；保留下载和导入回执") from None


def probe(path):
    p = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", str(path)]))
    if not any(s.get("codec_type") == "video" for s in p["streams"]):
        raise RuntimeError("下载结果没有视频流")
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    return p


def file_hash(path):
    with Path(path).open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def download_result(state, path, filename, download_root=None):
    """Download/validate an existing result before opening the local library.

    The durable receipt is separate from delivery, so a closed library cannot lose
    the download. No service credentials are ever sent to the fixed result CDN.
    Caller must hold the same journal lock as CLI operations.
    """
    generation = state.get("generation", {})
    if generation.get("status") != "completed" or not generation.get("video_url"):
        raise RuntimeError("任务尚未完成，不下载")
    if Path(filename).name != filename or not filename.lower().endswith(".mp4") or len(filename) > 240 or re.search(r'[<>:"/\\|?*\x00-\x1f]', filename):
        raise RuntimeError("文件名无效")
    receipt = state.get("download_result")
    if receipt:
        downloaded = Path(receipt["download"])
        if receipt.get("filename") != filename or receipt.get("download_deleted"):
            raise RuntimeError("下载目标改变或副本已清理，请核对原交付")
        if downloaded.is_symlink() or not downloaded.is_file() or file_hash(downloaded) != receipt["sha256"]:
            raise RuntimeError("下载内容发生变化，停止")
        if not receipt.get("probe"):
            receipt["probe"] = probe(downloaded)
            save_state(path, state)
        return receipt
    u = urlparse(generation["video_url"])
    if u.scheme != "https" or u.hostname != "boss-shjd.biliapi.net" or not u.path.startswith("/updream/aniforge/") or u.username or u.port:
        raise RuntimeError("结果CDN已变化，先重新核对，不向未知地址发送凭据")
    if download_root is not None:
        download_root = Path(download_root)
        download_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        info = download_root.lstat()
        if download_root.is_symlink() or not download_root.is_dir() or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("下载目录权限异常")
    if state.get("download_attempts", 0) >= 3:
        raise RuntimeError("下载重试上限已到，保留已有文件请人工核对")
    state["download_attempts"] = state.get("download_attempts", 0) + 1
    directory = Path(tempfile.mkdtemp(prefix="updream-download-", dir=download_root))
    downloaded = directory / filename
    # Record our owned partial path before network I/O. Never overwrite/reuse an
    # unverified partial result after a timeout or process interruption.
    state["download_pending"] = str(downloaded)
    save_state(path, state)
    fd = os.open(downloaded, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as out:
        with urllib.request.build_opener(NoRedirect()).open(generation["video_url"], timeout=120) as r:
            total = 0
            while chunk := r.read(1024 * 1024):
                total += len(chunk)
                if total > 512 * 1024 * 1024:
                    raise RuntimeError("结果超过512MB，保留临时文件并停止")
                out.write(chunk)
    receipt = {"download": str(downloaded), "filename": filename, "bytes": downloaded.stat().st_size,
               "sha256": file_hash(downloaded), "probe": probe(downloaded)}
    state["download_result"] = receipt
    state.pop("download_pending", None)
    save_state(path, state)
    return receipt


def deliver(state, path, library, project, folder, filename, delete_download=False):
    generation = state.get("generation", {})
    if generation.get("status") != "completed" or not generation.get("video_url"):
        raise RuntimeError("任务尚未完成，不下载或冒充入库")
    if not re.fullmatch(r"[a-fA-F0-9-]{36}", project):
        raise RuntimeError("拾光项目编号格式不符")
    if Path(filename).name != filename or not filename.lower().endswith(".mp4") or len(filename) > 240 or re.search(r'[<>:"/\\|?*\x00-\x1f]', filename):
        raise RuntimeError("文件名无效")
    ep = "/api/project-videos/projects/" + project
    listing = library.api("GET", ep)
    matches = [f for f in listing["folders"] if f.get("id") == folder or f.get("relativePath") == folder]
    if len(matches) != 1 or not matches[0].get("available"):
        raise RuntimeError("目标文件夹不唯一或不可用，不猜测创建")
    target = {"origin": library.origin, "instance": library.instance, "project": project, "folder_id": matches[0]["id"], "filename": filename}
    receipt = state.get("delivery")
    if receipt and receipt["target"] != target:
        raise RuntimeError("交付目标变化，停止复用原导入回执")
    if not receipt:
        if any(v.get("fileName") == filename and v.get("folderId") == target["folder_id"] for v in listing["videos"]):
            raise RuntimeError("目标已有同名视频，停止，不覆盖")
        receipt = {"target": target, "request_id": str(uuid.uuid4()), "stage": "downloading"}
        state["delivery"] = receipt
        save_state(path, state)
    if "download" not in receipt and receipt.get("stage") != "ready":
        downloaded = download_result(state, path, filename)
        receipt.update({k: downloaded[k] for k in ["download", "bytes", "sha256"]})
        save_state(path, state)
    if receipt.get("stage") != "ready":
        downloaded = Path(receipt["download"])
        if file_hash(downloaded) != receipt["sha256"]:
            raise RuntimeError("下载内容发生变化，停止导入")
        receipt["probe"] = probe(downloaded)
        if "import_body" not in receipt:
            receipt["import_body"] = {"requestId": receipt["request_id"], "folderId": target["folder_id"], "fileName": filename,
                "bytes": receipt["bytes"], "title": filename, "notes": "Updream候选；任务：" + generation["task_id"] + "；" + json.dumps(state["settings"], ensure_ascii=False),
                "prompt": {"mode": "new", "title": state["name"], "text": state["original_prompt"]}}
            receipt["stage"] = "importing"
            save_state(path, state)
        started = library.api("POST", ep + "/imports", receipt["import_body"])
        if started["status"] == "waiting":
            result = library.api("PUT", ep + "/imports/" + receipt["request_id"] + "/content", raw=downloaded.read_bytes())
        else:
            result = started
        if result["status"] != "ready":
            raise RuntimeError("导入尚未就绪；核对同一回执，不重新导入或覆盖")
        receipt["video_id"] = result["videoId"]
        save_state(path, state)
    listing = library.api("GET", ep)
    video = next(v for v in listing["videos"] if v["id"] == receipt["video_id"])
    prompt = next(p for p in listing["prompts"] if p["id"] == video["promptId"])
    destination = Path(video["path"])
    if video["folderId"] != target["folder_id"] or prompt["text"].strip() != state["original_prompt"].strip() or file_hash(destination) != receipt["sha256"]:
        raise RuntimeError("入库位置、提示词或文件内容回读不符，保留下载")
    receipt.update(stage="ready", file=str(destination), prompt_id=video["promptId"], verified=True)
    save_state(path, state)
    if delete_download and not receipt.get("download_deleted"):
        downloaded = Path(receipt["download"])
        if not downloaded.parent.name.startswith("updream-download-") or downloaded.is_symlink() or downloaded.resolve() == destination.resolve():
            raise RuntimeError("临时副本归属或内容不符，不删除")
        # A process can stop after unlink but before persisting download_deleted.
        # The library destination and prompt were verified above on every reentry;
        # an absent owned temporary path is already clean, not a reason to import
        # or download again. Existing bytes must still match before any deletion.
        if downloaded.exists():
            if file_hash(downloaded) != receipt["sha256"]:
                raise RuntimeError("临时副本归属或内容不符，不删除")
            downloaded.unlink()
        try:
            downloaded.parent.rmdir()
        except OSError:
            pass
        receipt["download_deleted"] = True
        if state.get("download_result", {}).get("download") == str(downloaded):
            state["download_result"]["download_deleted"] = True
        save_state(path, state)
    return {k: receipt.get(k) for k in ["stage", "file", "verified", "download_deleted"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("command", choices=["submit", "status", "deliver"])
    ap.add_argument("--state", required=True, type=Path)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--authorized-generation", action="store_true")
    ap.add_argument("--retry-uncertain", action="store_true")
    ap.add_argument("--wait-seconds", type=int, default=0, choices=range(0, 56), metavar="0..55")
    ap.add_argument("--library-origin", default="http://127.0.0.1:4317")
    ap.add_argument("--library-project")
    ap.add_argument("--folder")
    ap.add_argument("--file-name")
    ap.add_argument("--delete-download", action="store_true")
    args = ap.parse_args()
    # Serialize operations on the same journal to avoid two concurrent submissions.
    with args.state.with_suffix(args.state.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(args.state.read_text())
        if args.command == "submit":
            result = submit(state, args.state, Client(), args.apply, args.authorized_generation, args.retry_uncertain)
        elif args.command == "status":
            result = status(state, args.state, Client(), args.wait_seconds)
        else:
            if not all([args.library_project, args.folder, args.file_name]):
                ap.error("deliver 需要 --library-project、--folder、--file-name")
            result = deliver(state, args.state, Library(args.library_origin), args.library_project, args.folder, args.file_name, args.delete_download)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
