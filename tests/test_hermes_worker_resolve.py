#!/usr/bin/env python3
"""Regression tests for _resolve_model_provider (managed custom-provider routing).

Catalog model ids like "anthropic/claude-sonnet-5" must stay on a configured
custom: provider (the managed Agent37 starter proxy) instead of being re-routed
to the built-in openrouter provider, which holds no credentials on managed
instances (HTTP 401 "User not found").
"""

import io
import json
import inspect
import sys
import tempfile
import types
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_worker
import hermes_scheduled_tasks

PROXY_URL = "https://www.agent37.com/api/openclaw/starter-proxy/v1"

MANAGED_CFG = {
    "model": {"default": "default", "provider": "custom:agent37"},
    "custom_providers": [
        {
            "name": "Agent37",
            "base_url": PROXY_URL,
            "api_key": "token",
            "api_mode": "chat_completions",
            "model": "default",
        }
    ],
}


class ResolveModelProviderTest(unittest.TestCase):
    def test_explicit_custom_provider_honored_for_catalog_model(self):
        result = hermes_worker._resolve_model_provider(
            "anthropic/claude-sonnet-5", MANAGED_CFG, requested_provider="custom:agent37"
        )
        self.assertEqual(result, ("anthropic/claude-sonnet-5", "custom:agent37", PROXY_URL))

    def test_config_custom_provider_honored_without_explicit_provider(self):
        result = hermes_worker._resolve_model_provider("openai/gpt-4o-mini", MANAGED_CFG)
        self.assertEqual(result, ("openai/gpt-4o-mini", "custom:agent37", PROXY_URL))

    def test_default_model_unchanged(self):
        result = hermes_worker._resolve_model_provider(
            "default", MANAGED_CFG, requested_provider="custom:agent37"
        )
        self.assertEqual(result, ("default", "custom:agent37", PROXY_URL))

    def test_explicit_openrouter_still_routes_to_openrouter(self):
        model, provider, _ = hermes_worker._resolve_model_provider(
            "anthropic/claude-sonnet-5", MANAGED_CFG, requested_provider="openrouter"
        )
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))

    def test_at_provider_syntax_still_overrides_config_provider(self):
        model, provider, _ = hermes_worker._resolve_model_provider(
            "@openrouter:anthropic/claude-sonnet-5", MANAGED_CFG
        )
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))

    def test_openrouter_config_provider_unchanged(self):
        cfg = {"model": {"default": "anthropic/claude-sonnet-5", "provider": "openrouter"}}
        model, provider, _ = hermes_worker._resolve_model_provider("anthropic/claude-sonnet-5", cfg)
        self.assertEqual((model, provider), ("anthropic/claude-sonnet-5", "openrouter"))


NOUS_WITH_MANAGED_CATALOG_CFG = {
    "model": {"default": "deepseek/deepseek-v4-flash-0731", "provider": "nous"},
    "custom_providers": [
        {
            "name": "Agent37",
            "base_url": PROXY_URL,
            "api_key": "token",
            "api_mode": "chat_completions",
            "model": "default",
            # Hermes' model picker caches the managed catalog back into the
            # entry; ids collide with models Nous also serves.
            "models": ["default", "deepseek/deepseek-v4-flash-0731", "anthropic/claude-sonnet-5"],
        }
    ],
}


class NonCustomProviderNotHijackedTest(unittest.TestCase):
    def test_explicit_portal_provider_beats_custom_catalog_collision(self):
        result = hermes_worker._resolve_model_provider(
            "deepseek/deepseek-v4-flash-0731",
            NOUS_WITH_MANAGED_CATALOG_CFG,
            requested_provider="nous",
        )
        self.assertEqual(result, ("deepseek/deepseek-v4-flash-0731", "nous", None))

    def test_config_portal_provider_beats_custom_catalog_collision(self):
        result = hermes_worker._resolve_model_provider(None, NOUS_WITH_MANAGED_CATALOG_CFG)
        self.assertEqual(result, ("deepseek/deepseek-v4-flash-0731", "nous", None))

    def test_explicit_custom_provider_still_uses_catalog(self):
        result = hermes_worker._resolve_model_provider(
            "deepseek/deepseek-v4-flash-0731",
            NOUS_WITH_MANAGED_CATALOG_CFG,
            requested_provider="custom:agent37",
        )
        self.assertEqual(
            result, ("deepseek/deepseek-v4-flash-0731", "custom:agent37", PROXY_URL)
        )

    def test_no_provider_still_uses_catalog(self):
        cfg = {
            "model": {"default": "deepseek/deepseek-v4-flash-0731"},
            "custom_providers": NOUS_WITH_MANAGED_CATALOG_CFG["custom_providers"],
        }
        result = hermes_worker._resolve_model_provider(None, cfg)
        self.assertEqual(
            result, ("deepseek/deepseek-v4-flash-0731", "custom:agent37", PROXY_URL)
        )


def _sensitive_keys(value, path=""):
    if not isinstance(value, (dict, list)):
        return []
    if isinstance(value, list):
        return [
            item
            for index, child in enumerate(value)
            for item in _sensitive_keys(child, f"{path}[{index}]")
        ]
    found = []
    for key, child in value.items():
        child_path = f"{path}.{key}" if path else key
        if any(fragment in key.lower() for fragment in (
            "token", "key", "credential", "authorization", "cookie"
        )):
            found.append(child_path)
        found.extend(_sensitive_keys(child, child_path))
    return found


