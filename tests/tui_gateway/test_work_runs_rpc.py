"""Behavior contracts for thin work.* JSON-RPC adapters."""

import asyncio
import importlib
import sys
import threading
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from gateway.run_service import RunService
from gateway.run_service_runtime import RunServiceRuntime
import tui_gateway.work_runs as work_runs_module
from tui_gateway.work_runs import WorkRunNotFound, WorkRuns, get_work_runs


@pytest.fixture()
def server():
    with patch.dict(
        "sys.modules",
        {
            "hermes_constants": MagicMock(
                get_hermes_home=MagicMock(return_value="/tmp/hermes-work-rpc-test")
            ),
            "hermes_cli.env_loader": MagicMock(),
            "hermes_cli.banner": MagicMock(),
            "hermes_state": MagicMock(),
        },
    ):
        module = importlib.import_module("tui_gateway.server")
        yield module
        module._sessions.clear()
        module._pending.clear()
        module._answers.clear()


class _FakeWorkRuns:
    def __init__(self):
        self.calls = []

    def start(self, *, session_id, user_input, history):
        self.calls.append(("start", session_id, user_input, history))
        return {"run_id": "run_" + "a" * 32, "status": "queued"}

    def recover(self, *, session_id):
        self.calls.append(("recover", session_id))
        return {"data": []}

    def status(self, *, session_id, run_id):
        self.calls.append(("status", session_id, run_id))
        return {"run_id": run_id, "status": "running"}

    def stop(self, *, session_id, run_id):
        self.calls.append(("stop", session_id, run_id))
        return {"run_id": run_id, "status": "stopping"}


class _MissingWorkRuns(_FakeWorkRuns):
    def status(self, *, session_id, run_id):
        raise WorkRunNotFound("run not found")

    def stop(self, *, session_id, run_id):
        raise WorkRunNotFound("run not found")


def _request(server, method, params):
    return server.handle_request(
        {"jsonrpc": "2.0", "id": "work-test", "method": method, "params": params}
    )


def test_work_methods_are_registered_as_long_handlers(server, monkeypatch):
    fake = _FakeWorkRuns()
    monkeypatch.setattr(server, "_work_runs_for_active_profile", lambda: fake)

    expected = {"work.start", "work.recover", "work.status", "work.stop"}
    assert expected <= set(server._methods)
    assert expected <= server._LONG_HANDLERS


def test_work_methods_validate_and_delegate_through_handle_request(server, monkeypatch):
    fake = _FakeWorkRuns()
    monkeypatch.setattr(server, "_work_runs_for_active_profile", lambda: fake)
    run_id = "run_" + "b" * 32

    start = _request(
        server,
        "work.start",
        {
            "session_id": "conversation-1",
            "input": "Investigate the failure",
            "history": [{"role": "user", "content": "Earlier context"}],
        },
    )
    recover = _request(server, "work.recover", {"session_id": "conversation-1"})
    status = _request(
        server,
        "work.status",
        {"session_id": "conversation-1", "run_id": run_id},
    )
    stop = _request(
        server,
        "work.stop",
        {"session_id": "conversation-1", "run_id": run_id},
    )

    assert start["result"]["status"] == "queued"
    assert recover["result"] == {"data": []}
    assert status["result"]["run_id"] == run_id
    assert stop["result"]["status"] == "stopping"
    assert fake.calls == [
        (
            "start",
            "conversation-1",
            "Investigate the failure",
            [{"role": "user", "content": "Earlier context"}],
        ),
        ("recover", "conversation-1"),
        ("status", "conversation-1", run_id),
        ("stop", "conversation-1", run_id),
    ]


