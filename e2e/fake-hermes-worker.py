"""Deterministic JSONL Hermes worker used only by the Playwright harness."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path
from typing import Any


STATE_FILE = Path(os.environ["INDY_E2E_WORKER_STATE"])
RUNTIME_FILE = Path(os.environ["INDY_E2E_RUNTIME_FILE"])
WORKSPACE = os.environ["INDY_E2E_WORKSPACE"]
WRITE_LOCK = threading.Lock()
STATE_LOCK = threading.Lock()
ACTIVE: dict[str, threading.Event] = {}


def _read_json(path: Path, fallback: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else fallback
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def _state() -> dict[str, Any]:
    return _read_json(STATE_FILE, {"chats": [], "messages": {}})


def _save_state(value: dict[str, Any]) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_FILE.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, STATE_FILE)


def _send(payload: dict[str, Any]) -> None:
    with WRITE_LOCK:
        sys.__stdout__.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.__stdout__.flush()


def _result(request_id: str, data: dict[str, Any]) -> None:
    _send({"id": request_id, "type": "result", "data": data})


def _runtime_status() -> dict[str, Any]:
    control = _read_json(RUNTIME_FILE, {"authState": "connected"})
    auth_state = str(control.get("authState") or "connected")
    connected = auth_state == "connected"
    return {
        "provider": "openai-codex",
        "profileId": "etienne-openai" if connected else None,
        "authState": auth_state,
        "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "models": [{
            "id": "gpt-5.6-sol",
            "label": "gpt-5.6-sol",
            "reasoningEfforts": ["low", "medium", "high", "xhigh"],
        }] if connected else [],
    }


def _append_message(session_id: str, task_id: str, role: str, content: str) -> None:
    with STATE_LOCK:
        state = _state()
        messages = state.setdefault("messages", {}).setdefault(session_id, [])
        messages.append({
            "id": f"fake:{session_id}:{len(messages) + 1}",
            "task_id": task_id,
            "role": role,
            "content": content,
            "created_at": int(time.time() * 1000),
        })
        _save_state(state)


def _record_chat(request: dict[str, Any]) -> None:
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    with STATE_LOCK:
        state = _state()
        state.setdefault("chats", []).append({
            "sessionId": request.get("sessionId"),
            "taskId": request.get("taskId"),
            "message": request.get("message"),
            "provider": settings.get("provider"),
            "model": settings.get("model"),
            "reasoningEffort": settings.get("reasoningEffort"),
            "cwd": WORKSPACE,
        })
        _save_state(state)


def _chat(request: dict[str, Any]) -> None:
    request_id = str(request["id"])
    session_id = str(request.get("sessionId") or request_id)
    task_id = str(request.get("taskId") or session_id)
    message = str(request.get("message") or "")
    _record_chat(request)
    _append_message(session_id, task_id, "user", message)
    _send({"id": request_id, "type": "tool_progress", "tool": "terminal", "status": "running", "label": "terminal"})

    if "Attendre ma correction" in message:
        interrupted = threading.Event()
        with STATE_LOCK:
            ACTIVE[session_id] = interrupted
        interrupted.wait(timeout=300)
        with STATE_LOCK:
            ACTIVE.pop(session_id, None)
        _send({"id": request_id, "type": "done", "sessionId": session_id, "interrupted": True})
        return

    _send({"id": request_id, "type": "tool_progress", "tool": "terminal", "status": "completed", "duration": 12, "label": "terminal"})
    response = "Exécution déterministe terminée."
    _append_message(session_id, task_id, "assistant", response)
    _send({"id": request_id, "type": "text_delta", "content": response})
    _send({
        "id": request_id,
        "type": "done",
        "sessionId": session_id,
        "context": {"used_tokens": 32, "window_tokens": 128000},
    })


def _handle(request: dict[str, Any]) -> None:
    request_id = str(request.get("id") or "")
    request_type = request.get("type")
    if not request_id:
        return
    if request_type == "chat":
        threading.Thread(target=_chat, args=(request,), daemon=True).start()
    elif request_type == "chat.interrupt":
        session_id = str(request.get("sessionId") or "")
        with STATE_LOCK:
            active = ACTIVE.get(session_id)
            if active:
                active.set()
        _result(request_id, {"interrupted": active is not None})
    elif request_type == "health":
        _result(request_id, {"ok": True, "agentDir": "fake", "python": sys.executable})
    elif request_type == "runtime.status":
        _result(request_id, _runtime_status())
    elif request_type == "settings.get":
        _result(request_id, {
            "provider": "openai-codex", "model": "gpt-5.6-sol", "baseUrl": None,
            "apiMode": "responses", "reasoningEffort": "high", "showReasoning": True,
        })
    elif request_type == "settings.set":
        _result(request_id, {
            "provider": request.get("provider") or "openai-codex",
            "model": request.get("model") or "gpt-5.6-sol", "baseUrl": None,
            "apiMode": "responses", "reasoningEffort": request.get("reasoningEffort"),
            "showReasoning": True,
        })
    elif request_type == "models.list":
        _result(request_id, {
            "defaultModel": "gpt-5.6-sol", "activeProvider": "openai-codex",
            "groups": [{"provider": "openai-codex", "models": [{
                "id": "gpt-5.6-sol", "label": "gpt-5.6-sol", "source": "catalog",
                "provider": "openai-codex", "isCurrentDefault": True,
            }]}],
        })
    elif request_type == "scheduledTasks.list":
        _result(request_id, {"scheduledTasks": []})
    elif request_type == "scheduledTasks.tick":
        _result(request_id, {"executed": 0})
    elif request_type == "session.messages.get":
        session_id = str(request.get("sessionId") or "")
        with STATE_LOCK:
            messages = _state().get("messages", {}).get(session_id, [])
        _result(request_id, {"messages": messages})
    elif request_type == "session.get":
        session_id = str(request.get("sessionId") or "")
        _result(request_id, {"session": {
            "id": session_id, "input_tokens": 12, "output_tokens": 20,
            "cache_read_tokens": 0, "cache_write_tokens": 0, "reasoning_tokens": 4,
            "estimated_cost_usd": None, "cost_status": "oauth", "model": "gpt-5.6-sol",
        }})
    elif request_type == "title.generate":
        _result(request_id, {"title": "Inspection du dépôt"})
    else:
        _send({"id": request_id, "type": "error", "error": {"code": "unsupported", "message": f"Unsupported fake request: {request_type}"}})


def main() -> int:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            if isinstance(request, dict):
                _handle(request)
        except Exception as error:  # pragma: no cover - surfaced to the Node harness
            print(f"fake worker error: {error}", file=sys.stderr, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