class RuntimeStatusTest(unittest.TestCase):
    def test_projects_the_operator_label_instead_of_the_opaque_credential_id(self):
        credential = types.SimpleNamespace(id="e033d5", label="etienne-openai")
        pool = types.SimpleNamespace(current=lambda: credential)

        self.assertEqual(
            hermes_worker._runtime_profile_id({"credential_pool": pool}),
            "etienne-openai",
        )

    def test_projects_parser_does_not_invent_efforts_when_catalog_omits_metadata(self):
        groups = {
            "Codex OAuth": [{
                "id": "gpt-account-model",
                "label": "Account model",
                "provider": "openai-codex",
                "source": "catalog",
            }],
        }

        self.assertEqual(hermes_worker._runtime_catalog_models(groups), [{
            "id": "gpt-account-model",
            "label": "Account model",
            "reasoningEfforts": [],
        }])

    def test_run_loop_never_prints_an_untrusted_exception_or_traceback(self):
        stderr = io.StringIO()
        with patch.object(sys, "stdin", io.StringIO('{"id":"request"}\n')), \
             patch.object(sys, "stderr", stderr), \
             patch.object(
                 hermes_worker,
                 "_handle_request",
                 side_effect=RuntimeError("provider rejected opaque-oauth-value-123456789"),
             ):
            hermes_worker._run_loop()

        self.assertEqual(stderr.getvalue(), "[hermes-worker] request handling failed\n")

    def test_mcp_registration_never_prints_an_untrusted_exception(self):
        stderr = io.StringIO()
        tools_module = types.ModuleType("tools")
        mcp_module = types.ModuleType("tools.mcp_tool")
        mcp_module.register_mcp_servers = lambda _servers: (_ for _ in ()).throw(
            RuntimeError("provider rejected opaque-mcp-secret-987654321")
        )
        registered = hermes_worker._mcp_servers_registered
        hermes_worker._mcp_servers_registered = False
        try:
            with patch.object(sys, "stderr", stderr), patch.dict(
                sys.modules,
                {"tools": tools_module, "tools.mcp_tool": mcp_module},
            ):
                hermes_worker._register_mcp_servers({"mcp_servers": {"test": {}}})
        finally:
            hermes_worker._mcp_servers_registered = registered

        self.assertEqual(
            stderr.getvalue(),
            "[hermes-worker] mcp server registration failed; retry scheduled\n",
        )

    def test_classifies_all_public_oauth_states_from_structured_error_metadata(self):
        cases = [
            (type("Missing", (RuntimeError,), {"code": "codex_auth_missing"})("secret"), "missing"),
            (type("Expired", (RuntimeError,), {"code": "token_expired"})("secret"), "expired"),
            (type("Revoked", (RuntimeError,), {"code": "oauth_token_revoked"})("secret"), "expired"),
            (type("InvalidModel", (RuntimeError,), {"code": "invalid_model"})("secret"), "error"),
            (type("Unknown", (RuntimeError,), {"code": "unexpected"})("secret"), "error"),
        ]
        for error, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(hermes_worker._runtime_auth_state(error), expected)

    def test_projects_connected_codex_runtime_without_secrets_or_generation(self):
        fake_runtime_provider = types.ModuleType("hermes_cli.runtime_provider")
        fake_runtime_provider.resolve_runtime_provider = lambda **_kwargs: {
            "provider": "openai-codex",
            "api_key": "oauth-super-secret",
            "authorization": "Bearer oauth-super-secret",
            "credential_pool": None,
            "profile_id": "etienne-openai",
        }
        cfg = {"model": {"default": "gpt-5.6-sol", "provider": "openai-codex"}}
        defaults = {
            "model": "gpt-5.6-sol",
            "provider": "openai-codex",
            "baseUrl": None,
        }
        groups = {
            "Codex OAuth": [{
                    "id": "gpt-5.6-sol",
                    "label": "gpt-5.6-sol",
                    "provider": "openai-codex",
                    "source": "catalog",
                    "reasoningEfforts": ["low", "medium", "high", "xhigh"],
                    "apiKey": "model-secret",
                }, {
                    "id": "configured-but-not-in-account-catalog",
                    "label": "configured-but-not-in-account-catalog",
                    "provider": "openai-codex",
                    "source": "current",
                }, {
                    "id": "wrong-provider",
                    "label": "wrong-provider",
                    "provider": "openai",
                    "source": "catalog",
                }, {
                    "id": "missing-provider",
                    "label": "missing-provider",
                    "source": "catalog",
                }],
        }

        with patch.dict(sys.modules, {"hermes_cli.runtime_provider": fake_runtime_provider}), \
             patch.object(hermes_worker, "_load_config", return_value=cfg), \
             patch.object(hermes_worker, "_defaults_from_config", return_value=defaults), \
             patch.object(hermes_worker, "_list_authenticated_model_groups", return_value=groups) as inventory, \
             patch.object(hermes_worker, "_list_models", side_effect=AssertionError("cached catalog forbidden")), \
             patch.object(hermes_worker, "_run_one_shot_agent") as generate:
            result = hermes_worker._runtime_status()

        checked_at = result.pop("checkedAt")
        self.assertRegex(checked_at, r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(result, {
            "provider": "openai-codex",
            "profileId": "etienne-openai",
            "authState": "connected",
            "models": [{
                "id": "gpt-5.6-sol",
                "label": "gpt-5.6-sol",
                "reasoningEfforts": ["low", "medium", "high", "xhigh"],
            }],
        })
        self.assertEqual(_sensitive_keys(result), [])
        self.assertNotIn("oauth-super-secret", repr(result))
        inventory.assert_called_once_with(cfg, defaults, fresh=True)
        generate.assert_not_called()

    def test_fails_closed_when_fresh_authenticated_inventory_is_unavailable(self):
        fake_runtime_provider = types.ModuleType("hermes_cli.runtime_provider")
        fake_runtime_provider.resolve_runtime_provider = lambda **_kwargs: {
            "provider": "openai-codex",
            "api_key": "oauth-super-secret",
            "profile_id": "etienne-openai",
        }
        cfg = {"model": {"default": "gpt-live", "provider": "openai-codex"}}
        defaults = {"model": "gpt-live", "provider": "openai-codex", "baseUrl": None}

        with patch.dict(sys.modules, {"hermes_cli.runtime_provider": fake_runtime_provider}), \
             patch.object(hermes_worker, "_load_config", return_value=cfg), \
             patch.object(hermes_worker, "_defaults_from_config", return_value=defaults), \
             patch.object(hermes_worker, "_list_authenticated_model_groups", return_value=None) as inventory, \
             patch.object(hermes_worker, "_list_models", side_effect=AssertionError("cached catalog forbidden")):
            result = hermes_worker._runtime_status()

        self.assertEqual(result["authState"], "error")
        self.assertIsNone(result["profileId"])
        self.assertEqual(result["models"], [])
        inventory.assert_called_once_with(cfg, defaults, fresh=True)

    def test_keeps_connected_with_null_profile_when_credentials_and_inventory_are_resolved(self):
        fake_runtime_provider = types.ModuleType("hermes_cli.runtime_provider")
        fake_runtime_provider.resolve_runtime_provider = lambda **_kwargs: {
            "provider": "openai-codex",
            "api_key": "oauth-super-secret",
        }
        cfg = {"model": {"default": "gpt-live", "provider": "openai-codex"}}
        defaults = {"model": "gpt-live", "provider": "openai-codex", "baseUrl": None}
        groups = {"Codex OAuth": [{
            "id": "gpt-live",
            "label": "gpt-live",
            "provider": "openai-codex",
            "source": "catalog",
        }]}

        with patch.dict(sys.modules, {"hermes_cli.runtime_provider": fake_runtime_provider}), \
             patch.object(hermes_worker, "_load_config", return_value=cfg), \
             patch.object(hermes_worker, "_defaults_from_config", return_value=defaults), \
             patch.object(hermes_worker, "_list_authenticated_model_groups", return_value=groups), \
             patch.object(hermes_worker, "_list_models", side_effect=AssertionError("cached catalog forbidden")):
            result = hermes_worker._runtime_status()

        self.assertEqual(result["authState"], "connected")
        self.assertIsNone(result["profileId"])
        self.assertEqual([model["id"] for model in result["models"]], ["gpt-live"])

    def test_classifies_missing_auth_without_serializing_the_raw_secret_error(self):
        class FakeAuthError(RuntimeError):
            code = "codex_auth_missing"
            relogin_required = True

        fake_runtime_provider = types.ModuleType("hermes_cli.runtime_provider")

        def fail(**_kwargs):
            raise FakeAuthError("token sk-secret-value is missing")

        fake_runtime_provider.resolve_runtime_provider = fail
        with patch.dict(sys.modules, {"hermes_cli.runtime_provider": fake_runtime_provider}):
            result = hermes_worker._runtime_status()

        checked_at = result.pop("checkedAt")
        self.assertRegex(checked_at, r"^\d{4}-\d{2}-\d{2}T")
        self.assertEqual(result, {
            "provider": "openai-codex",
            "profileId": None,
            "authState": "missing",
            "models": [],
        })
        self.assertEqual(_sensitive_keys(result), [])
        self.assertNotIn("sk-secret-value", repr(result))


class ScheduledTaskRuntimeFieldsTest(unittest.TestCase):
    def test_internal_zero_limit_lists_every_hermes_schedule_for_projection(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        jobs_module.list_jobs = lambda include_disabled=False: [
            {"id": f"cron-{index}", "name": f"Cron {index}"}
            for index in range(125)
        ]

        with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module}):
            result = hermes_scheduled_tasks.list_scheduled_tasks(True, 0)

        self.assertEqual(len(result["scheduledTasks"]), 125)

    def test_normalizes_explicit_reasoning_effort_from_hermes_job(self):
        result = hermes_scheduled_tasks._normalize_scheduled_task({
            "id": "cron-1",
            "name": "Daily brief",
            "provider": "openai-codex",
            "model": "gpt-5.6-sol",
            "reasoning_effort": "high",
            "workdir": "/srv/indy/client",
        })

        self.assertEqual(result["provider"], "openai-codex")
        self.assertEqual(result["model"], "gpt-5.6-sol")
        self.assertEqual(result["reasoningEffort"], "high")
        self.assertEqual(result["workdir"], "/srv/indy/client")

    def test_create_forwards_explicit_runtime_fields_without_fallback(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        captured = {}

        def create_job(**kwargs):
            captured.update(kwargs)
            return {"id": "cron-created", **kwargs}

        jobs_module.create_job = create_job
        with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module}):
            result = hermes_scheduled_tasks.create_scheduled_task({
                "prompt": "Prepare the brief",
                "schedule": "0 8 * * *",
                "provider": "openai-codex",
                "model": "gpt-5.6-sol",
                "reasoningEffort": "high",
                "workdir": "/srv/indy/client",
            })

        self.assertEqual(captured["provider"], "openai-codex")
        self.assertEqual(captured["model"], "gpt-5.6-sol")
        self.assertEqual(captured["reasoning_effort"], "high")
        self.assertEqual(captured["workdir"], "/srv/indy/client")
        self.assertEqual(result["scheduledTask"]["reasoningEffort"], "high")

    def test_update_forwards_explicit_reasoning_effort(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        captured = {}

        def update_job(job_id, updates):
            captured["job_id"] = job_id
            captured["updates"] = updates
            return {"id": job_id, **updates}

        jobs_module.update_job = update_job
        with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module}):
            result = hermes_scheduled_tasks.update_scheduled_task({
                "scheduledTaskId": "cron-1",
                "provider": "openai-codex",
                "model": "gpt-5.6-sol",
                "reasoningEffort": "xhigh",
                "workdir": "/srv/indy/client",
            })

        self.assertEqual(captured["job_id"], "cron-1")
        self.assertEqual(captured["updates"]["reasoning_effort"], "xhigh")
        self.assertEqual(result["scheduledTask"]["reasoningEffort"], "xhigh")


