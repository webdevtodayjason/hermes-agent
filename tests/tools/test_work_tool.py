"""Model-callable durable work tools."""

from __future__ import annotations

import json


def test_work_start_uses_trusted_current_session_identity(monkeypatch, tmp_path):
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools import work_tool

    seen = {}

    class FakeWorkRuns:
        def start(self, **kwargs):
            seen.update(kwargs)
            return {
                "object": "hermes.run",
                "run_id": "run_" + "a" * 32,
                "status": "queued",
                "session_id": kwargs["session_id"],
                "model": "configured",
                "created_at": 1.0,
                "updated_at": 1.0,
                "last_event": "run.queued",
            }

    monkeypatch.setattr(work_tool, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(work_tool, "get_work_runs", lambda _home: FakeWorkRuns())
    tokens = set_session_vars(
        platform="tui",
        source="tui_gateway",
        session_key="durable-parent",
        session_id="conversation-parent",
        ui_session_id="live-tab",
        async_delivery=True,
    )
    try:
        result = json.loads(
            work_tool._handle_work_start(
                {"task": "Investigate the regression", "context": "Use strict TDD"}
            )
        )
    finally:
        clear_session_vars(tokens)

    assert result["run_id"] == "run_" + "a" * 32
    assert result["status"] == "queued"
    assert seen == {
        "session_id": "conversation-parent",
        "gateway_session_key": "durable-parent",
        "origin_ui_session_id": "live-tab",
        "user_input": "Investigate the regression",
        "history": [{"role": "user", "content": "Use strict TDD"}],
    }


def test_work_start_rejects_recursive_worker_invocation(monkeypatch, tmp_path):
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools import work_tool

    called = False

    class FakeWorkRuns:
        def start(self, **_kwargs):
            nonlocal called
            called = True
            return {}

    monkeypatch.setattr(work_tool, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(work_tool, "get_work_runs", lambda _home: FakeWorkRuns())
    tokens = set_session_vars(
        platform="tui",
        source="work_run",
        session_key="durable-parent",
        session_id="conversation-parent",
        ui_session_id="live-tab",
        async_delivery=True,
    )
    try:
        result = json.loads(work_tool._handle_work_start({"task": "spawn again"}))
    finally:
        clear_session_vars(tokens)

    assert result == {"error": "work runs cannot recursively delegate durable work"}
    assert called is False


def test_work_status_and_stop_are_scoped_to_current_session(monkeypatch, tmp_path):
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools import work_tool

    calls = []
    run_id = "run_" + "b" * 32

    class FakeWorkRuns:
        def status(self, **kwargs):
            calls.append(("status", kwargs))
            return {"run_id": kwargs["run_id"], "status": "running"}

        def stop(self, **kwargs):
            calls.append(("stop", kwargs))
            return {"run_id": kwargs["run_id"], "status": "stopping"}

    monkeypatch.setattr(work_tool, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(work_tool, "get_work_runs", lambda _home: FakeWorkRuns())
    tokens = set_session_vars(
        platform="tui",
        source="tui_gateway",
        session_key="durable-parent",
        session_id="conversation-parent",
        ui_session_id="live-tab",
        async_delivery=True,
    )
    try:
        status = json.loads(work_tool._handle_work_status({"run_id": run_id}))
        stopped = json.loads(work_tool._handle_work_stop({"run_id": run_id}))
    finally:
        clear_session_vars(tokens)

    assert status["status"] == "running"
    assert stopped["status"] == "stopping"
    assert calls == [
        ("status", {"session_id": "conversation-parent", "run_id": run_id}),
        ("stop", {"session_id": "conversation-parent", "run_id": run_id}),
    ]


def test_work_start_rejects_session_without_async_return_channel(monkeypatch, tmp_path):
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools import work_tool

    called = False

    class FakeWorkRuns:
        def start(self, **_kwargs):
            nonlocal called
            called = True
            return {}

    monkeypatch.setattr(work_tool, "get_hermes_home", lambda: tmp_path)
    monkeypatch.setattr(work_tool, "get_work_runs", lambda _home: FakeWorkRuns())
    tokens = set_session_vars(
        platform="api_server",
        source="api_server",
        session_key="request-key",
        session_id="request-session",
        async_delivery=False,
    )
    try:
        result = json.loads(work_tool._handle_work_start({"task": "run later"}))
    finally:
        clear_session_vars(tokens)

    assert result == {"error": "this conversation cannot receive durable work results"}
    assert called is False


def test_work_controls_hide_nonexistent_and_foreign_runs(monkeypatch, tmp_path):
    from gateway.session_context import clear_session_vars, set_session_vars
    from tools import work_tool
    from tui_gateway.work_runs import WorkRunNotFound

    class _MissingWorkRuns:
        def status(self, **_kwargs):
            raise WorkRunNotFound("run not found")

        def stop(self, **_kwargs):
            raise WorkRunNotFound("run not found")

    monkeypatch.setattr(work_tool, "get_work_runs", lambda _home: _MissingWorkRuns())
    monkeypatch.setattr(work_tool, "get_hermes_home", lambda: tmp_path)
    tokens = set_session_vars(session_id="conversation-parent")
    run_id = "run_" + "f" * 32
    try:
        status = json.loads(work_tool._handle_work_status({"run_id": run_id}))
        stopped = json.loads(work_tool._handle_work_stop({"run_id": run_id}))
    finally:
        clear_session_vars(tokens)

    assert status == {"error": "run not found"}
    assert stopped == {"error": "run not found"}
