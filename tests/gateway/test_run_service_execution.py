"""Execution lifecycle contract for the transport-neutral run service."""

import asyncio
import threading
from contextvars import ContextVar

import pytest

from gateway.run_service import RunRegistry, RunService, RunSubscriberLimitError


class FakeAgent:
    def __init__(self, result=None, *, error=None):
        self.result = result if result is not None else {"final_response": "done"}
        self.error = error
        self.session_prompt_tokens = 4
        self.session_completion_tokens = 2
        self.session_total_tokens = 6
        self.started = threading.Event()
        self.release = threading.Event()
        self.block = False
        self.interrupt_calls = []

    def run_conversation(self, **kwargs):
        self.started.set()
        if self.block:
            self.release.wait(timeout=5)
        if self.error is not None:
            raise self.error
        return self.result

    def interrupt(self, message):
        self.interrupt_calls.append(message)
        self.release.set()


class CallbackAgent(FakeAgent):
    def __init__(self, invoke):
        super().__init__({"final_response": "callback survived"})
        self.invoke = invoke
        self.hooks = None

    def run_conversation(self, **kwargs):
        self.started.set()
        self.invoke(self.hooks)
        return self.result


class FakeHooks:
    def __init__(self, agent=None):
        self.agent = agent or FakeAgent()
        self.created = []
        self.bound = []
        self.cleared = []
        self.registered = []
        self.unregistered = []
        self.activated = 0
        self.tracked = []
        self.approval_key = ContextVar("fake_approval_key", default=None)

    def create_agent(self, **kwargs):
        self.created.append(kwargs)
        return self.agent

    def bind_session(self, session_key):
        token = object()
        self.bound.append((session_key, token))
        return [token]

    def clear_session(self, tokens):
        self.cleared.append(tokens)

    def activate_admitted_request(self):
        self.activated += 1

    def register_approval_notify(self, session_key, callback):
        self.registered.append((session_key, callback))

    def unregister_approval_notify(self, session_key):
        self.unregistered.append(session_key)

    def set_approval_session(self, session_key):
        return self.approval_key.set(session_key)

    def reset_approval_session(self, token):
        self.approval_key.reset(token)

    def redact_error(self, value):
        return f"safe:{type(value).__name__}"

    def redact_approval_command(self, value):
        return f"redacted:{value}"

    def interrupt_agent(self, agent):
        agent.interrupt("Stop requested via API")

    def track_task(self, task):
        self.tracked.append(task)


async def _wait_terminal(service, run_id):
    for _ in range(100):
        status = service.status(run_id)
        if status and status["status"] in {"completed", "failed", "cancelled"}:
            return status
        await asyncio.sleep(0.01)
    raise AssertionError(f"run did not finish: {service.status(run_id)}")


def _start(service, **overrides):
    values = {
        "user_message": "hello",
        "conversation_history": [{"role": "user", "content": "earlier"}],
        "session_id": "conversation-a",
        "model": "hermes-agent",
        "approval_session_key": "approval-a",
        "ephemeral_system_prompt": "be concise",
        "gateway_session_key": "memory-a",
        "route": {"model": "test-model"},
    }
    values.update(overrides)
    return service.start(**values)


async def _drain_until_sentinel(queue):
    events = []
    while True:
        event = await asyncio.wait_for(queue.get(), timeout=1)
        if event is None:
            return events
        events.append(event)


@pytest.mark.anyio
async def test_start_to_completed_owns_agent_task_events_and_cleanup():
    hooks = FakeHooks(FakeAgent({"final_response": "finished"}))
    service = RunService(hooks, registry=RunRegistry())

    run_id = _start(service)
    status = await _wait_terminal(service, run_id)

    assert status["status"] == "completed"
    assert status["output"] == "finished"
    assert status["usage"] == {
        "input_tokens": 4,
        "output_tokens": 2,
        "total_tokens": 6,
    }
    assert status["last_event"] == "run.completed"
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None
    assert hooks.activated == 1
    assert len(hooks.tracked) == 1
    assert [key for key, _ in hooks.bound] == ["approval-a"]
    assert hooks.cleared == [[hooks.bound[0][1]]]
    assert [key for key, _ in hooks.registered] == ["approval-a"]
    assert hooks.unregistered.count("approval-a") >= 1
    queue = service.stream_for(run_id)
    assert (await queue.get())["event"] == "run.completed"
    assert await queue.get() is None