@pytest.mark.parametrize(
    ("method", "params"),
    [
        ("work.start", {"session_id": "", "input": "hello"}),
        ("work.start", {"session_id": "conversation-1", "input": ""}),
        ("work.start", {"session_id": "conversation-1", "input": "hello", "history": {}}),
        ("work.start", {"session_id": "conversation-1", "input": "hello", "history": ["bad"]}),
        ("work.start", {"session_id": "conversation-1", "input": "hello", "history": [{"role": "user"}]}),
        ("work.start", {"session_id": "conversation-1", "input": "hello", "history": [{"role": "invalid", "content": "bad"}]}),
        ("work.start", {"session_id": "conversation-1", "input": "hello", "history": [{"role": "assistant", "content": 3}]}),
        ("work.recover", {"session_id": " "}),
        ("work.status", {"session_id": "conversation-1", "run_id": "../other"}),
        ("work.stop", {"session_id": "conversation-1", "run_id": "run_short"}),
    ],
)
def test_work_methods_reject_invalid_params_without_calling_service(
    server, monkeypatch, method, params
):
    fake = _FakeWorkRuns()
    monkeypatch.setattr(server, "_work_runs_for_active_profile", lambda: fake)

    response = _request(server, method, params)

    assert response["error"]["code"] == -32602
    assert fake.calls == []


@pytest.mark.parametrize("method", ["work.status", "work.stop"])
def test_work_status_and_stop_hide_mismatch_and_absence_identically(
    server, monkeypatch, method
):
    monkeypatch.setattr(
        server,
        "_work_runs_for_active_profile",
        lambda: _MissingWorkRuns(),
    )

    response = _request(
        server,
        method,
        {"session_id": "conversation-1", "run_id": "run_" + "f" * 32},
    )

    assert response["error"] == {"code": -32004, "message": "run not found"}


def test_work_adapter_routes_requested_profile_to_its_own_authority(
    server, monkeypatch, tmp_path
):
    launch_home = tmp_path / "launch"
    other_home = tmp_path / "other"
    launch_home.mkdir()
    other_home.mkdir()
    active_home = [launch_home]
    authorities = {launch_home: _FakeWorkRuns(), other_home: _FakeWorkRuns()}

    monkeypatch.setattr(
        server,
        "_profile_home",
        lambda profile: other_home if profile == "other" else None,
    )

    def set_override(home):
        previous = active_home[0]
        active_home[0] = Path(home)
        return previous

    monkeypatch.setattr(server, "set_hermes_home_override", set_override)
    monkeypatch.setattr(
        server,
        "reset_hermes_home_override",
        lambda previous: active_home.__setitem__(0, previous),
    )
    monkeypatch.setattr(
        server,
        "_work_runs_for_active_profile",
        lambda: authorities[active_home[0]],
    )

    response = _request(
        server,
        "work.recover",
        {"session_id": "conversation-1", "profile": "other"},
    )

    assert response["result"] == {"data": []}
    assert authorities[launch_home].calls == []
    assert authorities[other_home].calls == [("recover", "conversation-1")]
    assert active_home == [launch_home]


class _FakeRunService:
    def __init__(self):
        self.calls = []
        self.owner_threads = set()

    def _record(self, *call):
        self.calls.append(call)
        self.owner_threads.add(threading.get_ident())

    def start(self, **kwargs):
        self._record("start", kwargs)
        return "run_" + "c" * 32

    def status(self, run_id, expected_session_id=None):
        self._record("status", run_id, expected_session_id)
        if expected_session_id == "missing":
            return None
        return {
            "run_id": run_id,
            "session_id": expected_session_id,
            "status": "queued",
        }

    def list(self, session_id):
        self._record("list", session_id)
        return [{"run_id": "run_" + "d" * 32, "session_id": session_id}]

    def stop(self, run_id, expected_session_id=None):
        self._record("stop", run_id, expected_session_id)
        if expected_session_id == "missing":
            return None
        return {"run_id": run_id, "status": "stopping"}

    def sweep(self, now, stream_ttl, status_ttl):
        self._record("sweep", now, stream_ttl, status_ttl)


def test_work_runs_uses_one_runtime_owner_for_all_service_calls():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    service = _FakeRunService()
    work = WorkRuns(service=service, runtime=runtime, model="test/model")
    try:
        started = work.start(
            session_id="conversation-1",
            user_input="do the work",
            history=[{"role": "user", "content": "context"}],
        )
        recovered = work.recover(session_id="conversation-1")
        status = work.status(
            session_id="conversation-1", run_id="run_" + "c" * 32
        )
        stopped = work.stop(
            session_id="conversation-1", run_id="run_" + "c" * 32
        )
    finally:
        runtime.shutdown(timeout=1.0)

    assert started["status"] == "queued"
    assert recovered["data"][0]["session_id"] == "conversation-1"
    assert status["session_id"] == "conversation-1"
    assert stopped["status"] == "stopping"
    assert len(service.owner_threads) == 1