class ScheduledTaskExecutionAdmissionTest(unittest.TestCase):
    def test_ticker_installs_hook_synchronously_and_never_starts_on_install_failure(self):
        original_started = hermes_scheduled_tasks._SCHEDULED_TASKS_TICKER_STARTED
        hermes_scheduled_tasks._SCHEDULED_TASKS_TICKER_STARTED = False
        try:
            with patch.object(
                hermes_scheduled_tasks,
                "install_scheduled_task_execution_hook",
                side_effect=RuntimeError("unsupported Hermes scheduler"),
            ), patch.object(hermes_scheduled_tasks.threading, "Thread") as thread:
                with self.assertRaisesRegex(RuntimeError, "unsupported Hermes scheduler"):
                    hermes_scheduled_tasks.start_scheduled_task_ticker()
                thread.assert_not_called()
                self.assertFalse(hermes_scheduled_tasks._SCHEDULED_TASKS_TICKER_STARTED)
        finally:
            hermes_scheduled_tasks._SCHEDULED_TASKS_TICKER_STARTED = original_started

    def test_installed_hermes_exposes_the_guarded_execution_hook_contract(self):
        hermes_scheduled_tasks._ensure_imports()
        import cron.jobs as jobs
        import cron.scheduler as scheduler

        self.assertEqual(hermes_scheduled_tasks._installed_hermes_version(), "0.15.1")
        self.assertTrue(hermes_scheduled_tasks._validate_execution_hook_contract(scheduler, jobs))

    def test_execution_hook_contract_pins_imported_source_bytes_not_distribution_metadata(self):
        hermes_scheduled_tasks._ensure_imports()
        import cron.jobs as jobs
        import cron.scheduler as scheduler

        with patch.object(hermes_scheduled_tasks, "_installed_hermes_version", return_value="0.16.0"):
            self.assertTrue(hermes_scheduled_tasks._validate_execution_hook_contract(scheduler, jobs))
        source = Path(inspect.getsourcefile(scheduler))
        with tempfile.TemporaryDirectory() as directory:
            drift_dir = Path(directory) / "cron"
            drift_dir.mkdir()
            drift = drift_dir / "scheduler.py"
            drift.write_bytes(source.read_bytes() + b"\n# one-byte/dead-code drift\n")
            with patch.object(hermes_scheduled_tasks.inspect, "getsourcefile", return_value=str(drift)):
                self.assertFalse(hermes_scheduled_tasks._validate_execution_hook_contract(scheduler, jobs))
        with patch.object(hermes_scheduled_tasks.inspect, "getsourcefile", return_value="Z:/missing/cron/scheduler.py"):
            self.assertFalse(hermes_scheduled_tasks._validate_execution_hook_contract(scheduler, jobs))
        different = types.ModuleType("cron.not_the_scheduler")
        different.__file__ = str(source)
        different.tick = scheduler.tick
        different.run_job = scheduler.run_job
        different.run_one_job = scheduler.run_one_job
        different._run_one_job_body = scheduler._run_one_job_body
        self.assertFalse(hermes_scheduled_tasks._validate_execution_hook_contract(different, jobs))

    def test_direct_run_without_exposed_durable_execution_id_is_denied(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        scheduler_module = types.ModuleType("cron.scheduler")
        direct_effects = []
        scheduler_module.run_job = lambda job, *args, **kwargs: (direct_effects.append(job["id"]) or (True, "ok", "", None))
        scheduler_module.run_one_job = lambda job, **kwargs: scheduler_module.run_job(job)
        scheduler_module.create_execution = lambda job_id, source: {"id": "ledger-direct-1", "job_id": job_id}
        scheduler_module.get_fallback_chain = lambda config: []
        jobs_module._claim_job_for_fire_locked = lambda job_id, **kwargs: False
        jobs_module._save_jobs_unlocked = lambda jobs, **kwargs: None

        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            job = {"id": "direct", "name": "Direct", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "workdir": str(workdir)}
            with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                 patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                 patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                 patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                 patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module, "cron.scheduler": scheduler_module}), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                with self.assertRaisesRegex(RuntimeError, "durable execution_id"):
                    scheduler_module.run_one_job(job)
                manifests = list((Path(hermes_home) / "cron" / "indy-manifests").rglob("*.json"))

        self.assertEqual(direct_effects, [])
        self.assertEqual(manifests, [])

    def test_tick_installs_per_job_admission_and_refuses_invalid_due_job(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        scheduler_module = types.ModuleType("cron.scheduler")
        executions_module = types.ModuleType("cron.executions")
        executions_module._TERMINAL_STATES = ("completed", "failed", "unknown")
        executed = []
        def original_run_job(job, *args, **kwargs):
            executed.append(job["id"])
            return True, "secret output", "", None

        scheduler_module.run_job = original_run_job

        job = {}

        def tick(verbose=False):
            scheduler_module.run_job(job, execution_id="automatic-run-1")
            return 1

        scheduler_module.tick = tick
        executions_module.list_executions = lambda job_id=None, limit=50: [{
            "id": "automatic-run-1", "job_id": "cron-invalid", "status": "failed",
            "started_at": "2026-09-02T08:00:00Z", "finished_at": "2026-09-02T08:00:01Z",
            "error": "SCHEDULED_PROVIDER_UNSUPPORTED",
        }]

        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            job.update({
                "id": "cron-invalid",
                "name": "Invalid automatic occurrence",
                "provider": None,
                "model": None,
                "reasoning_effort": "high",
                "workdir": str(workdir),
            })
            with \
             patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
             patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={
                 "provider": "openai-codex",
                 "profileId": "etienne-openai",
                 "authState": "connected",
                 "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}],
             }), \
             patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
             patch.dict(sys.modules, {
                 "cron": cron_module,
                 "cron.jobs": jobs_module,
                 "cron.scheduler": scheduler_module,
                 "cron.executions": executions_module,
             }), \
             patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                executed_count = hermes_scheduled_tasks.tick_scheduled_tasks()

                manifests = [path for path in (Path(hermes_home) / "cron" / "indy-manifests").rglob("*.json") if not path.name.endswith(".output.json")]
                manifest = manifests[0].read_text(encoding="utf-8")

        self.assertEqual(executed_count, 1)
        self.assertEqual(executed, [])
        self.assertEqual(len(manifests), 1)
        self.assertIn('"status":"failed"', manifest)
        self.assertIn("SCHEDULED_PROVIDER_REQUIRED", manifest)
        self.assertIn('"provider":"<missing>"', manifest)
        self.assertIn('"model":"<missing>"', manifest)

    def test_admission_is_fresh_for_every_job_in_one_global_tick(self):
        cron_module = types.ModuleType("cron")
        scheduler_module = types.ModuleType("cron.scheduler")
        executed = []
        jobs = []
        scheduler_module.run_job = lambda job, *args, **kwargs: (executed.append(job["id"]) or (True, "ok", "", None))

        def tick(verbose=False):
            for index, candidate in enumerate(jobs):
                scheduler_module.run_job(candidate, execution_id=f"run-{index}")
            return 2

        scheduler_module.tick = tick
        runtimes = [
            {"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]},
            {"provider": "openai-codex", "profileId": "etienne-openai", "authState": "expired", "models": []},
        ]

        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            jobs.extend([
                {"id": "valid", "name": "valid", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "workdir": str(workdir)},
                {"id": "expired", "name": "expired", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "workdir": str(workdir)},
            ])
            with \
             patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
             patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", side_effect=runtimes) as runtime_status, \
             patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.scheduler": scheduler_module}), \
             patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks.tick_scheduled_tasks()

        self.assertEqual(runtime_status.call_count, 2)
        self.assertEqual(executed, ["valid"])

    def test_admitted_cron_disables_fallback_only_inside_its_execution_context(self):
        cron_module = types.ModuleType("cron")
        scheduler_module = types.ModuleType("cron.scheduler")
        executions_module = types.ModuleType("cron.executions")
        executions_module._TERMINAL_STATES = ("completed", "failed", "unknown")
        observed = []
        scheduler_module.get_fallback_chain = lambda config: [{"provider": "other", "model": "fallback"}]

        def original_run_job(job, *args, **kwargs):
            observed.append(scheduler_module.get_fallback_chain({}))
            return True, "ok", "", None

        scheduler_module.run_job = original_run_job
        scheduler_module.tick = lambda verbose=False: (scheduler_module.run_job(job) and 1)
        executions_module.list_executions = lambda job_id=None, limit=50: [{
            "id": "hermes-execution-1", "job_id": "no-fallback", "status": "completed",
            "started_at": "2026-09-02T08:00:00Z", "finished_at": "2026-09-02T08:00:01Z", "error": None,
        }]
        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            job = {"id": "no-fallback", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "workdir": str(workdir), "execution_id": "hermes-execution-1"}
            with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                 patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                 patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                 patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                 patch.dict(sys.modules, {"cron": cron_module, "cron.scheduler": scheduler_module, "cron.executions": executions_module}), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks.tick_scheduled_tasks()
                outside = scheduler_module.get_fallback_chain({})
                manifest = next(path for path in (Path(hermes_home) / "cron" / "indy-manifests").rglob("*.json") if not path.name.endswith(".output.json"))

        self.assertEqual(observed, [[]])
        self.assertEqual(outside, [{"provider": "other", "model": "fallback"}])
        self.assertEqual(manifest.stem, "hermes-execution-1")

    def test_terminal_manifest_waits_for_durable_hermes_execution_evidence(self):
        cron_module = types.ModuleType("cron")
        scheduler_module = types.ModuleType("cron.scheduler")
        executions_module = types.ModuleType("cron.executions")
        executions_module._TERMINAL_STATES = ("completed", "failed", "unknown")
        record = {"id": "ledger-run", "job_id": "ledger-job", "status": "running", "started_at": "2026-09-02T08:00:00Z", "finished_at": None, "error": None}
        executions_module.list_executions = lambda job_id=None, limit=50: [dict(record)]
        scheduler_module.run_job = lambda job, *args, **kwargs: (
            True,
            'Bearer durable-secret {"access_token":"json-token","credential":"json-credential"}',
            "",
            None,
        )
        scheduler_module.tick = lambda verbose=False: 0

        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            job = {"id": "ledger-job", "name": "Ledger", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "workdir": str(workdir), "execution_id": "ledger-run"}
            with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                 patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                 patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                 patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                 patch.dict(sys.modules, {"cron": cron_module, "cron.scheduler": scheduler_module, "cron.executions": executions_module}), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                scheduler_module.run_job(job)
                self.assertEqual(hermes_scheduled_tasks._finalize_pending_manifests_once(), 0)
                self.assertFalse((Path(hermes_home) / "cron" / "indy-manifests" / "ledger-job" / "ledger-run.json").exists())
                record.update({"status": "completed", "finished_at": "2026-09-02T08:00:01Z"})
                self.assertEqual(hermes_scheduled_tasks._finalize_pending_manifests_once(), 1)
                terminal = (Path(hermes_home) / "cron" / "indy-manifests" / "ledger-job" / "ledger-run.json").read_text(encoding="utf-8")

        self.assertIn('"startedAt":"2026-09-02T08:00:00Z"', terminal)
        self.assertIn('"finishedAt":"2026-09-02T08:00:01Z"', terminal)
        self.assertNotIn("durable-secret", terminal)
        self.assertNotIn("json-token", terminal)
        self.assertNotIn("json-credential", terminal)

    def test_interrupted_installed_execution_recovers_to_unknown_and_finalizes_pending(self):
        hermes_scheduled_tasks._ensure_imports()
        import cron.executions as executions

        with tempfile.TemporaryDirectory() as hermes_home:
            execution_db = Path(hermes_home) / "executions.db"
            with patch.object(executions, "EXECUTIONS_FILE", execution_db), \
                 patch.object(executions, "_owner_is_live", return_value=False), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                claimed = executions.create_execution("cron-interrupted", source="builtin")
                running = executions.create_execution("cron-interrupted", source="builtin")
                executions.mark_execution_running(running["id"])
                for occurrence in (claimed, running):
                    hermes_scheduled_tasks._write_pending_occurrence(
                        "cron-interrupted",
                        occurrence["id"],
                        {"scheduledTaskName": "Interrupted", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoningEffort": "high", "workdir": "C:/work"},
                        None,
                    )
                with patch.object(executions, "_PROCESS_ID", "simulated-restarted-owner"):
                    self.assertEqual(executions.recover_interrupted_executions(), 2)
                    recovered = executions.list_executions(job_id="cron-interrupted", limit=10)
                    self.assertEqual({record["status"] for record in recovered}, {"unknown"})
                    self.assertEqual(hermes_scheduled_tasks._finalize_pending_manifests_once(), 2)
                terminals = {
                    occurrence["id"]: json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-interrupted" / f"{occurrence['id']}.json").read_text(encoding="utf-8"))
                    for occurrence in (claimed, running)
                }

        self.assertEqual({terminal["status"] for terminal in terminals.values()}, {"failed"})
        self.assertEqual({terminal["hermesStatus"] for terminal in terminals.values()}, {"unknown"})
        self.assertEqual(terminals[claimed["id"]]["provenance"], {
            "source": "indy-hermes-run-job-hook",
            "evidence": "cron.executions",
            "originalHermesStatus": "unknown",
            "startedAtEvidence": "claimed_at",
        })
        self.assertEqual(terminals[running["id"]]["provenance"], {
            "source": "indy-hermes-run-job-hook",
            "evidence": "cron.executions",
            "originalHermesStatus": "unknown",
            "startedAtEvidence": "started_at",
        })

    def test_manual_token_is_associated_under_lock_and_never_reaches_later_automatic_run(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        scheduler_module = types.ModuleType("cron.scheduler")
        stored = {"id": "cron-token", "name": "Cron", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "indy_dispatch_token": "manual-token"}

        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: dict(stored) if job_id == "cron-token" else None
        jobs_module.update_job = lambda job_id, updates: (stored.update(updates), dict(stored))[1]
        scheduler_module.run_job = lambda job, *args, **kwargs: (True, "ok", "", None)
        scheduler_module.get_fallback_chain = lambda config: []

        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            stored["workdir"] = str(workdir)
            with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                 patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                 patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                 patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                 patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module, "cron.scheduler": scheduler_module}), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks._atomic_replace_json(
                    hermes_scheduled_tasks._dispatch_receipt_path("manual-token"),
                    {"token": "manual-token", "scheduledTaskId": "cron-token", "state": "accepted", "acceptedAt": "2026-09-02T08:00:00Z"},
                )
                hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                scheduler_module.run_job({**stored, "execution_id": "manual-occurrence"})
                scheduler_module.run_job({**stored, "execution_id": "automatic-occurrence"})
                manual = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-token" / "manual-occurrence.pending.json").read_text(encoding="utf-8"))
                automatic = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-token" / "automatic-occurrence.pending.json").read_text(encoding="utf-8"))

        self.assertIsNone(stored.get("indy_dispatch_token"))
        self.assertEqual(manual["dispatchToken"], "manual-token")
        self.assertIsNone(automatic["dispatchToken"])

    def test_accepted_receipt_replays_before_deleted_job_lookup(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: (_ for _ in ()).throw(AssertionError("job lookup must not run"))
        with tempfile.TemporaryDirectory() as hermes_home, \
             patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module}), \
             patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
            receipt = {"token": "accepted-token", "scheduledTaskId": "deleted-job", "state": "accepted", "acceptedAt": "2026-09-02T08:00:00Z"}
            hermes_scheduled_tasks._atomic_replace_json(hermes_scheduled_tasks._dispatch_receipt_path("accepted-token"), receipt)
            replay = hermes_scheduled_tasks.trigger_scheduled_task("deleted-job", "accepted-token")

        self.assertEqual(replay["dispatchReceipt"], receipt)
        self.assertIsNone(replay["scheduledTask"])

    def test_failed_receipt_replays_before_deleted_job_lookup(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: (_ for _ in ()).throw(AssertionError("job lookup must not run"))
        with tempfile.TemporaryDirectory() as hermes_home, \
             patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module}), \
             patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
            receipt = {
                "token": "failed-token", "scheduledTaskId": "deleted-job", "state": "failed",
                "failedAt": "2026-09-02T08:00:00Z", "code": "bad_request", "status": 400,
                "message": "stored refusal",
            }
            hermes_scheduled_tasks._atomic_replace_json(
                hermes_scheduled_tasks._dispatch_receipt_path("failed-token"), receipt
            )
            replay = hermes_scheduled_tasks.trigger_scheduled_task("deleted-job", "failed-token")

        self.assertEqual(replay["dispatchReceipt"], receipt)
        self.assertIsNone(replay["scheduledTask"])

    def test_redacts_basic_and_generic_authorization_schemes(self):
        scrubbed = hermes_scheduled_tasks._redact_text(
            'Authorization: Basic dXNlcjpwYXNz\r\n'
            'Authorization: Digest username="Mufasa", realm="testrealm", nonce="digest-secret", uri="/dir"\r\n'
            '{"authorization":"Digest json-secret","password":"nested-password","passwd":"nested-passwd","pwd":"nested-pwd"}'
        )
        self.assertNotIn("dXNlcjpwYXNz", scrubbed)
        self.assertNotIn("json-secret", scrubbed)
        self.assertNotIn("Mufasa", scrubbed)
        self.assertNotIn("digest-secret", scrubbed)
        self.assertNotIn("nested-password", scrubbed)
        self.assertNotIn("nested-passwd", scrubbed)
        self.assertNotIn("nested-pwd", scrubbed)
        self.assertGreaterEqual(scrubbed.count("[REDACTED]"), 2)

    def test_prepared_receipt_and_durable_job_token_bind_to_the_real_ticker_occurrence(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        scheduler_module = types.ModuleType("cron.scheduler")
        stored = {"id": "cron-token", "name": "Cron", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "indy_dispatch_token": "manual-token"}
        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: dict(stored) if job_id == "cron-token" else None
        jobs_module.update_job = lambda job_id, updates: (stored.update(updates), dict(stored))[1]
        scheduler_module.run_job = lambda job, *args, **kwargs: (True, "ok", "", None)
        scheduler_module.get_fallback_chain = lambda config: []

        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            stored["workdir"] = str(workdir)
            snapshot = {"scheduledTaskName": "Cron", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoningEffort": "high", "workdir": str(workdir)}
            with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                 patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                 patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                 patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                 patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module, "cron.scheduler": scheduler_module}), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks._atomic_replace_json(
                    hermes_scheduled_tasks._dispatch_receipt_path("manual-token"),
                    {"token": "manual-token", "scheduledTaskId": "cron-token", "state": "prepared", "preparedAt": "2026-09-02T08:00:00Z", "configSnapshot": snapshot},
                )
                hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                scheduler_module.run_job({**stored, "execution_id": "manual-real-id"})
                replay = hermes_scheduled_tasks.trigger_scheduled_task("cron-token", "manual-token")
                scheduler_module.run_job({**stored, "execution_id": "automatic-id"})
                receipt = hermes_scheduled_tasks._read_dispatch_receipt("manual-token")
                manual = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-token" / "manual-real-id.pending.json").read_text(encoding="utf-8"))
                automatic = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-token" / "automatic-id.pending.json").read_text(encoding="utf-8"))

        self.assertEqual(receipt["state"], "accepted")
        self.assertEqual(replay["dispatchReceipt"], receipt)
        self.assertEqual(receipt["occurrenceId"], "manual-real-id")
        self.assertIsNone(stored.get("indy_dispatch_token"))
        self.assertEqual(manual["dispatchToken"], "manual-token")
        self.assertIsNone(automatic["dispatchToken"])

    def test_bound_receipt_reconstructs_missing_pending_evidence_and_finalizes(self):
        cron_module = types.ModuleType("cron")
        executions_module = types.ModuleType("cron.executions")
        executions_module._TERMINAL_STATES = ("completed", "failed", "unknown")
        executions_module.list_executions = lambda job_id=None, limit=50: [{
            "id": "lost-pending", "job_id": "cron-recover", "status": "failed",
            "started_at": "2026-09-02T08:00:00Z", "finished_at": "2026-09-02T08:00:01Z", "error": "password=ledger-secret",
        }]
        with tempfile.TemporaryDirectory() as hermes_home, \
             patch.dict(sys.modules, {"cron": cron_module, "cron.executions": executions_module}), \
             patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
            snapshot = {"scheduledTaskName": "Cron", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoningEffort": "high", "workdir": "C:/work"}
            hermes_scheduled_tasks._atomic_replace_json(
                hermes_scheduled_tasks._dispatch_receipt_path("recover-token"),
                {"token": "recover-token", "scheduledTaskId": "cron-recover", "state": "accepted", "occurrenceId": "lost-pending", "configSnapshot": snapshot},
            )
            self.assertEqual(hermes_scheduled_tasks._finalize_pending_manifests_once(), 1)
            terminal = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-recover" / "lost-pending.json").read_text(encoding="utf-8"))

        self.assertEqual(terminal["dispatchToken"], "recover-token")
        self.assertNotIn("ledger-secret", json.dumps(terminal))

    def test_prepared_receipt_without_the_exact_durable_job_token_never_false_accepts(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        scheduler_module = types.ModuleType("cron.scheduler")
        stored = {"id": "cron-safe", "name": "Cron", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high"}
        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: dict(stored)
        jobs_module.update_job = lambda job_id, updates: (stored.update(updates), dict(stored))[1]
        scheduler_module.run_job = lambda job, *args, **kwargs: (True, "ok", "", None)
        scheduler_module.get_fallback_chain = lambda config: []
        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            stored["workdir"] = str(workdir)
            with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                 patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                 patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                 patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                 patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module, "cron.scheduler": scheduler_module}), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks._atomic_replace_json(
                    hermes_scheduled_tasks._dispatch_receipt_path("orphan-token"),
                    {"token": "orphan-token", "scheduledTaskId": "cron-safe", "state": "prepared", "configSnapshot": hermes_scheduled_tasks._runtime_snapshot(stored)},
                )
                hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                scheduler_module.run_job({**stored, "indy_dispatch_token": "orphan-token", "execution_id": "automatic-safe"})
                receipt = hermes_scheduled_tasks._read_dispatch_receipt("orphan-token")
                pending = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-safe" / "automatic-safe.pending.json").read_text(encoding="utf-8"))

        self.assertEqual(receipt["state"], "prepared")
        self.assertNotIn("occurrenceId", receipt)
        self.assertIsNone(pending["dispatchToken"])

    def test_structured_output_redaction_scrubs_nested_password_aliases(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "output.json"
            hermes_scheduled_tasks._write_occurrence_output(output, {
                "nested": {"password": "hunter2", "passwd": "legacy", "pwd": "short"},
                "message": '{"authorization":"Digest username=\\"Mufasa\\", nonce=\\"digest-secret\\", response=\\"digest-response\\"","safe":"ok"}',
            })
            serialized = output.read_text(encoding="utf-8")
        for secret in ("hunter2", "legacy", "short", "Mufasa", "digest-secret", "digest-response"):
            self.assertNotIn(secret, serialized)

    def test_two_manual_tokens_never_overwrite_and_each_bind_one_real_occurrence(self):
        for crash_after_first_marker in (False, True):
            with self.subTest(crash_after_first_marker=crash_after_first_marker), tempfile.TemporaryDirectory() as hermes_home:
                cron_module = types.ModuleType("cron")
                jobs_module = types.ModuleType("cron.jobs")
                scheduler_module = types.ModuleType("cron.scheduler")
                stored = {"id": "cron-multi", "name": "Cron", "state": "scheduled", "enabled": True, "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high"}
                jobs_module._jobs_lock = nullcontext
                jobs_module.get_job = lambda job_id: dict(stored) if job_id == "cron-multi" else None
                jobs_module.resolve_job_ref = jobs_module.get_job
                jobs_module.is_terminal_job = lambda job: False
                jobs_module.update_job = lambda job_id, updates: (stored.update(updates), dict(stored))[1]
                scheduler_module.run_job = lambda job, *args, **kwargs: (True, "ok", "", None)
                scheduler_module.get_fallback_chain = lambda config: []
                allowed = Path(hermes_home) / "allowed"
                workdir = allowed / "client"
                workdir.mkdir(parents=True)
                stored["workdir"] = str(workdir)
                with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                     patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                     patch.object(hermes_scheduled_tasks, "_kick_immediate_tick"), \
                     patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                     patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                     patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module, "cron.scheduler": scheduler_module}), \
                     patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                    if crash_after_first_marker:
                        with patch.object(hermes_scheduled_tasks, "_after_dispatch_job_update", side_effect=RuntimeError("crash-after-a-marker")):
                            with self.assertRaisesRegex(RuntimeError, "crash-after-a-marker"):
                                hermes_scheduled_tasks.trigger_scheduled_task("cron-multi", "token-a")
                    else:
                        hermes_scheduled_tasks.trigger_scheduled_task("cron-multi", "token-a")
                    with self.assertRaises(hermes_scheduled_tasks.WorkerError) as busy:
                        hermes_scheduled_tasks.trigger_scheduled_task("cron-multi", "token-b")
                    self.assertEqual(busy.exception.code, "scheduled_task_busy")
                    self.assertEqual(stored["indy_dispatch_token"], "token-a")
                    first_receipt_before_tick = hermes_scheduled_tasks._read_dispatch_receipt("token-a")
                    self.assertEqual(first_receipt_before_tick["state"], "prepared" if crash_after_first_marker else "accepted")
                    self.assertNotIn("occurrenceId", first_receipt_before_tick)
                    self.assertIsNone(hermes_scheduled_tasks._read_dispatch_receipt("token-b"))

                    hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                    scheduler_module.run_job({**stored, "execution_id": "execution-a"})
                    hermes_scheduled_tasks.trigger_scheduled_task("cron-multi", "token-b")
                    self.assertEqual(stored["indy_dispatch_token"], "token-b")
                    scheduler_module.run_job({**stored, "execution_id": "execution-b"})
                    first = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-multi" / "execution-a.pending.json").read_text(encoding="utf-8"))
                    second = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-multi" / "execution-b.pending.json").read_text(encoding="utf-8"))
                    first_receipt = hermes_scheduled_tasks._read_dispatch_receipt("token-a")
                    second_receipt = hermes_scheduled_tasks._read_dispatch_receipt("token-b")

                self.assertEqual(first["dispatchToken"], "token-a")
                self.assertEqual(second["dispatchToken"], "token-b")
                self.assertNotEqual(first["hermesRunId"], second["hermesRunId"])
                self.assertEqual(first_receipt["occurrenceId"], "execution-a")
                self.assertEqual(second_receipt["occurrenceId"], "execution-b")
                self.assertIsNone(stored.get("indy_dispatch_token"))

    def test_second_token_does_not_starve_when_first_hook_crashes_after_pending_evidence(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        scheduler_module = types.ModuleType("cron.scheduler")
        executions_module = types.ModuleType("cron.executions")
        executions_module._TERMINAL_STATES = ("completed", "failed", "unknown")
        stored = {"id": "cron-no-starve", "name": "Cron", "state": "scheduled", "enabled": True, "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high"}
        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: dict(stored) if job_id == "cron-no-starve" else None
        jobs_module.resolve_job_ref = jobs_module.get_job
        jobs_module.is_terminal_job = lambda job: False
        jobs_module.update_job = lambda job_id, updates: (stored.update(updates), dict(stored))[1]
        scheduler_module.run_job = lambda job, *args, **kwargs: (True, "ok", "", None)
        scheduler_module.get_fallback_chain = lambda config: []
        executions_module.list_executions = lambda job_id=None, limit=50: [{
            "id": "execution-a-crashed", "job_id": "cron-no-starve", "status": "failed",
            "claimed_at": "2026-09-02T08:00:00Z", "started_at": None,
            "finished_at": "2026-09-02T08:00:01Z", "error": "hook crash",
        }]
        with tempfile.TemporaryDirectory() as hermes_home:
            allowed = Path(hermes_home) / "allowed"
            workdir = allowed / "client"
            workdir.mkdir(parents=True)
            stored["workdir"] = str(workdir)
            with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                 patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                 patch.object(hermes_scheduled_tasks, "_kick_immediate_tick"), \
                 patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                 patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                 patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module, "cron.scheduler": scheduler_module, "cron.executions": executions_module}), \
                 patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                hermes_scheduled_tasks.trigger_scheduled_task("cron-no-starve", "token-a")
                with self.assertRaises(hermes_scheduled_tasks.WorkerError):
                    hermes_scheduled_tasks.trigger_scheduled_task("cron-no-starve", "token-b")
                hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                with patch.object(hermes_scheduled_tasks, "_after_occurrence_pending_write", side_effect=RuntimeError("crash-after-pending")):
                    with self.assertRaisesRegex(RuntimeError, "crash-after-pending"):
                        scheduler_module.run_job({**stored, "execution_id": "execution-a-crashed"})
                self.assertEqual(hermes_scheduled_tasks._finalize_pending_manifests_once(), 1)
                first_receipt = hermes_scheduled_tasks._read_dispatch_receipt("token-a")
                self.assertEqual(first_receipt.get("occurrenceId"), "execution-a-crashed")
                self.assertIsNone(stored.get("indy_dispatch_token"))
                hermes_scheduled_tasks.trigger_scheduled_task("cron-no-starve", "token-b")
                scheduler_module.run_job({**stored, "execution_id": "execution-b-after-crash"})
                second = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-no-starve" / "execution-b-after-crash.pending.json").read_text(encoding="utf-8"))

        self.assertEqual(second["dispatchToken"], "token-b")

    def test_dispatch_crash_boundaries_recover_the_same_occurrence_before_later_auto_run(self):
        seams = (
            "_after_occurrence_pending_write",
            "_after_occurrence_receipt_bind",
            "_after_occurrence_token_clear",
            "_before_occurrence_runner",
        )
        for seam in seams:
            with self.subTest(seam=seam), tempfile.TemporaryDirectory() as hermes_home:
                cron_module = types.ModuleType("cron")
                jobs_module = types.ModuleType("cron.jobs")
                scheduler_module = types.ModuleType("cron.scheduler")
                executions_module = types.ModuleType("cron.executions")
                executions_module._TERMINAL_STATES = ("completed", "failed", "unknown")
                allowed = Path(hermes_home) / "allowed"
                workdir = allowed / "client"
                workdir.mkdir(parents=True)
                stored = {"id": "cron-crash", "name": "Cron", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoning_effort": "high", "workdir": str(workdir), "indy_dispatch_token": "crash-token"}
                jobs_module._jobs_lock = nullcontext
                jobs_module.get_job = lambda job_id: dict(stored) if job_id == "cron-crash" else None
                jobs_module.update_job = lambda job_id, updates: (stored.update(updates), dict(stored))[1]
                scheduler_module.run_job = lambda job, *args, **kwargs: (True, "ok", "", None)
                scheduler_module.get_fallback_chain = lambda config: []
                records = [{"id": "manual-crash-id", "job_id": "cron-crash", "status": "failed", "started_at": "2026-09-02T08:00:00Z", "finished_at": "2026-09-02T08:00:01Z", "error": "crashed"}]
                executions_module.list_executions = lambda job_id=None, limit=50: list(records)
                snapshot = {"scheduledTaskName": "Cron", "provider": "openai-codex", "model": "gpt-5.6-sol", "reasoningEffort": "high", "workdir": str(workdir)}
                with patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
                     patch.object(hermes_scheduled_tasks, "_validate_execution_hook_contract", return_value=True), \
                     patch.object(hermes_scheduled_tasks, "_fresh_runtime_status", return_value={"provider": "openai-codex", "profileId": "etienne-openai", "authState": "connected", "models": [{"id": "gpt-5.6-sol", "reasoningEfforts": ["high"]}]}), \
                     patch.object(hermes_scheduled_tasks, "_scheduled_workdir_roots", return_value=[allowed]), \
                     patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module, "cron.scheduler": scheduler_module, "cron.executions": executions_module}), \
                     patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
                    hermes_scheduled_tasks._atomic_replace_json(
                        hermes_scheduled_tasks._dispatch_receipt_path("crash-token"),
                        {"token": "crash-token", "scheduledTaskId": "cron-crash", "state": "prepared", "preparedAt": "2026-09-02T08:00:00Z", "configSnapshot": snapshot},
                    )
                    hermes_scheduled_tasks.install_scheduled_task_execution_hook()
                    self.assertIs(scheduler_module.run_job, hermes_scheduled_tasks._controlled_run_job)
                    with patch.object(hermes_scheduled_tasks, seam, side_effect=RuntimeError(seam), create=True):
                        with self.assertRaisesRegex(RuntimeError, seam):
                            scheduler_module.run_job({**stored, "execution_id": "manual-crash-id"})
                    hermes_scheduled_tasks._finalize_pending_manifests_once()
                    scheduler_module.run_job({**stored, "execution_id": "automatic-after-crash"})
                    receipt = hermes_scheduled_tasks._read_dispatch_receipt("crash-token")
                    terminal = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-crash" / "manual-crash-id.json").read_text(encoding="utf-8"))
                    automatic = json.loads((Path(hermes_home) / "cron" / "indy-manifests" / "cron-crash" / "automatic-after-crash.pending.json").read_text(encoding="utf-8"))

                self.assertEqual(receipt["occurrenceId"], "manual-crash-id")
                self.assertEqual(terminal["dispatchToken"], "crash-token")
                self.assertIsNone(stored.get("indy_dispatch_token"))
                self.assertIsNone(automatic["dispatchToken"])

    def test_manual_dispatch_receipt_recovers_crash_after_atomic_job_marker_without_retrigger(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        stored = {"id": "cron-1", "name": "Cron", "state": "scheduled", "enabled": True}
        writes = []
        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: dict(stored) if job_id == "cron-1" else None
        jobs_module.resolve_job_ref = jobs_module.get_job
        jobs_module.is_terminal_job = lambda job: False

        def update_job(job_id, updates):
            writes.append(dict(updates))
            stored.update(updates)
            return dict(stored)

        jobs_module.update_job = update_job
        with tempfile.TemporaryDirectory() as hermes_home, \
             patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.object(hermes_scheduled_tasks, "_kick_immediate_tick"), \
             patch.object(hermes_scheduled_tasks, "_after_dispatch_job_update", side_effect=[RuntimeError("crash"), None]), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module}), \
             patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
            with self.assertRaisesRegex(RuntimeError, "crash"):
                hermes_scheduled_tasks.trigger_scheduled_task("cron-1", "dispatch-token-1")
            replay = hermes_scheduled_tasks.trigger_scheduled_task("cron-1", "dispatch-token-1")

        self.assertEqual(len(writes), 1)
        self.assertEqual(stored["indy_dispatch_token"], "dispatch-token-1")
        self.assertEqual(replay["dispatchReceipt"]["state"], "accepted")

    def test_unrelated_concurrent_job_update_does_not_fake_a_crash_before_effect_receipt(self):
        cron_module = types.ModuleType("cron")
        jobs_module = types.ModuleType("cron.jobs")
        stored = {"id": "cron-1", "name": "Cron", "state": "scheduled", "enabled": True}
        writes = []
        jobs_module._jobs_lock = nullcontext
        jobs_module.get_job = lambda job_id: dict(stored) if job_id == "cron-1" else None
        jobs_module.resolve_job_ref = jobs_module.get_job
        jobs_module.is_terminal_job = lambda job: False
        jobs_module.update_job = lambda job_id, updates: (writes.append(dict(updates)), stored.update(updates), dict(stored))[2]

        with tempfile.TemporaryDirectory() as hermes_home, \
             patch.object(hermes_scheduled_tasks, "_ensure_imports"), \
             patch.object(hermes_scheduled_tasks, "_kick_immediate_tick"), \
             patch.object(hermes_scheduled_tasks, "_before_dispatch_job_update", side_effect=[RuntimeError("crash-before"), None]), \
             patch.dict(sys.modules, {"cron": cron_module, "cron.jobs": jobs_module}), \
             patch.dict("os.environ", {"HERMES_HOME": hermes_home}):
            with self.assertRaisesRegex(RuntimeError, "crash-before"):
                hermes_scheduled_tasks.trigger_scheduled_task("cron-1", "dispatch-token-2")
            stored["name"] = "Concurrent rename"
            replay = hermes_scheduled_tasks.trigger_scheduled_task("cron-1", "dispatch-token-2")

        self.assertEqual(len(writes), 1)
        self.assertEqual(stored["indy_dispatch_token"], "dispatch-token-2")
        self.assertEqual(replay["dispatchReceipt"]["state"], "accepted")

