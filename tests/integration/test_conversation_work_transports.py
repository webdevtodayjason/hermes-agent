"""End-to-end parity contract for HTTP Runs and TUI work.* transports."""

import asyncio
import threading
from unittest.mock import patch

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from gateway.run_service import PUBLIC_RUN_STATUS_FIELDS
from gateway.run_service_runtime import RunServiceRuntime
from hermes_constants import (
    get_hermes_home,
    reset_hermes_home_override,
    set_hermes_home_override,
)
from tui_gateway import server as tui_server
from tui_gateway.work_runs import WorkRuns


class _BlockingAgent:
    session_prompt_tokens = 1
    session_completion_tokens = 0
    session_total_tokens = 1

    def __init__(self) -> None:
        self.started = threading.Event()
        self.released = threading.Event()
        self.interrupted = threading.Event()

    def run_conversation(self, **_kwargs):
        self.started.set()
        assert self.released.wait(2.0)
        return {"final_response": "transport parity result"}

    def interrupt(self, _reason: str) -> None:
        self.interrupted.set()
        self.released.set()


def _rpc(method: str, params: dict) -> dict:
    response = tui_server.handle_request(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    )
    assert response is not None
    return response


def _assert_public_status_contract(status: dict) -> None:
    assert set(status) <= PUBLIC_RUN_STATUS_FIELDS
    assert {
        "object",
        "run_id",
        "status",
        "session_id",
        "model",
        "created_at",
        "updated_at",
    } <= set(status)


def _http_run_not_found(run_id: str) -> dict:
    return {
        "error": {
            "message": f"Run not found: {run_id}",
            "type": "invalid_request_error",
            "param": None,
            "code": "run_not_found",
        }
    }


async def _wait_for_terminal(client: TestClient, run_id: str, session_id: str) -> dict:
    for _ in range(1000):
        response = await client.get(
            f"/v1/runs/{run_id}", params={"session_id": session_id}
        )
        assert response.status == 200
        status = await response.json()
        if status["status"] in {"completed", "failed", "cancelled"}:
            return status
        await asyncio.sleep(0.001)
    raise AssertionError("run did not reach a terminal state")


@pytest.mark.anyio
async def test_http_and_json_rpc_share_one_canonical_run_lifecycle(
    monkeypatch, tmp_path
):
    session_id = "transport-parity-conversation"
    wrong_session = "different-conversation"
    profile_home = tmp_path / "hermes-home"
    profile_home.mkdir()
    home_token = set_hermes_home_override(profile_home)
    agent = _BlockingAgent()
    http_adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={}))

    runtime = RunServiceRuntime(startup_timeout=1.0)
    work = WorkRuns(
        service=http_adapter._run_service,
        runtime=runtime,
        model="parity/model",
    )
    monkeypatch.setattr(tui_server, "_work_runs_for_active_profile", lambda: work)

    app = web.Application()
    app["api_server_adapter"] = http_adapter
    http_adapter._register_run_routes(app)

    try:
        assert get_hermes_home().resolve() == profile_home.resolve()
        with patch.object(http_adapter, "_create_agent", return_value=agent):
            async with TestClient(TestServer(app)) as client:
                started_response = await client.post(
                    "/v1/runs",
                    json={
                        "input": "hold until stopped",
                        "session_id": session_id,
                        "model": "parity/model",
                    },
                )
                assert started_response.status == 202
                started = await started_response.json()
                run_id = started["run_id"]
                assert await asyncio.to_thread(agent.started.wait, 1.0)

                recovered = _rpc("work.recover", {"session_id": session_id})
                assert [item["run_id"] for item in recovered["result"]["data"]] == [
                    run_id
                ]

                rpc_status = _rpc(
                    "work.status", {"session_id": session_id, "run_id": run_id}
                )["result"]
                http_status_response = await client.get(
                    f"/v1/runs/{run_id}", params={"session_id": session_id}
                )
                assert http_status_response.status == 200
                http_status = await http_status_response.json()
                assert rpc_status == http_status
                _assert_public_status_contract(rpc_status)

                wrong_rpc = _rpc(
                    "work.status",
                    {"session_id": wrong_session, "run_id": run_id},
                )
                wrong_http_response = await client.get(
                    f"/v1/runs/{run_id}", params={"session_id": wrong_session}
                )
                wrong_http = await wrong_http_response.json()
                missing_status_response = await client.get(
                    "/v1/runs/run_00000000000000000000000000000000",
                    params={"session_id": wrong_session},
                )
                missing_status = await missing_status_response.json()
                assert wrong_rpc["error"] == {
                    "code": -32004,
                    "message": "run not found",
                }
                assert wrong_http_response.status == 404
                assert missing_status_response.status == 404
                assert wrong_http == _http_run_not_found(run_id)
                assert missing_status == _http_run_not_found(
                    "run_00000000000000000000000000000000"
                )
                assert not agent.interrupted.is_set()

                wrong_stop_rpc = _rpc(
                    "work.stop",
                    {"session_id": wrong_session, "run_id": run_id},
                )
                wrong_stop_http_response = await client.post(
                    f"/v1/runs/{run_id}/stop",
                    json={"session_id": wrong_session},
                )
                wrong_stop_http = await wrong_stop_http_response.json()
                missing_stop_response = await client.post(
                    "/v1/runs/run_00000000000000000000000000000000/stop",
                    json={"session_id": wrong_session},
                )
                missing_stop = await missing_stop_response.json()
                assert wrong_stop_rpc["error"] == {
                    "code": -32004,
                    "message": "run not found",
                }
                assert wrong_stop_http_response.status == 404
                assert missing_stop_response.status == 404
                assert wrong_stop_http == _http_run_not_found(run_id)
                assert missing_stop == _http_run_not_found(
                    "run_00000000000000000000000000000000"
                )
                assert not agent.interrupted.is_set()

                stop_response = await client.post(
                    f"/v1/runs/{run_id}/stop",
                    json={"session_id": session_id},
                )
                assert stop_response.status == 200
                assert agent.interrupted.wait(1.0)

                terminal_http = await _wait_for_terminal(client, run_id, session_id)
                terminal_rpc = _rpc(
                    "work.status", {"session_id": session_id, "run_id": run_id}
                )["result"]
                assert terminal_rpc == terminal_http
                _assert_public_status_contract(terminal_rpc)
                assert terminal_http["status"] == "cancelled"

        assert work.service is http_adapter._run_service
        assert http_adapter._run_registry is work.service.registry
        assert not hasattr(http_adapter, "tasks")
        assert not hasattr(work, "tasks")
        assert not hasattr(work, "runs")
    finally:
        agent.released.set()
        runtime.shutdown(timeout=1.0)
        reset_hermes_home_override(home_token)
