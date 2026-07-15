import asyncio
import concurrent.futures
import inspect
import threading

import pytest

import gateway.run_service_runtime as runtime_module
from gateway.run_service import RunService
from gateway.run_service_runtime import (
    RunServiceRuntime,
    RunServiceRuntimeClosed,
    RunServiceRuntimeShutdownError,
    RunServiceRuntimeStartupError,
)


class _CompletedAgent:
    session_prompt_tokens = 1
    session_completion_tokens = 2
    session_total_tokens = 3

    def run_conversation(self, **_kwargs):
        return {"final_response": "runtime completed"}


class _BlockingAgent:
    session_prompt_tokens = 1
    session_completion_tokens = 2
    session_total_tokens = 3

    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.exited = threading.Event()

    def run_conversation(self, **_kwargs):
        self.started.set()
        self.release.wait()
        self.exited.set()
        return {"final_response": "released"}


class _RunHooks:
    def __init__(self, agent=None):
        self.agent = agent or _CompletedAgent()
        self.tracked = []

    def create_agent(self, **_kwargs):
        return self.agent

    def bind_session(self, session_key):
        return []

    def clear_session(self, tokens):
        return None

    def activate_admitted_request(self):
        return None

    def register_approval_notify(self, session_key, callback):
        return None

    def unregister_approval_notify(self, session_key):
        return None

    def set_approval_session(self, session_key):
        return None

    def reset_approval_session(self, token):
        return None

    def redact_error(self, value):
        return f"safe:{type(value).__name__}"

    def redact_approval_command(self, value):
        return str(value)

    def interrupt_agent(self, agent):
        return None

    def track_task(self, task):
        self.tracked.append(task)


def test_reuses_one_daemon_loop_after_submission_returns():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    child_finished = threading.Event()

    async def thread_identity():
        return threading.get_ident()

    async def launch_child():
        async def child():
            await asyncio.sleep(0)
            child_finished.set()

        asyncio.create_task(child())

    try:
        first_thread = runtime.submit(thread_identity()).result(timeout=1.0)
        runtime.submit(launch_child()).result(timeout=1.0)
        second_thread = runtime.submit(thread_identity()).result(timeout=1.0)

        assert first_thread == second_thread == runtime.thread_id
        assert runtime.is_daemon
        assert child_finished.wait(timeout=1.0)
        assert runtime.is_alive
    finally:
        runtime.shutdown(timeout=1.0)


def test_startup_returns_only_after_loop_is_running_and_accepting_submissions(
    monkeypatch,
):
    entered_run_forever = threading.Event()
    release_run_forever = threading.Event()
    constructor_returned = threading.Event()
    holder = {}
    real_new_event_loop = asyncio.new_event_loop

    def delayed_new_event_loop():
        loop = real_new_event_loop()
        real_run_forever = loop.run_forever

        def delayed_run_forever():
            entered_run_forever.set()
            release_run_forever.wait()
            real_run_forever()

        loop.run_forever = delayed_run_forever
        return loop

    def construct_runtime():
        holder["runtime"] = RunServiceRuntime(startup_timeout=1.0)
        constructor_returned.set()

    monkeypatch.setattr(runtime_module.asyncio, "new_event_loop", delayed_new_event_loop)
    constructor_thread = threading.Thread(target=construct_runtime)
    constructor_thread.start()
    assert entered_run_forever.wait(timeout=1.0)

    try:
        assert not constructor_returned.wait(timeout=0.05)
        release_run_forever.set()
        assert constructor_returned.wait(timeout=1.0)

        async def immediate():
            return "accepted"

        assert holder["runtime"].submit(immediate()).result(timeout=1.0) == "accepted"
    finally:
        release_run_forever.set()
        constructor_thread.join(timeout=1.0)
        if "runtime" in holder:
            holder["runtime"].shutdown(timeout=1.0)


def test_submit_after_shutdown_fails_closed_without_leaking_coroutine():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    runtime.shutdown(timeout=1.0)

    async def rejected():
        return "unreachable"

    coro = rejected()
    with pytest.raises(RunServiceRuntimeClosed):
        runtime.submit(coro)

    assert inspect.getcoroutinestate(coro) == inspect.CORO_CLOSED


def test_unexpected_loop_exit_fails_closed_and_keeps_atexit_idempotent(monkeypatch):
    registered = []
    monkeypatch.setattr(runtime_module.atexit, "register", registered.append)
    runtime = RunServiceRuntime(startup_timeout=1.0)

    async def stop_owner_loop():
        asyncio.get_running_loop().stop()

    runtime.submit(stop_owner_loop()).result(timeout=1.0)
    for _ in range(1000):
        if not runtime.is_alive:
            break
        threading.Event().wait(0.001)
    assert not runtime.is_alive

    async def rejected():
        return "unreachable"

    coro = rejected()
    try:
        with pytest.raises(RunServiceRuntimeClosed):
            runtime.submit(coro)
        assert inspect.getcoroutinestate(coro) == inspect.CORO_CLOSED
        registered[0]()
    finally:
        if inspect.getcoroutinestate(coro) != inspect.CORO_CLOSED:
            coro.close()


