"""Scheduled task operations for the Hermes worker.

Wraps Hermes's `cron.jobs` / `cron.scheduler` modules with input validation,
shape normalization, and a background ticker thread.
"""

from __future__ import annotations

import ast
import importlib.metadata
import json
import inspect
import os
import re
import sys
import textwrap
import threading
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from hermes_worker_utils import (
    WorkerError,
    json_safe,
    string_or_none,
)


_SCHEDULED_TASKS_TICKER_STARTED = False
_SCHEDULED_TASKS_TICKER_LOCK = threading.Lock()
_SCHEDULED_TASKS_HOOK_LOCK = threading.Lock()
_HOOKED_SCHEDULER: Any = None
_ORIGINAL_RUN_JOB: Any = None
_ORIGINAL_FALLBACK_CHAIN: Any = None
_NO_FALLBACK_CONTEXT: ContextVar[bool] = ContextVar("indy_cron_no_fallback", default=False)
_OCCURRENCE_DISPATCH_TOKEN: ContextVar[str | None] = ContextVar("indy_cron_dispatch_token", default=None)

_OAUTH_PROVIDER = "openai-codex"
_OAUTH_PROFILE = "etienne-openai"
_SUPPORTED_HERMES_AGENT_VERSIONS = frozenset({"0.15.1"})
_KNOWN_REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
_SENSITIVE_KEY_PARTS = (
    "token", "key", "secret", "credential", "authorization", "cookie",
    "password", "passwd", "pwd", "passphrase",
)
_QUOTED_AUTHORIZATION = re.compile(
    r'''(?i)((?:"|')(?:proxy[_-]?)?authorization(?:"|')\s*:\s*)(?:"[^"]*"|'[^']*')'''
)
_PLAIN_AUTHORIZATION = re.compile(
    r'''(?i)(\b(?:proxy[_-]?)?authorization\s*[:=]\s*)[^\r\n]*'''
)
_SENSITIVE_TEXT = re.compile(
    r'''(?i)(bearer\s+)[^\s,;]+|((?:"|')?(?:(?:access[_-]?)?token|api[_-]?key|secret|credential|password|passwd|pwd|passphrase)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)'''
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _redact_text(value: Any) -> str:
    raw = _QUOTED_AUTHORIZATION.sub(r'\1"[REDACTED]"', str(value or ""))
    raw = _PLAIN_AUTHORIZATION.sub(r"\1[REDACTED]", raw)

    def replace(match: re.Match[str]) -> str:
        if match.group(1):
            return f"{match.group(1)}[REDACTED]"
        return f"{match.group(2)}[REDACTED]"

    return _SENSITIVE_TEXT.sub(replace, raw)


def _redact_value(value: Any) -> Any:
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if any(part in str(key).lower() for part in _SENSITIVE_KEY_PARTS) else _redact_value(child)
            for key, child in value.items()
        }
    return value


def _fresh_runtime_status() -> dict[str, Any]:
    import hermes_worker

    return hermes_worker._runtime_status()


def _scheduled_workdir_roots() -> list[Path]:
    minions_home = Path(os.environ.get("MINIONS_HOME", str(Path.home() / ".minions"))).expanduser()
    raw_roots = [str(minions_home / "workspace")]
    configured = os.environ.get("INDY_SCHEDULED_WORKDIRS", "")
    if configured:
        raw_roots.extend(part for part in configured.split(os.pathsep) if part.strip())
    roots: list[Path] = []
    for raw in raw_roots:
        try:
            candidate = Path(raw.strip()).expanduser().resolve(strict=True)
            if candidate.is_dir() and candidate not in roots:
                roots.append(candidate)
        except (OSError, RuntimeError):
            continue
    return roots