@pytest.mark.anyio
async def test_two_subscribers_receive_same_events_and_completion_sentinel():
    agent = FakeAgent({"final_response": "finished"})
    agent.block = True
    service = RunService(FakeHooks(agent))

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    first = service.subscribe(run_id, "conversation-a")
    second = service.subscribe(run_id, "conversation-a")
    assert first is not None and second is not None and first is not second

    agent.release.set()
    first_events, second_events = await asyncio.gather(
        _drain_until_sentinel(first),
        _drain_until_sentinel(second),
    )

    assert [event["event"] for event in first_events] == ["run.completed"]
    assert second_events == first_events


@pytest.mark.anyio
async def test_late_concurrent_subscribers_replay_exact_terminal_event_and_sentinel():
    service = RunService(FakeHooks(FakeAgent({"final_response": "finished"})))

    run_id = _start(service)
    await _wait_terminal(service, run_id)

    first = service.subscribe(run_id, "conversation-a")
    assert first is not None
    second = service.subscribe(run_id, "conversation-a")
    assert second is not None and second is not first

    first_events, second_events = await asyncio.gather(
        _drain_until_sentinel(first),
        _drain_until_sentinel(second),
    )

    assert [event["event"] for event in first_events] == ["run.completed"]
    assert second_events == first_events
    assert service._terminal_replays[run_id] == (first_events[0], None)

    service.unsubscribe(run_id, first)
    assert run_id in service._terminal_replays
    service.unsubscribe(run_id, second)
    assert run_id not in service._terminal_replays


@pytest.mark.anyio
async def test_orphan_sweep_removes_terminal_replay_metadata():
    hooks = FakeHooks(FakeAgent({"final_response": "finished"}))
    service = RunService(hooks, clock=lambda: 10.0)

    run_id = _start(service)
    await hooks.tracked[0]
    assert len(service._terminal_replays[run_id]) == 2

    service.sweep(now=20.0, stream_ttl=1.0, status_ttl=100.0)

    assert run_id not in service.streams
    assert run_id not in service._terminal_replays


@pytest.mark.parametrize("disconnect_index", [0, 1])
@pytest.mark.anyio
async def test_unsubscribe_removes_only_exact_queue_and_remaining_subscriber_completes(
    disconnect_index,
):
    agent = FakeAgent({"final_response": "finished"})
    agent.block = True
    service = RunService(FakeHooks(agent))

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    queues = [
        service.subscribe(run_id, "conversation-a"),
        service.subscribe(run_id, "conversation-a"),
    ]
    disconnected = queues[disconnect_index]
    remaining = queues[1 - disconnect_index]
    assert disconnected is not None and remaining is not None

    service.unsubscribe(run_id, disconnected)
    assert run_id in service.streams
    assert run_id in service.stream_subscribers

    agent.release.set()
    remaining_events = await _drain_until_sentinel(remaining)

    assert [event["event"] for event in remaining_events] == ["run.completed"]
    service.unsubscribe(run_id, remaining)
    assert run_id not in service.streams
    assert run_id not in service.stream_subscribers


@pytest.mark.anyio
async def test_active_final_unsubscribe_retains_backlog_for_reconnect_until_terminal_cleanup():
    agent = FakeAgent({"final_response": "finished"})
    agent.block = True
    service = RunService(FakeHooks(agent), queue_maxsize=3)

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    first = service.subscribe(run_id, "conversation-a")
    assert first is not None

    service.unsubscribe(run_id, first)
    assert run_id in service.streams
    assert run_id in service.streams_created
    assert run_id not in service.stream_subscribers

    stream_delta = service.hooks.created[-1]["stream_delta_callback"]
    stream_delta("after-disconnect")
    await asyncio.sleep(0)
    agent.release.set()
    await _wait_terminal(service, run_id)

    reconnected = service.subscribe(run_id, "conversation-a")
    assert reconnected is not None
    events = await _drain_until_sentinel(reconnected)
    assert [event["event"] for event in events] == [
        "message.delta",
        "run.completed",
    ]
    assert events[0]["delta"] == "after-disconnect"

    service.unsubscribe(run_id, reconnected)
    assert run_id not in service.streams
    assert run_id not in service.streams_created