def test_submission_accepted_during_unexpected_stop_is_cancelled_and_closed():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    stop_requested = threading.Event()
    release_owner = threading.Event()

    async def stop_and_hold_owner_loop():
        loop = asyncio.get_running_loop()
        loop.call_soon(loop.stop)
        loop.stop()
        stop_requested.set()
        release_owner.wait()

    async def accepted_during_stop():
        await asyncio.Event().wait()

    stopping_future = runtime.submit(stop_and_hold_owner_loop())
    assert stop_requested.wait(timeout=1.0)
    coro = accepted_during_stop()
    accepted_future = runtime.submit(coro)

    release_owner.set()
    stopping_future.result(timeout=1.0)
    with pytest.raises(concurrent.futures.CancelledError):
        accepted_future.result(timeout=1.0)

    runtime.shutdown(timeout=1.0)
    assert inspect.getcoroutinestate(coro) == inspect.CORO_CLOSED
    assert not runtime.is_alive


def test_startup_is_bounded_and_raises_typed_failure(monkeypatch):
    monkeypatch.setattr(threading.Thread, "start", lambda self: None)

    with pytest.raises(RunServiceRuntimeStartupError):
        RunServiceRuntime(startup_timeout=0.0)


def test_loop_starting_after_timeout_exits_without_orphaning_thread(monkeypatch):
    entered_loop_factory = threading.Event()
    release_loop_factory = threading.Event()
    created_threads = []
    created_loops = []
    runtime_owners = []
    real_new_event_loop = asyncio.new_event_loop
    real_thread = threading.Thread

    def delayed_new_event_loop():
        entered_loop_factory.set()
        release_loop_factory.wait()
        loop = real_new_event_loop()
        created_loops.append(loop)
        return loop

    def capture_thread(*args, **kwargs):
        runtime_owners.append(kwargs["target"].__self__)
        thread = real_thread(*args, **kwargs)
        created_threads.append(thread)
        return thread

    monkeypatch.setattr(runtime_module.asyncio, "new_event_loop", delayed_new_event_loop)
    monkeypatch.setattr(runtime_module.threading, "Thread", capture_thread)

    with pytest.raises(RunServiceRuntimeStartupError):
        RunServiceRuntime(startup_timeout=0.0)
    assert entered_loop_factory.wait(timeout=1.0)

    release_loop_factory.set()
    created_threads[0].join(timeout=1.0)
    try:
        assert not created_threads[0].is_alive()
        assert runtime_owners[0]._loop is None
    finally:
        if created_threads[0].is_alive():
            created_loops[0].call_soon_threadsafe(created_loops[0].stop)
            created_threads[0].join(timeout=1.0)


def test_registers_orderly_process_shutdown(monkeypatch):
    registered = []
    started = threading.Event()
    cleaned = threading.Event()
    monkeypatch.setattr(runtime_module.atexit, "register", registered.append)
    runtime = RunServiceRuntime(startup_timeout=1.0)

    async def pending_work():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    runtime.submit(pending_work())
    assert started.wait(timeout=1.0)
    assert len(registered) == 1

    registered[0]()

    assert cleaned.is_set()
    assert not runtime.is_alive


def test_owner_loop_shutdown_is_typed_rejection_and_runtime_remains_usable():
    runtime = RunServiceRuntime(startup_timeout=1.0)

    async def attempt_owner_shutdown():
        with pytest.raises(RunServiceRuntimeShutdownError):
            runtime.shutdown(timeout=1.0)
        return runtime.is_alive

    async def immediate():
        return "still running"

    try:
        assert runtime.submit(attempt_owner_shutdown()).result(timeout=1.0)
        assert runtime.submit(immediate()).result(timeout=1.0) == "still running"
    finally:
        runtime.shutdown(timeout=1.0)


def test_shutdown_timeout_is_typed_and_later_join_remains_possible():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    blocker_started = threading.Event()
    release_blocker = threading.Event()

    async def block_owner_thread():
        blocker_started.set()
        release_blocker.wait()

    future = runtime.submit(block_owner_thread())
    assert blocker_started.wait(timeout=1.0)

    with pytest.raises(RunServiceRuntimeShutdownError):
        runtime.shutdown(timeout=0.0)

    release_blocker.set()
    runtime.shutdown(timeout=1.0)
    assert not runtime.is_alive
    future.result(timeout=1.0)