def _is_within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _execution_policy(job: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, str] | None]:
    runtime = _fresh_runtime_status()

    def refusal(code: str, field: str, message: str) -> tuple[None, dict[str, str]]:
        return None, {"code": code, "field": field, "message": message}

    auth_state = string_or_none(runtime.get("authState"))
    if auth_state == "expired":
        return refusal("SCHEDULED_OAUTH_EXPIRED", "runtime", "La connexion Codex OAuth a expiré.")
    if auth_state == "missing":
        return refusal("SCHEDULED_OAUTH_MISSING", "runtime", "Codex OAuth n’est pas connecté.")
    if auth_state != "connected":
        return refusal("SCHEDULED_RUNTIME_UNAVAILABLE", "runtime", "Le catalogue Codex OAuth frais est indisponible.")
    if string_or_none(runtime.get("profileId")) != _OAUTH_PROFILE:
        return refusal("SCHEDULED_PROFILE_UNSUPPORTED", "profileId", "Le profil OAuth actif doit être etienne-openai.")

    provider = string_or_none(job.get("provider"))
    if not provider:
        return refusal("SCHEDULED_PROVIDER_REQUIRED", "provider", "Le provider openai-codex doit être explicite.")
    if provider != _OAUTH_PROVIDER:
        return refusal("SCHEDULED_PROVIDER_UNSUPPORTED", "provider", "Seul le provider OAuth openai-codex est autorisé.")

    model_id = string_or_none(job.get("model"))
    if not model_id:
        return refusal("SCHEDULED_MODEL_REQUIRED", "model", "Un modèle Codex explicite est requis.")
    models = runtime.get("models") if isinstance(runtime.get("models"), list) else []
    model = next((item for item in models if isinstance(item, dict) and item.get("id") == model_id), None)
    if model is None:
        return refusal("SCHEDULED_MODEL_UNAVAILABLE", "model", "Ce modèle n’est pas disponible dans le catalogue OAuth frais.")

    effort = string_or_none(job.get("reasoning_effort"))
    if not effort:
        return refusal("SCHEDULED_EFFORT_REQUIRED", "reasoningEffort", "Un effort de raisonnement explicite est requis.")
    efforts = model.get("reasoningEfforts")
    if not isinstance(efforts, list):
        return refusal("SCHEDULED_EFFORT_CAPABILITIES_UNAVAILABLE", "reasoningEffort", "Les efforts supportés ne sont pas publiés.")
    if effort not in efforts:
        return refusal("SCHEDULED_EFFORT_UNSUPPORTED", "reasoningEffort", "Cet effort n’est pas supporté par le modèle sélectionné.")

    raw_workdir = string_or_none(job.get("workdir"))
    if not raw_workdir:
        return refusal("SCHEDULED_WORKDIR_REQUIRED", "workdir", "Un dossier de travail enregistré côté serveur est requis.")
    try:
        workdir = Path(raw_workdir).expanduser().resolve(strict=True)
        if not workdir.is_dir():
            raise OSError("not a directory")
    except (OSError, RuntimeError):
        return refusal("SCHEDULED_WORKDIR_UNAVAILABLE", "workdir", "Le dossier de travail n’existe pas ou n’est pas accessible.")
    if not any(_is_within(root.resolve(strict=True), workdir) for root in _scheduled_workdir_roots()):
        return refusal("SCHEDULED_WORKDIR_NOT_ALLOWED", "workdir", "Le dossier de travail sort du registre autorisé.")
    return {
        "provider": provider,
        "model": model_id,
        "reasoningEffort": effort,
        "workdir": str(workdir),
    }, None


def _safe_file_segment(value: Any) -> str:
    raw = string_or_none(value) or "unknown"
    return re.sub(r"[^A-Za-z0-9._-]", "_", raw)[:160] or "unknown"


def _manifest_root() -> Path:
    hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
    return hermes_home / "cron" / "indy-manifests"


def _atomic_immutable_json(path: Path, value: dict[str, Any]) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return False
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    try:
        os.link(temporary, path)
        return True
    except FileExistsError:
        return False
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _atomic_replace_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    os.replace(temporary, path)


def _dispatch_receipt_path(dispatch_token: str) -> Path:
    return _manifest_root() / "dispatch-receipts" / f"{_safe_file_segment(dispatch_token)}.json"


