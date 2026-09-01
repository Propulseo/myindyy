#!/usr/bin/env python3
"""Regression tests for _resolve_model_provider (managed custom-provider routing).

Catalog model ids like "anthropic/claude-sonnet-5" must stay on a configured
custom: provider (the managed Agent37 starter proxy) instead of being re-routed
to the built-in openrouter provider, which holds no credentials on managed
instances (HTTP 401 "User not found").
"""

import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server" / "workers"))

import hermes_worker

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
    def test_classifies_all_public_oauth_states_from_structured_error_metadata(self):
        cases = [
            (type("Missing", (RuntimeError,), {"code": "codex_auth_missing"})("secret"), "missing"),
            (type("Expired", (RuntimeError,), {"code": "token_expired"})("secret"), "expired"),
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
        groups = {
            "defaultModel": "gpt-5.6-sol",
            "activeProvider": "openai-codex",
            "groups": [{
                "provider": "openai-codex",
                "models": [{
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
                }],
            }],
        }

        with patch.dict(sys.modules, {"hermes_cli.runtime_provider": fake_runtime_provider}), \
             patch.object(hermes_worker, "_list_models", return_value=groups), \
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
        generate.assert_not_called()

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

if __name__ == "__main__":
    unittest.main()
