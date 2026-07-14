"""Behavior contract for reconnecting conversational clients to Hermes runs."""

from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter


def _create_run_listing_app(adapter: APIServerAdapter) -> web.Application:
    handler = getattr(adapter, "_handle_list_runs", None)
    assert handler is not None, "Runs API must expose a reconnect-safe list handler"

    app = web.Application()
    app["api_server_adapter"] = adapter
    app.router.add_get("/v1/runs", handler)
    return app


@pytest.mark.anyio
async def test_list_runs_filters_by_conversation_session_and_orders_newest_first():
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    adapter._set_run_status(
        "run_old",
        "running",
        created_at=10.0,
        session_id="conversation-a",
        model="hermes-agent",
    )
    adapter._set_run_status(
        "run_other",
        "running",
        created_at=20.0,
        session_id="conversation-b",
        model="hermes-agent",
    )
    adapter._set_run_status(
        "run_new",
        "waiting_for_approval",
        created_at=30.0,
        session_id="conversation-a",
        model="hermes-agent",
    )

    app = _create_run_listing_app(adapter)
    async with TestClient(TestServer(app)) as client:
        response = await client.get("/v1/runs?session_id=conversation-a")
        assert response.status == 200
        payload = await response.json()

    assert payload["object"] == "list"
    assert [run["run_id"] for run in payload["data"]] == ["run_new", "run_old"]
    assert all(run["session_id"] == "conversation-a" for run in payload["data"])


@pytest.mark.anyio
async def test_list_runs_requires_a_conversation_session_filter():
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    app = _create_run_listing_app(adapter)

    async with TestClient(TestServer(app)) as client:
        response = await client.get("/v1/runs")

    assert response.status == 400


@pytest.mark.anyio
async def test_list_runs_sanitizes_records_and_tolerates_bad_timestamps():
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    adapter._run_statuses["run_bad_time"] = {
        "object": "hermes.run",
        "run_id": "run_bad_time",
        "status": "running",
        "session_id": "conversation-a",
        "created_at": "not-a-number",
        "updated_at": 20.0,
        "_private_agent_state": "must-not-leak",
    }
    app = _create_run_listing_app(adapter)

    async with TestClient(TestServer(app)) as client:
        response = await client.get("/v1/runs?session_id=conversation-a")
        assert response.status == 200
        payload = await response.json()

    assert payload["data"][0]["run_id"] == "run_bad_time"
    assert "_private_agent_state" not in payload["data"][0]
    assert payload["data"][0]["created_at"] == 0.0


@pytest.mark.anyio
@pytest.mark.parametrize(
    "created_at",
    [
        float("nan"),
        float("inf"),
        float("-inf"),
        pytest.param(10**10000, id="overflow"),
    ],
)
async def test_list_runs_normalizes_non_finite_timestamps(created_at):
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    adapter._run_statuses["run_non_finite"] = {
        "object": "hermes.run",
        "run_id": "run_non_finite",
        "status": "running",
        "session_id": "conversation-a",
        "created_at": created_at,
        "updated_at": created_at,
    }
    app = _create_run_listing_app(adapter)

    async with TestClient(TestServer(app)) as client:
        response = await client.get("/v1/runs?session_id=conversation-a")
        assert response.status == 200
        payload = await response.json()

    assert payload["data"][0]["created_at"] == 0.0
    assert payload["data"][0]["updated_at"] == 0.0


def test_run_routes_register_get_and_post_on_the_canonical_collection():
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    register = getattr(adapter, "_register_run_routes", None)
    assert register is not None, "Runs API must register collection routes together"

    app = web.Application()
    register(app)
    routes = {
        (method, getattr(route.resource, "canonical", ""))
        for route in app.router.routes()
        for method in route.method.split(",")
    }

    assert ("GET", "/v1/runs") in routes
    assert ("POST", "/v1/runs") in routes
    assert ("GET", "/v1/runs/{run_id}") in routes
    assert ("POST", "/v1/runs/{run_id}/stop") in routes


@pytest.mark.anyio
async def test_list_runs_requires_the_api_bearer_key():
    adapter = APIServerAdapter(
        PlatformConfig(enabled=True, extra={"key": "sk-con...cret"})
    )
    adapter._set_run_status(
        "run_private",
        "running",
        session_id="conversation-private",
    )
    app = _create_run_listing_app(adapter)

    async with TestClient(TestServer(app)) as client:
        unauthenticated = await client.get("/v1/runs")
        authenticated = await client.get(
            "/v1/runs?session_id=conversation-private",
            headers={"Authorization": "Bearer sk-con...cret"},
        )

        assert unauthenticated.status == 401
        assert authenticated.status == 200


@pytest.mark.anyio
async def test_capabilities_advertise_run_reconnect_discovery():
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    app = web.Application()
    app.router.add_get("/v1/capabilities", adapter._handle_capabilities)

    async with TestClient(TestServer(app)) as client:
        response = await client.get("/v1/capabilities")
        assert response.status == 200
        payload = await response.json()

    assert payload["features"]["run_listing"] is True
    assert payload["endpoints"]["run_list"] == {
        "method": "GET",
        "path": "/v1/runs",
    }


@pytest.mark.anyio
async def test_status_and_stop_enforce_the_expected_conversation_atomically():
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))
    adapter._set_run_status(
        "run_owned",
        "running",
        session_id="conversation-a",
    )
    agent = MagicMock()
    adapter._active_run_agents["run_owned"] = agent
    app = web.Application()
    app["api_server_adapter"] = adapter
    adapter._register_run_routes(app)

    async with TestClient(TestServer(app)) as client:
        wrong_status = await client.get(
            "/v1/runs/run_owned?session_id=conversation-b"
        )
        wrong_stop = await client.post(
            "/v1/runs/run_owned/stop",
            json={"session_id": "conversation-b"},
        )
        missing_status = await client.get(
            "/v1/runs/run_missing?session_id=conversation-b"
        )
        missing_stop = await client.post(
            "/v1/runs/run_missing/stop",
            json={"session_id": "conversation-b"},
        )
        wrong_status_payload = await wrong_status.json()
        wrong_stop_payload = await wrong_stop.json()
        missing_status_payload = await missing_status.json()
        missing_stop_payload = await missing_stop.json()
        agent.interrupt.assert_not_called()
        invalid_stop = await client.post(
            "/v1/runs/run_owned/stop",
            json=[],
        )
        right_stop = await client.post(
            "/v1/runs/run_owned/stop",
            json={"session_id": "conversation-a"},
        )

    assert wrong_status.status == 404
    assert wrong_stop.status == 404
    assert missing_status.status == 404
    assert missing_stop.status == 404
    assert wrong_status_payload["error"]["code"] == missing_status_payload["error"]["code"]
    assert wrong_stop_payload["error"]["code"] == missing_stop_payload["error"]["code"]
    assert invalid_stop.status == 400
    assert right_stop.status == 200
    agent.interrupt.assert_called_once()