def _read_dispatch_receipt(dispatch_token: str) -> dict[str, Any] | None:
    try:
        value = json.loads(_dispatch_receipt_path(dispatch_token).read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


def get_scheduled_task_dispatch_receipt(job_id: Any, dispatch_token: Any) -> dict[str, Any]:
    scheduled_task_id = _validate_path_segment(job_id, "Scheduled task ID")
    token = _validate_path_segment(dispatch_token, "Dispatch token")
    receipt = _read_dispatch_receipt(token)
    if receipt is not None and receipt.get("scheduledTaskId") != scheduled_task_id:
        raise WorkerError("Dispatch token belongs to another scheduled task.", code="bad_request")
    return {"dispatchReceipt": receipt}


def _failed_dispatch_receipt(token: str, scheduled_task_id: str, code: str, message: str, status: int) -> dict[str, Any]:
    return {
        "token": token,
        "scheduledTaskId": scheduled_task_id,
        "state": "failed",
        "failedAt": _utc_now(),
        "code": code,
        "message": _redact_text(message),
        "status": status,
    }


def _before_dispatch_job_update() -> None:
    """Crash-test seam immediately before Hermes's atomic job mutation."""


def _after_dispatch_job_update() -> None:
    """Crash-test seam after Hermes persisted the token with run-now state."""


def _after_occurrence_pending_write() -> None:
    """Crash-test seam after durable pending evidence exists."""


def _after_occurrence_receipt_bind() -> None:
    """Crash-test seam after the receipt is bound to a real Hermes execution."""


def _after_occurrence_token_clear() -> None:
    """Crash-test seam after the one-shot job token is durably cleared."""


def _before_occurrence_runner() -> None:
    """Crash-test seam immediately before the admitted Hermes runner."""


def _runtime_snapshot(job: dict[str, Any], runtime: dict[str, Any] | None = None) -> dict[str, Any]:
    source = runtime or {}
    raw_effort = _redact_text(source.get("reasoningEffort") or job.get("reasoning_effort")) or None
    return {
        "scheduledTaskName": _redact_text(string_or_none(job.get("name")) or string_or_none(job.get("id")) or "unknown"),
        "provider": _redact_text(source.get("provider") or job.get("provider")) or "<missing>",
        "model": _redact_text(source.get("model") or job.get("model")) or "<missing>",
        "reasoningEffort": raw_effort if raw_effort in _KNOWN_REASONING_EFFORTS else None,
        "workdir": _redact_text(source.get("workdir") or job.get("workdir")) or None,
    }


def _pending_occurrence_path(job_id: str, execution_id: str) -> Path:
    return _manifest_root() / _safe_file_segment(job_id) / f"{_safe_file_segment(execution_id)}.pending.json"


def _terminal_occurrence_path(job_id: str, execution_id: str) -> Path:
    return _manifest_root() / _safe_file_segment(job_id) / f"{_safe_file_segment(execution_id)}.json"


def _write_pending_occurrence(
    job_id: str,
    execution_id: str,
    snapshot: dict[str, Any],
    dispatch_token: str | None,
    refusal: dict[str, str] | None = None,
) -> Path:
    pending_path = _pending_occurrence_path(job_id, execution_id)
    output_ref = pending_path.with_name(f"{_safe_file_segment(execution_id)}.output.json")
    clean = _runtime_snapshot({"id": job_id, "name": snapshot.get("scheduledTaskName")}, snapshot)
    _atomic_replace_json(pending_path, {
        "schemaVersion": 1,
        "hermesRunId": execution_id,
        "scheduledTaskId": job_id,
        **clean,
        "dispatchToken": dispatch_token,
        "outputRef": str(output_ref),
        "refusal": refusal,
    })
    return output_ref


def _prepare_occurrence(
    job: dict[str, Any],
    execution_id: str,
    runtime: dict[str, Any],
    refusal: dict[str, str] | None,
) -> Path:
    job_id = string_or_none(job.get("id")) or "unknown"
    return _write_pending_occurrence(
        job_id,
        execution_id,
        _runtime_snapshot(job, runtime),
        _OCCURRENCE_DISPATCH_TOKEN.get(),
        refusal,
    )


def _write_occurrence_output(output_ref: Path, output: Any) -> None:
    safe_output = _redact_value(json_safe(output))
    _atomic_immutable_json(output_ref, {"body": _redact_text(safe_output)})


def _find_dispatch_evidence(job_id: str, token: str) -> str | None:
    directory = _manifest_root() / _safe_file_segment(job_id)
    matches: set[str] = set()
    try:
        paths = list(directory.glob("*.pending.json")) + [
            path for path in directory.glob("*.json")
            if not path.name.endswith(".pending.json") and not path.name.endswith(".output.json")
        ]
    except OSError:
        return None
    for path in paths:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if value.get("scheduledTaskId") == job_id and value.get("dispatchToken") == token:
            occurrence_id = string_or_none(value.get("hermesRunId"))
            if occurrence_id:
                matches.add(occurrence_id)
    if len(matches) > 1:
        raise RuntimeError("Hermes dispatch token is bound to multiple occurrences")
    return next(iter(matches), None)


def _ensure_bound_receipt_pending(receipt: dict[str, Any]) -> None:
    job_id = string_or_none(receipt.get("scheduledTaskId"))
    execution_id = string_or_none(receipt.get("occurrenceId"))
    token = string_or_none(receipt.get("token"))
    snapshot = receipt.get("configSnapshot")
    if not job_id or not execution_id or not token or not isinstance(snapshot, dict):
        return
    if _terminal_occurrence_path(job_id, execution_id).exists() or _pending_occurrence_path(job_id, execution_id).exists():
        return
    _write_pending_occurrence(job_id, execution_id, snapshot, token)


def _recover_bound_receipt_pending_manifests() -> None:
    directory = _manifest_root() / "dispatch-receipts"
    try:
        receipts = list(directory.glob("*.json"))
    except OSError:
        return
    for path in receipts:
        try:
            receipt = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(receipt, dict) and receipt.get("state") == "accepted":
                _ensure_bound_receipt_pending(receipt)
        except (OSError, ValueError, TypeError):
            continue


def _finalize_pending_manifests_once() -> int:
    _recover_bound_receipt_pending_manifests()
    root = _manifest_root()
    try:
        pending_paths = list(root.glob("*/*.pending.json"))
    except OSError:
        return 0
    if not pending_paths:
        return 0
    try:
        from cron.executions import list_executions
    except Exception:
        return 0
    finalized = 0
    for pending_path in pending_paths:
        try:
            pending = json.loads(pending_path.read_text(encoding="utf-8"))
            execution_id = string_or_none(pending.get("hermesRunId"))
            job_id = string_or_none(pending.get("scheduledTaskId"))
            if not execution_id or not job_id:
                continue
            record = next((row for row in list_executions(job_id=job_id, limit=500) if row.get("id") == execution_id), None)
            if not isinstance(record, dict) or record.get("status") not in {"completed", "failed"}:
                continue
            started_at = string_or_none(record.get("started_at"))
            finished_at = string_or_none(record.get("finished_at"))
            if not started_at or not finished_at:
                continue
            manifest = {
                **pending,
                "startedAt": started_at,
                "finishedAt": finished_at,
                "status": record["status"],
                "error": _redact_text(record.get("error")) or None,
                "provenance": {"source": "indy-hermes-run-job-hook", "evidence": "cron.executions"},
            }
            if pending.get("refusal") is None:
                manifest.pop("refusal", None)
            terminal_path = pending_path.with_name(pending_path.name.replace(".pending.json", ".json"))
            _atomic_immutable_json(terminal_path, manifest)
            if terminal_path.exists():
                pending_path.unlink(missing_ok=True)
                finalized += 1
        except (OSError, ValueError, TypeError):
            continue
    return finalized


def _associate_dispatch_token_with_occurrence(job: dict[str, Any], execution_id: str) -> str | None:
    token = string_or_none(job.get("indy_dispatch_token"))
    job_id = string_or_none(job.get("id"))
    if not token or not job_id:
        return None
    import cron.jobs as jobs

    with jobs._jobs_lock():
        receipt = _read_dispatch_receipt(token)
        if not isinstance(receipt, dict) or receipt.get("scheduledTaskId") != job_id or receipt.get("state") not in {"prepared", "accepted"}:
            return None
        associated = string_or_none(receipt.get("occurrenceId"))
        current = jobs.get_job(job_id)
        if associated:
            _ensure_bound_receipt_pending(receipt)
            if isinstance(current, dict) and current.get("indy_dispatch_token") == token:
                jobs.update_job(job_id, {"indy_dispatch_token": None})
                _after_occurrence_token_clear()
            return token if associated == execution_id else None
        if not isinstance(current, dict) or current.get("indy_dispatch_token") != token:
            return None
        evidence_id = _find_dispatch_evidence(job_id, token)
        snapshot = receipt.get("configSnapshot")
        if not isinstance(snapshot, dict):
            snapshot = _runtime_snapshot(current)
        bound_execution_id = evidence_id or execution_id
        if evidence_id is None:
            _write_pending_occurrence(job_id, execution_id, snapshot, token)
            _after_occurrence_pending_write()
        accepted = {
            **receipt,
            "state": "accepted",
            "acceptedAt": receipt.get("acceptedAt") or _utc_now(),
            "configSnapshot": snapshot,
            "occurrenceId": bound_execution_id,
            "consumedAt": _utc_now(),
        }
        _atomic_replace_json(_dispatch_receipt_path(token), accepted)
        _after_occurrence_receipt_bind()
        jobs.update_job(job_id, {"indy_dispatch_token": None})
        _after_occurrence_token_clear()
        return token if bound_execution_id == execution_id else None


def _controlled_run_job(job: Any, *args: Any, **kwargs: Any) -> Any:
    original = _ORIGINAL_RUN_JOB
    if original is None:
        raise RuntimeError("Hermes scheduled task hook is not installed")
    candidate = job if isinstance(job, dict) else {}
    execution_id = string_or_none(kwargs.get("execution_id")) or string_or_none(candidate.get("execution_id"))
    if not execution_id:
        raise RuntimeError("Hermes cron direct execution denied: durable execution_id is unavailable")
    dispatch_token = _associate_dispatch_token_with_occurrence(candidate, execution_id)
    dispatch_context = _OCCURRENCE_DISPATCH_TOKEN.set(dispatch_token)
    try:
        runtime, refusal = _execution_policy(candidate)
        if refusal is not None:
            fallback_runtime = {
                "provider": string_or_none(candidate.get("provider")),
                "model": string_or_none(candidate.get("model")),
                "reasoningEffort": string_or_none(candidate.get("reasoning_effort")),
                "workdir": string_or_none(candidate.get("workdir")),
            }
            message = f"{refusal['code']}: {refusal['message']}"
            output_ref = _prepare_occurrence(candidate, execution_id, fallback_runtime, refusal)
            _write_occurrence_output(output_ref, message)
            return False, message, "", message
        output_ref = _prepare_occurrence(candidate, execution_id, runtime, None)
        try:
            _before_occurrence_runner()
            no_fallback = _NO_FALLBACK_CONTEXT.set(True)
            try:
                result = original(job, *args, **kwargs)
            finally:
                _NO_FALLBACK_CONTEXT.reset(no_fallback)
        except Exception as exc:
            _write_occurrence_output(output_ref, exc)
            raise
        output = result[1] if isinstance(result, tuple) and len(result) > 1 else result
        _write_occurrence_output(output_ref, output)
        return result
    finally:
        _OCCURRENCE_DISPATCH_TOKEN.reset(dispatch_context)


def _installed_hermes_version() -> str | None:
    try:
        return importlib.metadata.version("hermes-agent")
    except importlib.metadata.PackageNotFoundError:
        return None


def _call_first_argument_is(tree: ast.AST, function_name: str, argument_name: str) -> bool:
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        called = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else None
        if called == function_name and node.args and isinstance(node.args[0], ast.Name) and node.args[0].id == argument_name:
            return True
    return False


def _tick_execution_id_contract(tree: ast.AST) -> bool:
    creates_execution = any(
        isinstance(node, ast.Call)
        and ((isinstance(node.func, ast.Name) and node.func.id == "create_execution")
             or (isinstance(node.func, ast.Attribute) and node.func.attr == "create_execution"))
        for node in ast.walk(tree)
    )
    dispatch_injection = any(
        isinstance(node, ast.keyword)
        and node.arg == "execution_id"
        and isinstance(node.value, ast.Subscript)
        and isinstance(node.value.value, ast.Name)
        and node.value.value.id == "execution"
        and isinstance(node.value.slice, ast.Constant)
        and node.value.slice.value == "id"
        for node in ast.walk(tree)
    )
    claim_copy = any(
        isinstance(node, (ast.Assign, ast.AnnAssign))
        and isinstance(node.targets[0] if isinstance(node, ast.Assign) else node.target, ast.Subscript)
        and ast.unparse(node.targets[0] if isinstance(node, ast.Assign) else node.target) == "claimed_job['execution_id']"
        and ast.unparse(node.value) == "job['execution_id']"
        for node in ast.walk(tree)
        if getattr(node, "value", None) is not None
    )
    return creates_execution and dispatch_injection and claim_copy and _call_first_argument_is(tree, "run_one_job", "claimed_job")


def _validate_execution_hook_contract(scheduler: Any, _jobs: Any = None) -> bool:
    if _installed_hermes_version() not in _SUPPORTED_HERMES_AGENT_VERSIONS:
        return False
    runner = getattr(scheduler, "run_job", None)
    tick = getattr(scheduler, "tick", None)
    run_one_job = getattr(scheduler, "run_one_job", None)
    run_one_body = getattr(scheduler, "_run_one_job_body", None)
    if not all(callable(value) for value in (runner, tick, run_one_job, run_one_body)):
        return False
    try:
        parameters = inspect.signature(runner).parameters
        tick_tree = ast.parse(textwrap.dedent(inspect.getsource(tick)))
        one_tree = ast.parse(textwrap.dedent(inspect.getsource(run_one_job)))
        body_tree = ast.parse(textwrap.dedent(inspect.getsource(run_one_body)))
    except (TypeError, ValueError, OSError, SyntaxError, IndentationError):
        return False
    return (
        "job" in parameters
        and _tick_execution_id_contract(tick_tree)
        and _call_first_argument_is(one_tree, "_run_one_job_body", "job")
        and _call_first_argument_is(body_tree, "run_job", "job")
    )


def install_scheduled_task_execution_hook() -> None:
    global _HOOKED_SCHEDULER, _ORIGINAL_RUN_JOB, _ORIGINAL_FALLBACK_CHAIN
    _ensure_imports()
    import cron.scheduler as scheduler

    with _SCHEDULED_TASKS_HOOK_LOCK:
        if _HOOKED_SCHEDULER is scheduler and scheduler.run_job is _controlled_run_job:
            return
        if not _validate_execution_hook_contract(scheduler):
            raise RuntimeError("Unsupported Hermes cron scheduler contract; scheduled execution is disabled")
        _ORIGINAL_RUN_JOB = scheduler.run_job
        scheduler.run_job = _controlled_run_job
        original_fallback = getattr(scheduler, "get_fallback_chain", None)
        if callable(original_fallback):
            _ORIGINAL_FALLBACK_CHAIN = original_fallback

            def scoped_fallback(config: Any) -> Any:
                return [] if _NO_FALLBACK_CONTEXT.get() else _ORIGINAL_FALLBACK_CHAIN(config)

            scheduler.get_fallback_chain = scoped_fallback
        _HOOKED_SCHEDULER = scheduler


def _ensure_imports() -> None:
    # Lazy import so this module does not need a top-level dep on hermes_worker.
    # `hermes_worker._ensure_imports()` adds the Hermes agent dir to sys.path,
    # making `cron.jobs` / `cron.scheduler` importable below.
    import hermes_worker

    hermes_worker._ensure_imports()


def _normalize_scheduled_task(job: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(job, dict):
        return None

    job_id = string_or_none(job.get("id")) or ""
    raw_schedule = job.get("schedule")
    raw_origin = job.get("origin")
    raw_skills = job.get("skills")
    if raw_skills is None and job.get("skill"):
        raw_skills = [job.get("skill")]
    raw_context_from = job.get("context_from")
    if isinstance(raw_context_from, str):
        context_from = [raw_context_from]
    elif isinstance(raw_context_from, list):
        context_from = [str(item) for item in raw_context_from if str(item).strip()]
    else:
        context_from = []
    raw_repeat = job.get("repeat")

    return {
        "id": job_id,
        "name": string_or_none(job.get("name")) or job_id,
        "prompt": string_or_none(job.get("prompt")),
        "schedule": json_safe(raw_schedule) if isinstance(raw_schedule, dict) else None,
        "scheduleDisplay": string_or_none(job.get("schedule_display")),
        "enabled": bool(job.get("enabled", True)),
        "state": string_or_none(job.get("state")),
        "nextRunAt": string_or_none(job.get("next_run_at")),
        "lastRunAt": string_or_none(job.get("last_run_at")),
        "lastStatus": string_or_none(job.get("last_status")),
        "lastError": string_or_none(job.get("last_error")),
        "lastDeliveryError": string_or_none(job.get("last_delivery_error")),
        "model": string_or_none(job.get("model")),
        "provider": string_or_none(job.get("provider")),
        "reasoningEffort": string_or_none(job.get("reasoning_effort")),
        "baseUrl": string_or_none(job.get("base_url")),
        "deliver": string_or_none(job.get("deliver")),
        "origin": json_safe(raw_origin) if isinstance(raw_origin, dict) else None,
        "repeat": json_safe(raw_repeat) if isinstance(raw_repeat, dict) else None,
        "contextFrom": context_from,
        "skills": [str(item) for item in raw_skills] if isinstance(raw_skills, list) else [],
        "workdir": string_or_none(job.get("workdir")),
        "createdAt": string_or_none(job.get("created_at")),
    }


def _validate_path_segment(value: Any, label: str) -> str:
    raw = string_or_none(value)
    if not raw:
        raise WorkerError(f"{label} is required.", code="bad_request")
    if "/" in raw or "\\" in raw or ".." in raw:
        raise WorkerError(f"Invalid {label}.", code="bad_request")
    return raw


def _require_string(value: Any, label: str) -> str:
    raw = string_or_none(value)
    if not raw:
        raise WorkerError(f"{label} is required.", code="bad_request")
    return raw


def _int_or_none(value: Any) -> int | None:
    if value is None or value == "":
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise WorkerError("repeat must be a number.", code="bad_request") from exc
    return parsed if parsed > 0 else None


def _list_of_strings(value: Any) -> list[str] | None:
    if value is None:
        return None
    if not isinstance(value, list):
        raise WorkerError("skills must be a list of strings.", code="bad_request")
    return [str(item).strip() for item in value if str(item).strip()]


def _repeat_update(value: Any) -> dict[str, Any]:
    return {"times": _int_or_none(value), "completed": 0}


def _build_update_dict(request: dict[str, Any]) -> dict[str, Any]:
    updates: dict[str, Any] = {}

    string_fields = ("name", "prompt", "schedule", "deliver", "skills", "model", "provider", "workdir")
    for field in string_fields:
        if field not in request:
            continue
        if field == "skills":
            skills = _list_of_strings(request.get(field))
            updates["skills"] = skills
            updates["skill"] = skills[0] if skills else None
        else:
            updates[field] = string_or_none(request.get(field))

    if "baseUrl" in request:
        updates["base_url"] = string_or_none(request.get("baseUrl"))
    if "reasoningEffort" in request:
        updates["reasoning_effort"] = string_or_none(request.get("reasoningEffort"))
    if "repeat" in request:
        updates["repeat"] = _repeat_update(request.get("repeat"))
    if "contextFrom" in request:
        updates["context_from"] = request.get("contextFrom") or None

    if not updates:
        raise WorkerError("No scheduled task updates were provided.", code="bad_request")
    return updates


def list_scheduled_tasks(include_disabled: bool = False, limit: Any = 100) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import list_jobs

    try:
        requested_limit = int(limit)
        safe_limit = None if requested_limit == 0 else max(1, min(requested_limit, 100))
    except (TypeError, ValueError):
        safe_limit = 100
    jobs = [_normalize_scheduled_task(job) for job in list_jobs(include_disabled=include_disabled)]
    normalized_jobs = [job for job in jobs if job is not None]
    return {"scheduledTasks": normalized_jobs if safe_limit is None else normalized_jobs[:safe_limit]}


def get_scheduled_task(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import get_job

    job = _normalize_scheduled_task(get_job(_validate_path_segment(job_id, "Scheduled task ID")))
    return {"scheduledTask": job}


def create_scheduled_task(request: dict[str, Any]) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import create_job

    try:
        job = create_job(
            prompt=_require_string(request.get("prompt"), "prompt"),
            schedule=_require_string(request.get("schedule"), "schedule"),
            name=string_or_none(request.get("name")),
            deliver=string_or_none(request.get("deliver")),
            skills=_list_of_strings(request.get("skills")),
            model=string_or_none(request.get("model")),
            provider=string_or_none(request.get("provider")),
            reasoning_effort=string_or_none(request.get("reasoningEffort")),
            base_url=string_or_none(request.get("baseUrl")),
            workdir=string_or_none(request.get("workdir")),
            repeat=_int_or_none(request.get("repeat")),
            context_from=request.get("contextFrom") or None,
        )
    except ValueError as exc:
        raise WorkerError(str(exc), code="bad_request") from exc
    return {"scheduledTask": _normalize_scheduled_task(job)}


def update_scheduled_task(request: dict[str, Any]) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import update_job

    job_id = _validate_path_segment(request.get("scheduledTaskId"), "Scheduled task ID")
    try:
        job = _normalize_scheduled_task(update_job(job_id, _build_update_dict(request)))
    except ValueError as exc:
        raise WorkerError(str(exc), code="bad_request") from exc
    return {"scheduledTask": job}


def pause_scheduled_task(job_id: Any, reason: Any = None) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import pause_job

    scheduled_task_id = _validate_path_segment(job_id, "Scheduled task ID")
    return {"scheduledTask": _normalize_scheduled_task(pause_job(scheduled_task_id, reason=string_or_none(reason)))}


def resume_scheduled_task(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import resume_job

    return {"scheduledTask": _normalize_scheduled_task(resume_job(_validate_path_segment(job_id, "Scheduled task ID")))}


def trigger_scheduled_task(job_id: Any, dispatch_token: Any = None) -> dict[str, Any]:
    _ensure_imports()
    import cron.jobs as jobs

    scheduled_task_id = _validate_path_segment(job_id, "Scheduled task ID")
    token = string_or_none(dispatch_token)
    if not token:
        job = _normalize_scheduled_task(jobs.trigger_job(scheduled_task_id))
        if job is not None:
            _kick_immediate_tick()
        return {"scheduledTask": job}
    _validate_path_segment(token, "Dispatch token")
    receipt_path = _dispatch_receipt_path(token)
    with jobs._jobs_lock():
        receipt = _read_dispatch_receipt(token)
        if receipt is not None and receipt.get("scheduledTaskId") != scheduled_task_id:
            raise WorkerError("Dispatch token belongs to another scheduled task.", code="bad_request")
        if isinstance(receipt, dict) and receipt.get("state") in {"accepted", "failed"}:
            return {"scheduledTask": None, "dispatchReceipt": receipt}
        current = jobs.get_job(scheduled_task_id)
        if current is None:
            failed = _failed_dispatch_receipt(token, scheduled_task_id, "not_found", "Scheduled task not found.", 404)
            _atomic_replace_json(receipt_path, failed)
            return {"scheduledTask": None, "dispatchReceipt": failed}
        if current.get("indy_dispatch_token") == token:
            accepted = {
                **(receipt or {}),
                "token": token,
                "scheduledTaskId": scheduled_task_id,
                "state": "accepted",
                "acceptedAt": (receipt or {}).get("acceptedAt") or _utc_now(),
                "configSnapshot": (receipt or {}).get("configSnapshot") or _runtime_snapshot(current),
            }
            _atomic_replace_json(receipt_path, accepted)
            job = _normalize_scheduled_task(current)
        else:
            prepared = {
                "token": token,
                "scheduledTaskId": scheduled_task_id,
                "state": "prepared",
                "preparedAt": (receipt or {}).get("preparedAt") or _utc_now(),
                "configSnapshot": (receipt or {}).get("configSnapshot") or _runtime_snapshot(current),
            }
            _atomic_replace_json(receipt_path, prepared)
            _before_dispatch_job_update()
            if jobs.is_terminal_job(current):
                failed = _failed_dispatch_receipt(token, scheduled_task_id, "bad_request", "Scheduled task is terminal.", 400)
                _atomic_replace_json(receipt_path, failed)
                return {"scheduledTask": _normalize_scheduled_task(current), "dispatchReceipt": failed}
            manual_run_at = _utc_now()
            # Persist manual fire and idempotency token in the same Hermes
            # jobs.json mutation while holding Hermes's cross-process lock.
            try:
                updated = jobs.update_job(scheduled_task_id, {
                    "enabled": True,
                    "state": "scheduled",
                    "paused_at": None,
                    "paused_reason": None,
                    "next_run_at": manual_run_at,
                    "manual_run_at": manual_run_at,
                    "manual_run_prompt": None,
                    "indy_dispatch_token": token,
                })
            except ValueError as exc:
                failed = _failed_dispatch_receipt(token, scheduled_task_id, "bad_request", str(exc), 400)
                _atomic_replace_json(receipt_path, failed)
                return {"scheduledTask": None, "dispatchReceipt": failed}
            _after_dispatch_job_update()
            accepted = {**prepared, "state": "accepted", "acceptedAt": _utc_now()}
            _atomic_replace_json(receipt_path, accepted)
            job = _normalize_scheduled_task(updated)
    if job is not None:
        _kick_immediate_tick()
    return {"scheduledTask": job, "dispatchReceipt": accepted}


def _kick_immediate_tick() -> None:
    """Fire a scheduler tick in the background so a just-triggered job runs
    now instead of waiting up to one full periodic-ticker interval (~60s).

    Hermes's `tick()` uses a non-blocking file lock so this is safe to run
    alongside the periodic ticker — only one will execute and the other
    returns 0.
    """
    def _run() -> None:
        try:
            tick_scheduled_tasks()
        except Exception as exc:  # noqa: BLE001 — log and swallow, this is best-effort
            print(f"[hermes-worker] immediate scheduled task tick failed: {exc}", file=sys.stderr, flush=True)

    threading.Thread(target=_run, name="hermes-scheduled-tasks-trigger", daemon=True).start()


def remove_scheduled_task(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import remove_job

    return {"ok": bool(remove_job(_validate_path_segment(job_id, "Scheduled task ID")))}


def tick_scheduled_tasks() -> int:
    _ensure_imports()
    install_scheduled_task_execution_hook()
    from cron.scheduler import tick

    executed = int(tick(verbose=False) or 0)
    _finalize_pending_manifests_once()
    return executed


def _scheduled_tasks_ticker_loop() -> None:
    while True:
        try:
            executed = tick_scheduled_tasks()
            if executed:
                print(f"[hermes-worker] scheduled task tick executed {executed} job(s)", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"[hermes-worker] scheduled task tick failed: {exc}", file=sys.stderr, flush=True)
        time.sleep(60)


def start_scheduled_task_ticker() -> None:
    global _SCHEDULED_TASKS_TICKER_STARTED
    with _SCHEDULED_TASKS_TICKER_LOCK:
        if _SCHEDULED_TASKS_TICKER_STARTED:
            return
        # Synchronous fail-closed installation: no ticker thread exists and
        # the worker cannot enter its request loop if Hermes is incompatible.
        install_scheduled_task_execution_hook()
        thread = threading.Thread(target=_scheduled_tasks_ticker_loop, name="hermes-scheduled-tasks-ticker", daemon=True)
        thread.start()
        _SCHEDULED_TASKS_TICKER_STARTED = True