@pytest.mark.anyio
async def test_bounded_backpressure_preserves_terminal_event_and_sentinel_for_all_queues():
    agent = FakeAgent({"final_response": "finished"})
    agent.block = True
    service = RunService(FakeHooks(agent), queue_maxsize=2)

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    canonical = service.subscribe(run_id, "conversation-a")
    subscriber = service.subscribe(run_id, "conversation-a")
    assert canonical is not None and subscriber is not None
    assert canonical.maxsize == subscriber.maxsize == 2

    stream_delta = service.hooks.created[-1]["stream_delta_callback"]
    for index in range(20):
        stream_delta(f"delta-{index}")
    await asyncio.sleep(0)
    assert canonical.qsize() <= canonical.maxsize
    assert subscriber.qsize() <= subscriber.maxsize

    agent.release.set()
    status = await _wait_terminal(service, run_id)
    assert status["status"] == "completed"
    assert await _drain_until_sentinel(canonical) == [
        service._terminal_replays[run_id][0]
    ]
    assert await _drain_until_sentinel(subscriber) == [
        service._terminal_replays[run_id][0]
    ]

    replay = service.subscribe(run_id, "conversation-a")
    assert replay is not None
    assert replay.maxsize == 2
    assert replay.qsize() <= replay.maxsize
    assert await _drain_until_sentinel(replay) == [
        service._terminal_replays[run_id][0]
    ]


@pytest.mark.parametrize(
    ("result", "expected_status"),
    [
        ({"final_response": "finished"}, "completed"),
        ({"failed": True, "error": "failed"}, "failed"),
    ],
)
@pytest.mark.anyio
async def test_delayed_callbacks_after_terminal_cannot_regress_or_displace_delivery(
    result, expected_status
):
    hooks = FakeHooks(FakeAgent(result))
    service = RunService(hooks, queue_maxsize=2)

    run_id = _start(service)
    terminal_status = await _wait_terminal(service, run_id)
    await hooks.tracked[0]
    queue = service.stream_for(run_id)
    assert queue is not None
    terminal_event = service._terminal_replays[run_id][0]
    text_callback = hooks.created[-1]["stream_delta_callback"]
    tool_callback = hooks.created[-1]["tool_progress_callback"]
    approval_callback = hooks.registered[-1][1]

    await asyncio.to_thread(text_callback, "late text")
    await asyncio.to_thread(
        tool_callback,
        "tool.started",
        tool_name="terminal",
        preview="late tool",
    )
    asyncio.get_running_loop().call_soon(
        approval_callback,
        {"command": "late approval", "allow_permanent": True},
    )
    assert service.publish_approval_response(
        run_id,
        expected_session_id="conversation-a",
        choice="once",
        resolved=1,
    ) is False
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert queue.qsize() == 2
    assert queue.get_nowait() == terminal_event
    assert queue.get_nowait() is None
    assert service.status(run_id) == terminal_status
    assert terminal_status["status"] == expected_status
    assert terminal_status["last_event"] == f"run.{expected_status}"


@pytest.mark.anyio
async def test_delayed_callbacks_after_cancellation_cannot_regress_or_displace_delivery():
    agent = FakeAgent()
    agent.block = True
    hooks = FakeHooks(agent)
    service = RunService(hooks, queue_maxsize=2)

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    text_callback = hooks.created[-1]["stream_delta_callback"]
    tool_callback = hooks.created[-1]["tool_progress_callback"]
    approval_callback = hooks.registered[-1][1]
    assert service.stop(run_id, "conversation-a") == {
        "run_id": run_id,
        "status": "stopping",
    }
    terminal_status = await _wait_terminal(service, run_id)
    await hooks.tracked[0]
    queue = service.stream_for(run_id)
    assert queue is not None
    terminal_event = service._terminal_replays[run_id][0]

    await asyncio.to_thread(text_callback, "late text")
    await asyncio.to_thread(
        tool_callback,
        "tool.started",
        tool_name="terminal",
        preview="late tool",
    )
    approval_callback({"command": "late approval", "allow_permanent": True})
    assert service.publish_approval_response(
        run_id,
        expected_session_id="conversation-a",
        choice="once",
        resolved=1,
    ) is False
    await asyncio.sleep(0)

    assert queue.qsize() == 2
    assert queue.get_nowait() == terminal_event
    assert queue.get_nowait() is None
    assert service.status(run_id) == terminal_status
    assert terminal_status["status"] == "cancelled"
    assert terminal_status["last_event"] == "run.cancelled"


