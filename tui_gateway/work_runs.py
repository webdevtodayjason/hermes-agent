"""Thin synchronous work RPC facade over the canonical RunService runtime."""

from __future__ import annotations

import asyncio
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable

from gateway.run_service import RunService
from gateway.run_service_runtime import RunServiceRuntime


class WorkRunNotFound(LookupError):
    """Ownership-safe missing-run result for status and stop."""


_RUN_ID_RE = re.compile(r"^run_[0-9a-f]{32}$")
_SWEEP_INTERVAL_SECONDS = 60
_STREAM_TTL_SECONDS = 300
_STATUS_TTL_SECONDS = 3600


def is_valid_run_id(value: Any) -> bool:
    return isinstance(value, str) and _RUN_ID_RE.fullmatch(value) is not None


class WorkRuns:
    """Synchronously expose RunService operations on its process-lifetime loop."""

    def __init__(
        self,
        *,
        service: RunService,
        runtime: RunServiceRuntime,
        model: str,
        timeout: float = 30.0,
    ):
        self.service = service
        self.runtime = runtime
        self.model = model
        self.timeout = timeout
        self._sweeper_future = None

    def _call(self, coroutine):
        return self.runtime.submit(coroutine).result(timeout=self.timeout)

    def start(self, *, session_id: str, user_input: str, history: list[dict]) -> dict:
        async def invoke() -> dict:
            run_id = self.service.start(
                user_message=user_input,
                conversation_history=history,
                session_id=session_id,
                model=self.model,
                gateway_session_key=session_id,
            )
            status = self.service.status(run_id, session_id)
            if status is None:
                raise WorkRunNotFound("run not found")
            return status

        return self._call(invoke())

    def recover(self, *, session_id: str) -> dict:
        async def invoke() -> dict:
            return {"data": self.service.list(session_id)}

        return self._call(invoke())

    def status(self, *, session_id: str, run_id: str) -> dict:
        async def invoke() -> dict:
            status = self.service.status(run_id, session_id)
            if status is None:
                raise WorkRunNotFound("run not found")
            return status

        return self._call(invoke())

    def stop(self, *, session_id: str, run_id: str) -> dict:
        async def invoke() -> dict:
            status = self.service.stop(run_id, session_id)
            if status is None:
                raise WorkRunNotFound("run not found")
            return status

        return self._call(invoke())

    def sweep(self, *, now: float | None = None) -> None:
        async def invoke() -> None:
            self.service.sweep(
                time.time() if now is None else now,
                stream_ttl=_STREAM_TTL_SECONDS,
                status_ttl=_STATUS_TTL_SECONDS,
            )

        self._call(invoke())

    async def _sweep_forever(self) -> None:
        while True:
            await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)
            self.service.sweep(
                time.time(),
                stream_ttl=_STREAM_TTL_SECONDS,
                status_ttl=_STATUS_TTL_SECONDS,
            )

    def start_sweeper(self) -> None:
        if self._sweeper_future is None:
            self._sweeper_future = self.runtime.submit(self._sweep_forever())


class _TUIRunExecutionHooks:
    def __init__(self, profile_home: Path, agent_factory: Callable[..., Any]):
        self.profile_home = profile_home
        self.agent_factory = agent_factory
        self._tasks: set[Any] = set()

    def create_agent(self, **kwargs: Any) -> Any:
        from hermes_constants import (
            reset_hermes_home_override,
            set_hermes_home_override,
        )

        session_id = str(kwargs.get("session_id") or "")
        token = set_hermes_home_override(self.profile_home)
        try:
            return self.agent_factory(
                sid=f"work:{session_id}",
                key=session_id,
                session_id=session_id,
            )
        finally:
            reset_hermes_home_override(token)

    def bind_session(self, session_key: str) -> list[Any]:
        from hermes_constants import set_hermes_home_override
        from gateway.session_context import set_session_vars

        home_token = set_hermes_home_override(self.profile_home)
        try:
            session_tokens = set_session_vars(
                platform="tui",
                source="tui_gateway",
                session_key=session_key,
                session_id=session_key,
                async_delivery=True,
            )
        except BaseException:
            from hermes_constants import reset_hermes_home_override

            reset_hermes_home_override(home_token)
            raise
        return [session_tokens, home_token]

    @staticmethod
    def clear_session(tokens: list[Any]) -> None:
        from hermes_constants import reset_hermes_home_override
        from gateway.session_context import clear_session_vars

        session_tokens, home_token = tokens
        try:
            clear_session_vars(session_tokens)
        finally:
            reset_hermes_home_override(home_token)

    @staticmethod
    def activate_admitted_request() -> None:
        return None

    @staticmethod
    def register_approval_notify(session_key: str, callback: Any) -> None:
        from tools.approval import register_gateway_notify

        register_gateway_notify(session_key, callback)

    @staticmethod
    def unregister_approval_notify(session_key: str) -> None:
        from tools.approval import unregister_gateway_notify

        unregister_gateway_notify(session_key)

    @staticmethod
    def set_approval_session(session_key: str) -> Any:
        from tools.approval import set_current_session_key

        return set_current_session_key(session_key)

    @staticmethod
    def reset_approval_session(token: Any) -> None:
        from tools.approval import reset_current_session_key

        reset_current_session_key(token)

    @staticmethod
    def redact_error(value: Any) -> str:
        return "Run failed"

    @staticmethod
    def redact_approval_command(value: Any) -> str:
        from gateway.run import _redact_approval_command

        return _redact_approval_command(value)

    @staticmethod
    def interrupt_agent(agent: Any) -> None:
        agent.interrupt("Stop requested via work RPC")

    def track_task(self, task: Any) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)


_instances: dict[Path, WorkRuns] = {}
_instances_lock = threading.Lock()


def get_work_runs(
    profile_home: Path,
    *,
    agent_factory: Callable[..., Any] | None = None,
    model: str = "configured",
) -> WorkRuns:
    """Return one canonical work composition for a resolved profile boundary."""
    profile_home = profile_home.resolve()
    with _instances_lock:
        existing = _instances.get(profile_home)
        if existing is not None:
            return existing

        if agent_factory is None:
            # Late import avoids a module cycle while keeping agent construction
            # in the TUI composition root rather than duplicating provider policy.
            from tui_gateway.server import _make_agent

            agent_factory = _make_agent

        runtime = RunServiceRuntime()
        service = RunService(_TUIRunExecutionHooks(profile_home, agent_factory))
        instance = WorkRuns(
            service=service,
            runtime=runtime,
            model=model,
        )
        instance.start_sweeper()
        _instances[profile_home] = instance
        return instance
