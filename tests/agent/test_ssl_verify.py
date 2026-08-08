"""Tests for agent.ssl_verify.resolve_httpx_verify."""

import ssl

import certifi
import httpx
import pytest

from agent.ssl_verify import resolve_httpx_verify

_CA_ENV_VARS = ("HERMES_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE")


@pytest.fixture
def clean_ca_env(monkeypatch):
    for var in _CA_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


def test_ssl_verify_false_disables_verification(clean_ca_env):
    assert resolve_httpx_verify(ssl_verify=False) is False


def test_hermes_ca_bundle_returns_ssl_context(clean_ca_env, monkeypatch):
    monkeypatch.setenv("HERMES_CA_BUNDLE", certifi.where())
    result = resolve_httpx_verify()
    assert isinstance(result, ssl.SSLContext)


def test_explicit_ca_bundle_param(clean_ca_env):
    result = resolve_httpx_verify(ca_bundle=certifi.where())
    assert isinstance(result, ssl.SSLContext)


def test_missing_ca_bundle_falls_back_to_true(clean_ca_env, monkeypatch):
    monkeypatch.setenv("HERMES_CA_BUNDLE", "/nonexistent/root-ca.pem")
    assert resolve_httpx_verify() is True


def test_invalid_ssl_cert_file_is_removed_before_httpx_fallback(clean_ca_env, monkeypatch):
    malformed = (
        "/private/etc/ssl/cert.pem file_read_max_chars=100000 "
        "mcp_discovery_timeout=1.5 _config_version=33"
    )
    monkeypatch.setenv("SSL_CERT_FILE", malformed)

    verify = resolve_httpx_verify()

    assert "SSL_CERT_FILE" not in __import__("os").environ
    with httpx.Client(verify=verify) as client:
        assert client.is_closed is False


def test_default_without_env_is_true(clean_ca_env):
    assert resolve_httpx_verify() is True