@pytest.mark.anyio
async def test_text_producer_does_not_schedule_after_terminal(monkeypatch):
    hooks = FakeHooks(FakeAgent({"final_response": "finished"}))
    service = RunService(hooks, queue_maxsize=2)

    run_id = _start(service)
    await _wait_terminal(service, run_id)
    await hooks.tracked[0]
    text_callback = hooks.created[-1]["stream_delta_callback"]
    scheduled = []
    loop = asyncio.get_running_loop()
    original_call_soon_threadsafe = loop.call_soon_threadsafe

    def record_delivery(callback, *args):
        if callback == service._put_event_if_active:
            scheduled.append((callback, *args))
        return original_call_soon_threadsafe(callback, *args)

    monkeypatch.setattr(loop, "call_soon_threadsafe", record_delivery)

    text_callback("late text")
    await asyncio.sleep(0)

    assert scheduled == []


@pytest.mark.anyio
async def test_nonterminal_delivery_scheduled_before_terminal_drops_when_it_runs_late():
    service = RunService(FakeHooks(), queue_maxsize=2, clock=lambda: 42.0)
    run_id = "run_scheduled_late"
    queue = asyncio.Queue(maxsize=2)
    service.streams[run_id] = queue
    service.registry.set_status(
        run_id, "running", session_id="conversation-a"
    )
    late_event = {
        "event": "message.delta",
        "run_id": run_id,
        "timestamp": 41.0,
        "delta": "late",
    }

    asyncio.get_running_loop().call_soon(
        service._put_event_if_active, run_id, queue, late_event
    )
    service.registry.set_status(
        run_id, "completed", last_event="run.completed"
    )
    terminal_event = {
        "event": "run.completed",
        "run_id": run_id,
        "timestamp": 42.0,
        "output": "done",
        "usage": {},
    }
    service._put_event_if_active(run_id, queue, terminal_event)
    service._put_event_if_active(run_id, queue, None)
    await asyncio.sleep(0)

    assert queue.qsize() == 2
    assert queue.get_nowait() == terminal_event
    assert queue.get_nowait() is None


@pytest.mark.anyio
async def test_subscriber_limit_bounds_queue_count_after_ownership_check():
    agent = FakeAgent()
    agent.block = True
    service = RunService(FakeHooks(agent), queue_maxsize=2, max_subscribers=2)

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    first = service.subscribe(run_id, "conversation-a")
    second = service.subscribe(run_id, "conversation-a")
    assert first is not None and second is not None

    assert service.subscribe(run_id, "conversation-b") is None
    with pytest.raises(RunSubscriberLimitError):
        service.subscribe(run_id, "conversation-a")
    assert len(service.stream_subscriber_queues[run_id]) == 2
    assert all(queue.maxsize == 2 for queue in service.stream_subscriber_queues[run_id])

    agent.release.set()
    await _wait_terminal(service, run_id)


@pytest.mark.anyio
async def test_malformed_tool_progress_is_swallowed_and_run_completes_with_cleanup():
    def invoke(hooks):
        callback = hooks.created[-1]["tool_progress_callback"]
        callback("tool.completed", tool_name="terminal", duration=object())

    agent = CallbackAgent(invoke)
    hooks = FakeHooks(agent)
    agent.hooks = hooks
    service = RunService(hooks)

    run_id = _start(service)
    status = await _wait_terminal(service, run_id)

    assert status["status"] == "completed"
    assert status["output"] == "callback survived"
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None
    assert hooks.unregistered.count("approval-a") >= 1