def test_work_start_preserves_parent_return_address():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    service = _FakeRunService()
    work = WorkRuns(service=service, runtime=runtime, model="test/model")
    try:
        work.start(
            session_id="conversation-parent",
            gateway_session_key="durable-parent",
            origin_ui_session_id="live-tab",
            user_input="do the work",
            history=[],
        )
    finally:
        runtime.shutdown(timeout=1.0)

    start_kwargs = next(call[1] for call in service.calls if call[0] == "start")
    assert start_kwargs["session_id"] == "conversation-parent"
    assert start_kwargs["gateway_session_key"] == "durable-parent"
    assert start_kwargs["route"] == {"origin_ui_session_id": "live-tab"}


def test_work_start_leaves_approval_key_to_canonical_unique_run_id():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    service = _FakeRunService()
    work = WorkRuns(service=service, runtime=runtime, model="test/model")
    try:
        work.start(session_id="shared", user_input="one", history=[])
        work.start(session_id="shared", user_input="two", history=[])
    finally:
        runtime.shutdown(timeout=1.0)

    start_kwargs = [call[1] for call in service.calls if call[0] == "start"]
    assert len(start_kwargs) == 2
    assert all("approval_session_key" not in kwargs for kwargs in start_kwargs)


def test_work_runs_sweep_uses_canonical_api_retention_policy():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    service = _FakeRunService()
    work = WorkRuns(service=service, runtime=runtime, model="test/model")
    try:
        work.sweep(now=1234.5)
    finally:
        runtime.shutdown(timeout=1.0)

    assert ("sweep", 1234.5, 300, 3600) in service.calls


@pytest.mark.parametrize("operation", ["status", "stop"])
def test_work_runs_hides_mismatch_and_nonexistent_behind_one_typed_error(operation):
    runtime = RunServiceRuntime(startup_timeout=1.0)
    work = WorkRuns(service=_FakeRunService(), runtime=runtime, model="test/model")
    try:
        with pytest.raises(WorkRunNotFound, match="run not found"):
            getattr(work, operation)(
                session_id="missing",
                run_id="run_" + "e" * 32,
            )
    finally:
        runtime.shutdown(timeout=1.0)


def test_tui_hooks_publish_terminal_work_event_to_parent_queue(tmp_path):
    from tools.process_registry import process_registry

    while not process_registry.completion_queue.empty():
        process_registry.completion_queue.get_nowait()
    hooks = work_runs_module._TUIRunExecutionHooks(tmp_path, lambda **_kwargs: None)
    status = {
        "object": "hermes.run",
        "run_id": "run_" + "d" * 32,
        "status": "completed",
        "session_id": "conversation-parent",
        "output": "verified result",
        "last_event": "run.completed",
    }

    hooks.publish_terminal_event(
        status,
        gateway_session_key="durable-parent",
        route={"origin_ui_session_id": "live-tab"},
    )

    assert process_registry.completion_queue.get_nowait() == {
        "type": "work_run",
        "run_id": "run_" + "d" * 32,
        "status": "completed",
        "session_id": "conversation-parent",
        "session_key": "durable-parent",
        "origin_ui_session_id": "live-tab",
        "output": "verified result",
        "error": "",
    }


def test_worker_session_context_is_marked_non_recursive(tmp_path, monkeypatch):
    from gateway import session_context
    from hermes_constants import reset_hermes_home_override

    observed = {}

    def fake_set_session_vars(**kwargs):
        observed.update(kwargs)
        return []

    monkeypatch.setattr(session_context, "set_session_vars", fake_set_session_vars)
    hooks = work_runs_module._TUIRunExecutionHooks(tmp_path, lambda **_kwargs: None)
    session_tokens, home_token = hooks.bind_session("run-session-key")
    reset_hermes_home_override(home_token)

    assert session_tokens == []
    assert observed["source"] == "work_run"
    assert observed["session_key"] == "run-session-key"
    assert observed["session_id"] == "run-session-key"