def test_submit_is_thread_safe_and_uses_the_owner_loop():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    worker_count = 8
    barrier = threading.Barrier(worker_count + 1)
    results: list[tuple[int, int] | None] = [None] * worker_count

    async def identify(value):
        return value, threading.get_ident()

    def worker(index):
        barrier.wait()
        results[index] = runtime.submit(identify(index)).result(timeout=1.0)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(worker_count)]
    try:
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join(timeout=1.0)

        assert all(not thread.is_alive() for thread in threads)
        completed = [result for result in results if result is not None]
        assert len(completed) == worker_count
        assert sorted(value for value, _thread_id in completed) == list(range(worker_count))
        assert {thread_id for _value, thread_id in completed} == {runtime.thread_id}
    finally:
        runtime.shutdown(timeout=1.0)


def test_submit_future_preserves_original_exception_type():
    runtime = RunServiceRuntime(startup_timeout=1.0)

    class WorkerFailure(LookupError):
        pass

    async def fail():
        raise WorkerFailure("typed failure")

    try:
        with pytest.raises(WorkerFailure, match="typed failure"):
            runtime.submit(fail()).result(timeout=1.0)
        assert runtime.is_alive
    finally:
        runtime.shutdown(timeout=1.0)


def test_shutdown_cancels_pending_work_and_waits_for_cleanup():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    started = threading.Event()
    cleaned = threading.Event()

    async def linger():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cleaned.set()

    future = runtime.submit(linger())
    assert started.wait(timeout=1.0)

    runtime.shutdown(timeout=1.0)

    assert cleaned.is_set()
    assert not runtime.is_alive
    with pytest.raises(concurrent.futures.CancelledError):
        future.result(timeout=1.0)


def test_shutdown_drains_tasks_spawned_during_cancellation_cleanup():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    parent_started = threading.Event()
    child_started = threading.Event()
    child_cleaned = threading.Event()

    async def child():
        child_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            child_cleaned.set()

    async def parent():
        parent_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            asyncio.create_task(child())

    runtime.submit(parent())
    assert parent_started.wait(timeout=1.0)

    runtime.shutdown(timeout=1.0)

    assert child_started.is_set()
    assert child_cleaned.is_set()
    assert not runtime.is_alive


def test_shutdown_drains_tasks_and_nested_async_generators_from_finalizers():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    retained_generators = []
    child_started = threading.Event()
    child_cleaned = threading.Event()
    nested_generator_cleaned = threading.Event()

    async def nested_generator():
        try:
            yield "nested open"
        finally:
            nested_generator_cleaned.set()

    async def child():
        nested = nested_generator()
        assert await anext(nested) == "nested open"
        retained_generators.append(nested)
        child_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            child_cleaned.set()

    async def generator():
        try:
            yield "open"
        finally:
            asyncio.create_task(child())

    async def leave_generator_open():
        async_generator = generator()
        assert await anext(async_generator) == "open"
        retained_generators.append(async_generator)

    runtime.submit(leave_generator_open()).result(timeout=1.0)

    runtime.shutdown(timeout=1.0)

    assert child_started.is_set()
    assert child_cleaned.is_set()
    assert nested_generator_cleaned.is_set()
    assert not runtime.is_alive


def test_shutdown_waits_for_real_run_service_executor_work():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    agent = _BlockingAgent()
    hooks = _RunHooks(agent)

    async def start_run():
        service = RunService(hooks)
        service.start(
            user_message="hello",
            conversation_history=[],
            session_id="conversation-a",
            model="test-model",
        )

    runtime.submit(start_run()).result(timeout=1.0)
    assert agent.started.wait(timeout=1.0)

    try:
        with pytest.raises(RunServiceRuntimeShutdownError):
            runtime.shutdown(timeout=0.01)
        assert not agent.exited.is_set()
    finally:
        agent.release.set()
        runtime.shutdown(timeout=1.0)

    assert agent.exited.is_set()
    assert not runtime.is_alive


def test_run_service_reaches_terminal_state_after_start_submission_returns():
    runtime = RunServiceRuntime(startup_timeout=1.0)
    hooks = _RunHooks()

    async def start_run():
        service = RunService(hooks)
        run_id = service.start(
            user_message="hello",
            conversation_history=[],
            session_id="conversation-a",
            model="test-model",
            approval_session_key="approval-a",
        )
        return service, run_id, service.stream_for(run_id)

    async def await_terminal(queue):
        events = []
        while True:
            event = await queue.get()
            if event is None:
                return events
            events.append(event)

    try:
        service, run_id, queue = runtime.submit(start_run()).result(timeout=1.0)
        assert queue is not None

        events = runtime.submit(await_terminal(queue)).result(timeout=1.0)
        status = service.status(run_id)

        assert status is not None
        assert status["status"] == "completed"
        assert status["output"] == "runtime completed"
        assert events[-1]["event"] == "run.completed"
        assert service.registry.agent_for(run_id) is None
        assert service.registry.task_for(run_id) is None
    finally:
        runtime.shutdown(timeout=1.0)