@pytest.mark.anyio
async def test_raising_approval_redaction_is_swallowed_and_run_completes_with_cleanup():
    def invoke(hooks):
        approval_notify = hooks.registered[-1][1]
        approval_notify({"command": "secret", "allow_permanent": True})

    agent = CallbackAgent(invoke)
    hooks = FakeHooks(agent)
    agent.hooks = hooks

    def fail_redaction(value):
        raise RuntimeError("telemetry redaction failed")

    hooks.redact_approval_command = fail_redaction
    service = RunService(hooks)

    run_id = _start(service)
    status = await _wait_terminal(service, run_id)

    assert status["status"] == "completed"
    assert status["output"] == "callback survived"
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None
    assert hooks.unregistered.count("approval-a") >= 1


@pytest.mark.anyio
async def test_structured_failure_uses_injected_redaction_and_cleans_up():
    hooks = FakeHooks(FakeAgent({"failed": True, "error": "secret"}))
    service = RunService(hooks)

    run_id = _start(service)
    status = await _wait_terminal(service, run_id)

    assert status["status"] == "failed"
    assert status["error"] == "safe:str"
    assert status["last_event"] == "run.failed"
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None
    event = await service.stream_for(run_id).get()
    assert event["event"] == "run.failed"
    assert event["error"] == "safe:str"


@pytest.mark.anyio
async def test_exception_failure_is_redacted_and_cleans_up():
    hooks = FakeHooks(FakeAgent(error=RuntimeError("credential")))
    service = RunService(hooks)

    run_id = _start(service)
    status = await _wait_terminal(service, run_id)

    assert status["status"] == "failed"
    assert status["error"] == "safe:RuntimeError"
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None
    assert hooks.unregistered.count("approval-a") >= 1


@pytest.mark.anyio
async def test_stop_before_agent_creation_prevents_creation_and_cleans_up():
    hooks = FakeHooks()
    service = RunService(hooks)

    run_id = _start(service)
    assert service.stop(run_id) == {"run_id": run_id, "status": "stopping"}
    status = await _wait_terminal(service, run_id)

    assert status["status"] == "cancelled"
    assert hooks.created == []
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None


@pytest.mark.anyio
async def test_cooperative_stop_interrupts_once_and_finishes_cancelled():
    agent = FakeAgent()
    agent.block = True
    hooks = FakeHooks(agent)
    service = RunService(hooks)

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    assert service.stop(run_id) == {"run_id": run_id, "status": "stopping"}
    assert service.stop(run_id) == {"run_id": run_id, "status": "stopping"}
    status = await _wait_terminal(service, run_id)

    assert agent.interrupt_calls == ["Stop requested via API"]
    assert status["status"] == "cancelled"
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None


@pytest.mark.anyio
async def test_uncooperative_executor_remains_tracked_until_thread_exits():
    class UncooperativeAgent(FakeAgent):
        def interrupt(self, message):
            self.interrupt_calls.append(message)

    agent = UncooperativeAgent()
    agent.block = True
    hooks = FakeHooks(agent)
    service = RunService(hooks)

    run_id = _start(service)
    assert await asyncio.to_thread(agent.started.wait, 3)
    assert service.stop(run_id) == {"run_id": run_id, "status": "stopping"}
    await asyncio.sleep(0.05)

    assert service.status(run_id)["status"] == "stopping"
    assert service.registry.agent_for(run_id) is agent
    task = service.registry.task_for(run_id)
    assert task is not None and not task.done()

    agent.release.set()
    status = await _wait_terminal(service, run_id)
    assert status["status"] == "cancelled"
    assert service.registry.agent_for(run_id) is None
    assert service.registry.task_for(run_id) is None


def test_status_list_and_stop_hide_ownership_mismatch_like_missing():
    hooks = FakeHooks()
    service = RunService(hooks)
    service.registry.set_status("run-owned", "running", session_id="conversation-a")
    service.registry.register_agent("run-owned", hooks.agent)

    assert service.status("run-owned", "conversation-b") is None
    assert service.status("run-missing", "conversation-b") is None
    assert service.list("conversation-b") == []
    assert service.stop("run-owned", "conversation-b") is None
    assert service.stop("run-missing", "conversation-b") is None
    assert hooks.agent.interrupt_calls == []