class WorkerErrorBoundaryTest(unittest.TestCase):
    def test_provider_exceptions_become_stable_secret_free_public_payloads(self):
        detail = (
            'Authorization: Bearer bearer-python-secret\n'
            'Authorization: Basic dXNlcjpwYXNz\n'
            'Authorization: Digest username="digest-python-user", nonce="digest-python-nonce", response="digest-python-response"\n'
            '{"token":"python-token-secret","credential":"python-credential-secret","password":"python-password-secret"}'
        )

        auth_payload = hermes_worker._error_payload(Exception(f"401 unauthorized {detail}"))
        provider_payload = hermes_worker._error_payload(
            hermes_worker.WorkerError(detail, code="provider_error", hint=detail)
        )

        self.assertEqual(auth_payload, {
            "message": "Codex authentication failed.",
            "code": "auth_error",
            "hint": "Reconnect the Codex OAuth profile.",
        })
        self.assertEqual(provider_payload, {
            "message": "Codex provider request failed.",
            "code": "provider_error",
        })
        exposed = json.dumps([auth_payload, provider_payload])
        for secret in (
            "bearer-python-secret", "dXNlcjpwYXNz", "digest-python-user",
            "digest-python-nonce", "digest-python-response", "python-token-secret",
            "python-credential-secret", "python-password-secret",
        ):
            self.assertNotIn(secret, exposed)


if __name__ == "__main__":
    unittest.main()