class _CompletedAgent:
    session_prompt_tokens = 1
    session_completion_tokens = 2
    session_total_tokens = 3

    def __init__(self, observed_homes):
        self.observed_homes = observed_homes

    def run_conversation(self, **_kwargs):
        from hermes_constants import get_hermes_home

        self.observed_homes.append(("run", Path(get_hermes_home()).resolve()))
        return {"final_response": "completed through work RPC"}


def test_profile_composition_reuses_one_authority_and_runs_real_service(tmp_path):
    first_home = tmp_path / "profile-a"
    second_home = tmp_path / "profile-b"
    first_home.mkdir()
    second_home.mkdir()
    observed_homes = []

    def factory(**_kwargs):
        from hermes_constants import get_hermes_home

        observed_homes.append(("create", Path(get_hermes_home()).resolve()))
        return _CompletedAgent(observed_homes)

    first = get_work_runs(first_home, agent_factory=factory, model="test/model")
    same = get_work_runs(first_home, agent_factory=factory, model="ignored/model")
    second = get_work_runs(second_home, agent_factory=factory, model="test/model")
    first_sweeper = first._sweeper_future
    second_sweeper = second._sweeper_future
    try:
        assert first_sweeper is not None and not first_sweeper.done()
        assert second_sweeper is not None and not second_sweeper.done()
        started = first.start(
            session_id="conversation-real",
            user_input="complete",
            history=[],
        )

        async def wait_for_terminal():
            for _ in range(1000):
                status = first.service.status(started["run_id"], "conversation-real")
                if status and status.get("status") == "completed":
                    return status
                await asyncio.sleep(0)
            raise AssertionError("run did not reach terminal state")

        terminal = first._call(wait_for_terminal())
        recovered = first.recover(session_id="conversation-real")
    finally:
        first.runtime.shutdown(timeout=1.0)
        second.runtime.shutdown(timeout=1.0)
        work_runs_module._instances.clear()

    assert first is same
    assert first is not second
    assert first_sweeper.done()
    assert second_sweeper.done()
    assert terminal["output"] == "completed through work RPC"
    assert recovered["data"][0]["run_id"] == started["run_id"]
    assert observed_homes == [
        ("create", first_home.resolve()),
        ("run", first_home.resolve()),
    ]


class _BlockingAgent:
    session_prompt_tokens = 0
    session_completion_tokens = 0
    session_total_tokens = 0

    def __init__(self, on_started, release):
        self.on_started = on_started
        self.release = release

    def run_conversation(self, **_kwargs):
        self.on_started()
        assert self.release.wait(1.0)
        return {"final_response": "done"}

    def interrupt(self, _reason):
        self.release.set()


def test_real_concurrent_same_session_runs_use_distinct_approval_keys(
    tmp_path, monkeypatch
):
    from tools import approval

    profile_home = tmp_path / "approval-profile"
    profile_home.mkdir()
    release = threading.Event()
    both_started = threading.Event()
    count_lock = threading.Lock()
    started_count = 0
    registered = []

    def on_started():
        nonlocal started_count
        with count_lock:
            started_count += 1
            if started_count == 2:
                both_started.set()

    monkeypatch.setattr(
        approval,
        "register_gateway_notify",
        lambda key, _callback: registered.append(key),
    )
    monkeypatch.setattr(approval, "unregister_gateway_notify", lambda _key: None)

    hooks = work_runs_module._TUIRunExecutionHooks(
        profile_home,
        lambda **_kwargs: _BlockingAgent(on_started, release),
    )
    runtime = RunServiceRuntime(startup_timeout=1.0)
    work = WorkRuns(
        service=RunService(hooks),
        runtime=runtime,
        model="test/model",
    )
    try:
        first = work.start(session_id="shared", user_input="one", history=[])
        second = work.start(session_id="shared", user_input="two", history=[])
        assert both_started.wait(1.0)
        assert set(registered) == {first["run_id"], second["run_id"]}
        assert first["run_id"] != second["run_id"]
        assert "shared" not in registered
    finally:
        release.set()
        runtime.shutdown(timeout=1.0)