@pytest.mark.anyio
async def test_stream_access_hides_ownership_mismatch_without_subscribing_or_draining():
    service = RunService(FakeHooks())
    queue = asyncio.Queue()
    queue.put_nowait({"event": "private"})
    service.streams["run-owned"] = queue
    service.registry.set_status(
        "run-owned", "completed", session_id="conversation-a"
    )
    terminal_event = {
        "event": "run.completed",
        "run_id": "run-owned",
        "timestamp": 42.0,
        "output": "private",
        "usage": {},
    }
    service._terminal_replays["run-owned"] = (terminal_event, None)

    assert service.stream_for("run-owned", "conversation-b") is None
    assert service.stream_for("run-missing", "conversation-b") is None
    assert service.subscribe("run-owned", "conversation-b") is None
    assert service.subscribe("run-missing", "conversation-b") is None
    assert service.stream_subscribers == set()
    assert "run-owned" not in service.stream_subscriber_queues
    assert service._terminal_replays["run-owned"] == (terminal_event, None)
    assert queue.qsize() == 1


@pytest.mark.anyio
async def test_approval_access_and_publication_hide_mismatch_without_mutation():
    service = RunService(FakeHooks(), clock=lambda: 42.0)
    queue = asyncio.Queue()
    service.streams["run-owned"] = queue
    service.approval_sessions["run-owned"] = "approval-a"
    service.registry.set_status(
        "run-owned",
        "waiting_for_approval",
        session_id="conversation-a",
        last_event="approval.request",
    )
    before = service.status("run-owned")

    assert service.approval_session_for("run-owned", "conversation-b") is None
    assert service.approval_session_for("run-missing", "conversation-b") is None
    assert service.publish_approval_response(
        "run-owned",
        expected_session_id="conversation-b",
        choice="once",
        resolved=1,
    ) is False
    assert service.publish_approval_response(
        "run-missing",
        expected_session_id="conversation-b",
        choice="once",
        resolved=1,
    ) is False
    assert service.status("run-owned") == before
    assert queue.empty()


@pytest.mark.anyio
async def test_publish_approval_response_updates_status_and_enqueues_event():
    hooks = FakeHooks()
    service = RunService(hooks, clock=lambda: 42.0)
    run_id = "run_approval"
    queue = asyncio.Queue()
    service.streams[run_id] = queue
    service.registry.set_status(
        run_id,
        "waiting_for_approval",
        session_id="conversation-a",
        last_event="approval.request",
    )

    assert service.publish_approval_response(
        run_id,
        expected_session_id="conversation-a",
        choice="session",
        resolved=2,
    ) is True

    status = service.status(run_id)
    assert status is not None
    assert status["status"] == "running"
    assert status["last_event"] == "approval.responded"
    assert await queue.get() == {
        "event": "approval.responded",
        "run_id": run_id,
        "timestamp": 42.0,
        "choice": "session",
        "resolved": 2,
    }


@pytest.mark.anyio
async def test_publish_approval_response_rejects_terminal_without_mutation_or_event():
    service = RunService(FakeHooks(), clock=lambda: 42.0)
    run_id = "run_terminal_approval"
    queue = asyncio.Queue(maxsize=2)
    terminal_event = {
        "event": "run.completed",
        "run_id": run_id,
        "timestamp": 41.0,
        "output": "done",
        "usage": {},
    }
    queue.put_nowait(terminal_event)
    queue.put_nowait(None)
    service.streams[run_id] = queue
    service.registry.set_status(
        run_id,
        "completed",
        session_id="conversation-a",
        output="done",
        last_event="run.completed",
    )
    before = service.status(run_id)

    assert service.publish_approval_response(
        run_id,
        expected_session_id="conversation-a",
        choice="once",
        resolved=1,
    ) is False
    assert service.status(run_id) == before
    assert queue.qsize() == 2
    assert queue.get_nowait() == terminal_event
    assert queue.get_nowait() is None
