"""Transport-neutral retained state and execution lifecycle for API runs.

This module is deliberately transport-agnostic.  HTTP parsing and response
translation remain in the API server adapter.
"""

from collections.abc import MutableMapping, MutableSet
from dataclasses import dataclass
import asyncio
import logging
import math
import threading
import time
import uuid
from typing import Any, Callable, Dict, Iterator, List, Optional, Protocol


logger = logging.getLogger(__name__)


PUBLIC_RUN_STATUS_FIELDS = frozenset(
    {
        "object",
        "run_id",
        "status",
        "session_id",
        "model",
        "created_at",
        "updated_at",
        "last_event",
        "output",
        "usage",
        "error",
    }
)
TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled"})
TERMINAL_RUN_EVENTS = frozenset(
    {"run.completed", "run.failed", "run.cancelled"}
)
ACTIVE_RUN_STATUSES = frozenset({"queued", "running", "waiting_for_approval"})
RUN_STATUSES = ACTIVE_RUN_STATUSES | TERMINAL_RUN_STATUSES | {"stopping"}
DEFAULT_RUN_QUEUE_MAXSIZE = 256
DEFAULT_RUN_MAX_SUBSCRIBERS = 16


class RunSubscriberLimitError(RuntimeError):
    """Raised when an authorized run already has its maximum SSE subscribers."""


def _finite_timestamp(value: Any) -> float:
    try:
        timestamp = float(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return timestamp if math.isfinite(timestamp) else 0.0


def _validate_run_status(status: Any) -> None:
    if type(status) is not str or status not in RUN_STATUSES:
        raise ValueError(f"unsupported run status: {status!r}")


def _snapshot_status_value(value: Any) -> Any:
    """Copy JSON-shaped status data without invoking user-defined hooks."""
    value_type = type(value)
    if value_type is float:
        if not math.isfinite(value):
            raise ValueError("run status float values must be finite")
        return value
    if value is None or value_type in (bool, int, str):
        return value
    if value_type is list:
        return [_snapshot_status_value(item) for item in value]
    if value_type is tuple:
        return tuple(_snapshot_status_value(item) for item in value)
    if value_type is dict:
        snapshot = {}
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError("run status mappings must use string keys")
            snapshot[key] = _snapshot_status_value(item)
        return snapshot
    raise TypeError(
        "run status values must be JSON-compatible builtin data, "
        f"not {value_type.__name__}"
    )


def _snapshot_status_record(value: Any) -> Dict[str, Any]:
    if type(value) is not dict:
        raise TypeError("run status records must be builtin dictionaries")
    snapshot = {}
    for key, item in value.items():
        if type(key) is not str:
            raise TypeError("run status mappings must use string keys")
        if key in {"created_at", "updated_at"}:
            snapshot[key] = _finite_timestamp(item)
        else:
            snapshot[key] = _snapshot_status_value(item)
    _validate_run_status(snapshot.get("status"))
    return snapshot


@dataclass(frozen=True)
class StopTarget:
    """Control references claimed for one stop decision."""

    agent: Any
    task: Any
    owns_lease: bool = True


class _LockedMapping(MutableMapping):
    """Minimal lock-aware compatibility view over an authoritative dict."""

    def __init__(
        self,
        data: Dict[Any, Any],
        lock: threading.RLock,
        *,
        snapshotter: Optional[Callable[[Any], Any]] = None,
        mutation_allowed: Optional[Callable[[Any], bool]] = None,
    ):
        self._data = data
        self._lock = lock
        self._snapshotter = snapshotter
        self._mutation_allowed = mutation_allowed

    def _snapshot(self, value: Any) -> Any:
        if self._snapshotter is not None:
            return self._snapshotter(value)
        return value

    def __getitem__(self, key: Any) -> Any:
        with self._lock:
            return self._snapshot(self._data[key])

    def __setitem__(self, key: Any, value: Any) -> None:
        snapshot = self._snapshot(value)
        with self._lock:
            self._ensure_mutation_allowed(key)
            self._data[key] = snapshot

    def __delitem__(self, key: Any) -> None:
        with self._lock:
            self._ensure_mutation_allowed(key)
            del self._data[key]

    def _ensure_mutation_allowed(self, key: Any) -> None:
        if self._mutation_allowed is not None and not self._mutation_allowed(key):
            raise RuntimeError("run control mutation rejected while stop is pending")

    def __iter__(self) -> Iterator[Any]:
        with self._lock:
            return iter(tuple(self._data))

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)


class _LockedSet(MutableSet):
    """Minimal lock-aware compatibility view over an authoritative set."""

    def __init__(
        self,
        data: set[Any],
        lock: threading.RLock,
        *,
        mutation_allowed: Optional[Callable[[Any], bool]] = None,
    ):
        self._data = data
        self._lock = lock
        self._mutation_allowed = mutation_allowed

    def __contains__(self, value: object) -> bool:
        with self._lock:
            return value in self._data

    def __iter__(self) -> Iterator[Any]:
        with self._lock:
            return iter(tuple(self._data))

    def __len__(self) -> int:
        with self._lock:
            return len(self._data)

    def add(self, value: Any) -> None:
        with self._lock:
            self._ensure_mutation_allowed(value)
            self._data.add(value)

    def discard(self, value: Any) -> None:
        with self._lock:
            self._ensure_mutation_allowed(value)
            self._data.discard(value)

    def _ensure_mutation_allowed(self, value: Any) -> None:
        if self._mutation_allowed is not None and not self._mutation_allowed(value):
            raise RuntimeError("run control mutation rejected while stop is pending")


class RunRegistry:
    """Own retained run statuses and active stop-control references."""

    def __init__(self, *, clock: Callable[[], Any] = time.time):
        self._clock = clock
        self._lock = threading.RLock()
        self._statuses: Dict[str, Dict[str, Any]] = {}
        self._agents: Dict[str, Any] = {}
        self._tasks: Dict[str, Any] = {}
        self._stopping_ids: set[str] = set()
        self._claimed_stop_ids: set[str] = set()
        self._deferred_control_removals: set[str] = set()
        self._status_view = _LockedMapping(
            self._statuses,
            self._lock,
            snapshotter=_snapshot_status_record,
            mutation_allowed=self._compat_mutation_allowed,
        )
        self._agent_view = _LockedMapping(
            self._agents,
            self._lock,
            mutation_allowed=self._compat_mutation_allowed,
        )
        self._task_view = _LockedMapping(
            self._tasks,
            self._lock,
            mutation_allowed=self._compat_mutation_allowed,
        )
        self._stopping_view = _LockedSet(
            self._stopping_ids,
            self._lock,
            mutation_allowed=self._compat_mutation_allowed,
        )

    def _compat_mutation_allowed(self, run_id: Any) -> bool:
        return (
            run_id not in self._claimed_stop_ids
            and run_id not in self._stopping_ids
        )

    @property
    def statuses(self) -> MutableMapping:
        """Authoritative status map, exposed only for legacy compatibility."""
        return self._status_view

    @property
    def agents(self) -> MutableMapping:
        """Authoritative agent map, exposed only for legacy compatibility."""
        return self._agent_view

    @property
    def tasks(self) -> MutableMapping:
        """Authoritative task map, exposed only for legacy compatibility."""
        return self._task_view

    @property
    def stopping_ids(self) -> MutableSet:
        """Authoritative stopping set, exposed only for legacy compatibility."""
        return self._stopping_view

    def _replace_mapping(
        self,
        target: Dict[Any, Any],
        values: Dict[Any, Any],
        *,
        snapshotter: Optional[Callable[[Any], Any]] = None,
    ) -> None:
        if type(values) is not dict:
            raise TypeError("run compatibility maps must be builtin dictionaries")
        replacement = {
            key: snapshotter(value) if snapshotter is not None else value
            for key, value in values.items()
        }
        with self._lock:
            for run_id in set(target) | set(replacement):
                if not self._compat_mutation_allowed(run_id):
                    raise RuntimeError(
                        "run control mutation rejected while stop is pending"
                    )
            target.clear()
            target.update(replacement)

    def replace_statuses(self, values: Dict[str, Dict[str, Any]]) -> None:
        self._replace_mapping(
            self._statuses,
            values,
            snapshotter=_snapshot_status_record,
        )

    def replace_agents(self, values: Dict[str, Any]) -> None:
        self._replace_mapping(self._agents, values)

    def replace_tasks(self, values: Dict[str, Any]) -> None:
        self._replace_mapping(self._tasks, values)

    def replace_stopping_ids(self, values: set[str]) -> None:
        if type(values) is not set:
            raise TypeError("run compatibility stopping IDs must be a builtin set")
        replacement = set(values)
        with self._lock:
            for run_id in self._stopping_ids | replacement:
                if not self._compat_mutation_allowed(run_id):
                    raise RuntimeError(
                        "run control mutation rejected while stop is pending"
                    )
            self._stopping_ids.clear()
            self._stopping_ids.update(replacement)

    @staticmethod
    def finite_timestamp(value: Any) -> float:
        return _finite_timestamp(value)

    @classmethod
    def public_status(cls, status: Dict[str, Any]) -> Dict[str, Any]:
        public = {}
        for key, value in status.items():
            if key not in PUBLIC_RUN_STATUS_FIELDS:
                continue
            if key in {"created_at", "updated_at"}:
                public[key] = cls.finite_timestamp(value)
            else:
                public[key] = _snapshot_status_value(value)
        return public

    def _set_status_locked(
        self,
        run_id: str,
        status: str,
        fields: Dict[str, Any],
        *,
        now: float,
    ) -> Dict[str, Any]:
        incoming = dict(fields)
        created_at = incoming.pop("created_at", now)
        current = self._statuses.get(run_id, {})
        if (
            (
                run_id in self._claimed_stop_ids
                or run_id in self._stopping_ids
            )
            and "session_id" in incoming
            and incoming["session_id"] != current.get("session_id")
        ):
            raise RuntimeError(
                "run ownership mutation rejected while stop is pending"
            )
        candidate = dict(current)
        candidate.update(
            {
                "object": "hermes.run",
                "run_id": run_id,
                "status": status,
                "updated_at": now,
            }
        )
        candidate.setdefault(
            "created_at",
            created_at,
        )
        candidate.update(incoming)
        public = self.public_status(candidate)
        self._statuses[run_id] = candidate
        return public

    def set_status(self, run_id: str, status: str, **fields: Any) -> Dict[str, Any]:
        _validate_run_status(status)
        now = self.finite_timestamp(self._clock())
        for field in ("created_at", "updated_at"):
            if field in fields:
                fields[field] = self.finite_timestamp(fields[field])
        incoming = _snapshot_status_value(fields)
        with self._lock:
            return self._set_status_locked(
                run_id,
                status,
                incoming,
                now=now,
            )

    def set_status_if_active(
        self,
        run_id: str,
        status: Optional[str] = None,
        *,
        expected_session_id: Optional[str] = None,
        **fields: Any,
    ) -> Optional[Dict[str, Any]]:
        """Update an active run without crossing a stop or terminal fence."""
        if status is not None:
            _validate_run_status(status)
        now = self.finite_timestamp(self._clock())
        for field in ("created_at", "updated_at"):
            if field in fields:
                fields[field] = self.finite_timestamp(fields[field])
        incoming = _snapshot_status_value(fields)
        with self._lock:
            current = self._statuses.get(run_id)
            if (
                current is None
                or current.get("status") not in ACTIVE_RUN_STATUSES
                or run_id in self._stopping_ids
                or run_id in self._claimed_stop_ids
                or (
                    expected_session_id is not None
                    and current.get("session_id") != expected_session_id
                )
            ):
                return None
            return self._set_status_locked(
                run_id,
                status or str(current["status"]),
                incoming,
                now=now,
            )

    def is_active(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> bool:
        """Return whether nonterminal publication is still accepted."""
        with self._lock:
            current = self._statuses.get(run_id)
            return bool(
                current is not None
                and current.get("status") in ACTIVE_RUN_STATUSES
                and run_id not in self._stopping_ids
                and run_id not in self._claimed_stop_ids
                and (
                    expected_session_id is None
                    or current.get("session_id") == expected_session_id
                )
            )

    def get(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        with self._lock:
            status = self._statuses.get(run_id)
            if status is None or (
                expected_session_id is not None
                and status.get("session_id") != expected_session_id
            ):
                return None
            return self.public_status(status)

    def contains(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._statuses

    def status_value(self, run_id: str, field: str, default: Any = None) -> Any:
        with self._lock:
            return _snapshot_status_value(
                self._statuses.get(run_id, {}).get(field, default)
            )

    def list_for_session(
        self, session_id: str, *, limit: int = 100
    ) -> list[Dict[str, Any]]:
        with self._lock:
            bounded_limit = max(0, min(limit, 100))
            statuses = [
                status
                for status in self._statuses.values()
                if status.get("session_id") == session_id
            ]
            statuses.sort(
                key=lambda status: self.finite_timestamp(
                    status.get("created_at", 0)
                ),
                reverse=True,
            )
            return [
                self.public_status(status)
                for status in statuses[:bounded_limit]
            ]


    def active_status_count(self) -> int:
        with self._lock:
            return sum(
                status.get("status") in ACTIVE_RUN_STATUSES
                for status in self._statuses.values()
            )

    def expire_terminal_statuses(self, now: float, ttl: float) -> None:
        with self._lock:
            stale = [
                run_id
                for run_id, status in self._statuses.items()
                if status.get("status") in TERMINAL_RUN_STATUSES
                and now - self.finite_timestamp(status.get("updated_at", 0)) > ttl
            ]
            for run_id in stale:
                self._statuses.pop(run_id, None)

    def register_agent(self, run_id: str, agent: Any) -> bool:
        with self._lock:
            if run_id in self._stopping_ids or run_id in self._claimed_stop_ids:
                return False
            self._agents[run_id] = agent
            return True

    def register_task(self, run_id: str, task: Any) -> bool:
        with self._lock:
            if run_id in self._stopping_ids or run_id in self._claimed_stop_ids:
                return False
            self._tasks[run_id] = task
            return True

    def agent_for(self, run_id: str) -> Any:
        with self._lock:
            return self._agents.get(run_id)

    def task_for(self, run_id: str) -> Any:
        with self._lock:
            return self._tasks.get(run_id)

    def active_task_count(self) -> int:
        with self._lock:
            tasks = tuple(self._tasks.values())
        return sum(not task.done() for task in tasks)

    def is_stopping(self, run_id: str) -> bool:
        with self._lock:
            return run_id in self._stopping_ids

    def remove_control(self, run_id: str) -> None:
        with self._lock:
            if run_id in self._claimed_stop_ids:
                self._deferred_control_removals.add(run_id)
                return
            self._remove_control_locked(run_id)

    def claim_stop_target(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional[StopTarget]:
        """Atomically lease a stop target without running external code locked."""
        now = self.finite_timestamp(self._clock())
        with self._lock:
            status = self._statuses.get(run_id)
            if expected_session_id is not None and (
                status is None
                or status.get("session_id") != expected_session_id
            ):
                return None

            agent = self._agents.get(run_id)
            task = self._tasks.get(run_id)
            if agent is None and task is None:
                return None

            if run_id in self._claimed_stop_ids or run_id in self._stopping_ids:
                return StopTarget(agent=None, task=task, owns_lease=False)

            self._set_status_locked(
                run_id,
                "stopping",
                {"last_event": "run.stopping"},
                now=now,
            )
            self._stopping_ids.add(run_id)
            self._claimed_stop_ids.add(run_id)
            return StopTarget(agent=agent, task=task)

    def release_stop_target(self, run_id: str) -> None:
        """Release a stop lease and apply cleanup deferred during interruption."""
        with self._lock:
            self._claimed_stop_ids.discard(run_id)
            if run_id in self._deferred_control_removals:
                self._deferred_control_removals.discard(run_id)
                self._remove_control_locked(run_id)

    def _remove_control_locked(self, run_id: str) -> None:
        self._agents.pop(run_id, None)
        self._tasks.pop(run_id, None)
        self._stopping_ids.discard(run_id)
        self._deferred_control_removals.discard(run_id)


class RunExecutionHooks(Protocol):
    """Adapter-owned operations needed by the run execution lifecycle."""

    def create_agent(self, **kwargs: Any) -> Any: ...

    def bind_session(self, session_key: str) -> list[Any]: ...

    def clear_session(self, tokens: list[Any]) -> None: ...

    def activate_admitted_request(self) -> None: ...

    def register_approval_notify(
        self, session_key: str, callback: Callable[[Dict[str, Any]], None]
    ) -> None: ...

    def unregister_approval_notify(self, session_key: str) -> None: ...

    def set_approval_session(self, session_key: str) -> Any: ...

    def reset_approval_session(self, token: Any) -> None: ...

    def redact_error(self, value: Any) -> str: ...

    def redact_approval_command(self, value: Any) -> str: ...

    def interrupt_agent(self, agent: Any) -> None: ...

    def track_task(self, task: "asyncio.Task[Any]") -> None: ...


class RunService:
    """Own run execution, retained status, controls, and lifecycle event queues."""

    def __init__(
        self,
        hooks: RunExecutionHooks,
        *,
        registry: Optional[RunRegistry] = None,
        clock: Callable[[], float] = time.time,
        queue_maxsize: int = DEFAULT_RUN_QUEUE_MAXSIZE,
        max_subscribers: int = DEFAULT_RUN_MAX_SUBSCRIBERS,
    ):
        if type(queue_maxsize) is not int or queue_maxsize < 2:
            raise ValueError("run queue maxsize must be an integer of at least 2")
        if type(max_subscribers) is not int or max_subscribers < 1:
            raise ValueError("run max subscribers must be a positive integer")
        self.hooks = hooks
        self.registry = registry or RunRegistry(clock=clock)
        self._clock = clock
        self._queue_maxsize = queue_maxsize
        self._max_subscribers = max_subscribers
        self.streams: Dict[str, "asyncio.Queue[Optional[Dict[str, Any]]]"] = {}
        self.streams_created: Dict[str, float] = {}
        self.stream_subscribers: set[str] = set()
        self.stream_subscriber_queues: Dict[
            str, set["asyncio.Queue[Optional[Dict[str, Any]]]"]
        ] = {}
        self._terminal_replays: Dict[
            str, tuple[Optional[Dict[str, Any]], ...]
        ] = {}
        self.approval_sessions: Dict[str, str] = {}

    def status(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        return self.registry.get(run_id, expected_session_id)

    def list(self, session_id: str, *, limit: int = 100) -> List[Dict[str, Any]]:
        return self.registry.list_for_session(session_id, limit=limit)

    def stream_for(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional["asyncio.Queue[Optional[Dict[str, Any]]]"]:
        if (
            expected_session_id is not None
            and self.registry.get(run_id, expected_session_id) is None
        ):
            return None
        return self.streams.get(run_id)

    def approval_session_for(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional[str]:
        if (
            expected_session_id is not None
            and self.registry.get(run_id, expected_session_id) is None
        ):
            return None
        return self.approval_sessions.get(run_id)

    def active_approval_session_for(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional[str]:
        """Return an approval key only while nonterminal work is still accepted."""
        if not self.registry.is_active(run_id, expected_session_id):
            return None
        return self.approval_sessions.get(run_id)

    def _put_event_if_active(
        self,
        run_id: str,
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]",
        event: Optional[Dict[str, Any]],
    ) -> None:
        if self.streams.get(run_id) is not queue:
            return
        if (
            event is not None
            and event.get("event") not in TERMINAL_RUN_EVENTS
            and not self.registry.is_active(run_id)
        ):
            return
        if event is None:
            replay = self._terminal_replays.get(run_id)
            if replay is None:
                return
            if replay[-1] is not None:
                self._terminal_replays[run_id] = replay + (None,)
        elif event.get("event") in TERMINAL_RUN_EVENTS:
            self._terminal_replays[run_id] = (
                _snapshot_status_value(event),
            )
        subscribers = self.stream_subscriber_queues.get(run_id)
        if subscribers:
            for subscriber_queue in tuple(subscribers):
                self._enqueue_latest(subscriber_queue, event)
        else:
            # Retain the pre-subscription backlog on the canonical queue.
            self._enqueue_latest(queue, event)

    @staticmethod
    def _enqueue_latest(
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]",
        event: Optional[Dict[str, Any]],
    ) -> None:
        """Bound memory by evicting oldest entries before accepting the newest."""
        while True:
            try:
                queue.put_nowait(event)
                return
            except asyncio.QueueFull:
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    # Another consumer freed the slot between the failed put
                    # and eviction; retry without surfacing backpressure.
                    pass

    def _make_event_callback(
        self,
        run_id: str,
        loop: "asyncio.AbstractEventLoop",
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]",
    ) -> Callable[..., None]:
        def push(event: Dict[str, Any]) -> None:
            if not self.registry.is_active(run_id):
                return
            loop.call_soon_threadsafe(
                self._publish_nonterminal_event,
                run_id,
                queue,
                event,
                None,
            )

        def callback(
            event_type: str,
            tool_name: Optional[str] = None,
            preview: Optional[str] = None,
            args: Any = None,
            **kwargs: Any,
        ) -> None:
            try:
                timestamp = self._clock()
                if event_type == "tool.started":
                    push(
                        {
                            "event": "tool.started",
                            "run_id": run_id,
                            "timestamp": timestamp,
                            "tool": tool_name,
                            "preview": preview,
                        }
                    )
                elif event_type == "tool.completed":
                    push(
                        {
                            "event": "tool.completed",
                            "run_id": run_id,
                            "timestamp": timestamp,
                            "tool": tool_name,
                            "duration": round(kwargs.get("duration", 0), 3),
                            "error": kwargs.get("is_error", False),
                        }
                    )
                elif event_type == "reasoning.available":
                    push(
                        {
                            "event": "reasoning.available",
                            "run_id": run_id,
                            "timestamp": timestamp,
                            "text": preview or "",
                        }
                    )
            except Exception:
                logger.debug(
                    "run %s tool progress telemetry callback failed",
                    run_id,
                    exc_info=True,
                )

        return callback

    def _publish_nonterminal_event(
        self,
        run_id: str,
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]",
        event: Dict[str, Any],
        status: Optional[str] = None,
    ) -> None:
        updated = self.registry.set_status_if_active(
            run_id,
            status,
            last_event=event.get("event"),
        )
        if updated is not None:
            self._put_event_if_active(run_id, queue, event)

    def start(
        self,
        *,
        user_message: Any,
        conversation_history: List[Dict[str, str]],
        session_id: str,
        model: str,
        approval_session_key: Optional[str] = None,
        ephemeral_system_prompt: Optional[str] = None,
        gateway_session_key: Optional[str] = None,
        route: Optional[Dict[str, Any]] = None,
        run_id: Optional[str] = None,
    ) -> str:
        """Start one run and return its identifier before execution completes."""
        run_id = run_id or f"run_{uuid.uuid4().hex}"
        session_id = session_id or run_id
        approval_session_key = approval_session_key or run_id
        loop = asyncio.get_running_loop()
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]" = asyncio.Queue(
            maxsize=self._queue_maxsize
        )
        created_at = self._clock()
        self._terminal_replays.pop(run_id, None)
        self.streams[run_id] = queue
        self.streams_created[run_id] = created_at
        self.approval_sessions[run_id] = approval_session_key
        self.registry.set_status(
            run_id,
            "queued",
            created_at=created_at,
            session_id=session_id,
            model=model,
        )

        event_callback = self._make_event_callback(run_id, loop, queue)

        def text_callback(delta: Optional[str]) -> None:
            if delta is None:
                return
            try:
                if not self.registry.is_active(run_id):
                    return
                loop.call_soon_threadsafe(
                    self._publish_nonterminal_event,
                    run_id,
                    queue,
                    {
                        "event": "message.delta",
                        "run_id": run_id,
                        "timestamp": self._clock(),
                        "delta": delta,
                    },
                    None,
                )
            except Exception:
                logger.debug(
                    "run %s text stream callback failed", run_id, exc_info=True
                )

        async def run_and_close() -> None:
            try:
                self.registry.set_status(run_id, "running")
                if self.registry.is_stopping(run_id):
                    self._cancel(run_id, queue)
                    return

                agent = self.hooks.create_agent(
                    ephemeral_system_prompt=ephemeral_system_prompt,
                    session_id=session_id,
                    stream_delta_callback=text_callback,
                    tool_progress_callback=event_callback,
                    gateway_session_key=gateway_session_key,
                    route=route,
                )
                if not self.registry.register_agent(run_id, agent):
                    self._cancel(run_id, queue)
                    return

                def approval_notify(approval_data: Dict[str, Any]) -> None:
                    try:
                        event = dict(approval_data or {})
                        if "command" in event:
                            event["command"] = self.hooks.redact_approval_command(
                                event.get("command")
                            )
                        event.update(
                            {
                                "event": "approval.request",
                                "run_id": run_id,
                                "timestamp": self._clock(),
                                "choices": self._approval_choices(event),
                            }
                        )
                        if self.registry.is_active(run_id):
                            loop.call_soon_threadsafe(
                                self._publish_nonterminal_event,
                                run_id,
                                queue,
                                event,
                                "waiting_for_approval",
                            )
                    except Exception:
                        logger.debug(
                            "run %s approval telemetry callback failed",
                            run_id,
                            exc_info=True,
                        )

                def run_sync() -> tuple[Any, Dict[str, Any]]:
                    approval_token = None
                    session_tokens: List[Any] = []
                    try:
                        approval_token = self.hooks.set_approval_session(
                            approval_session_key
                        )
                        session_tokens = self.hooks.bind_session(approval_session_key)
                        self.hooks.register_approval_notify(
                            approval_session_key, approval_notify
                        )
                        result = agent.run_conversation(
                            user_message=user_message,
                            conversation_history=conversation_history,
                            task_id=session_id or run_id,
                        )
                    finally:
                        try:
                            self.hooks.unregister_approval_notify(approval_session_key)
                        finally:
                            if approval_token is not None:
                                try:
                                    self.hooks.reset_approval_session(approval_token)
                                except Exception:
                                    pass
                            if session_tokens:
                                try:
                                    self.hooks.clear_session(session_tokens)
                                except Exception:
                                    pass
                    usage = {
                        "input_tokens": getattr(agent, "session_prompt_tokens", 0)
                        or 0,
                        "output_tokens": getattr(
                            agent, "session_completion_tokens", 0
                        )
                        or 0,
                        "total_tokens": getattr(agent, "session_total_tokens", 0)
                        or 0,
                    }
                    return result, usage

                result, usage = await loop.run_in_executor(None, run_sync)
                if self.registry.is_stopping(run_id):
                    self._cancel(run_id, queue)
                elif isinstance(result, dict) and result.get("failed"):
                    error = self._safe_redact_error(
                        result.get("error") or "agent run failed"
                    )
                    self._finish_failed(run_id, queue, error)
                else:
                    output = (
                        result.get("final_response", "")
                        if isinstance(result, dict)
                        else ""
                    )
                    event = {
                        "event": "run.completed",
                        "run_id": run_id,
                        "timestamp": self._clock(),
                        "output": output,
                        "usage": usage,
                    }
                    self.registry.set_status(
                        run_id,
                        "completed",
                        output=output,
                        usage=usage,
                        last_event="run.completed",
                    )
                    self._put_event_if_active(run_id, queue, event)
            except asyncio.CancelledError:
                self._cancel(run_id, queue)
                raise
            except Exception as exc:
                logger.exception("run %s failed", run_id)
                self._finish_failed(
                    run_id, queue, self._safe_redact_error(exc)
                )
            finally:
                try:
                    self.hooks.unregister_approval_notify(approval_session_key)
                except Exception:
                    pass
                try:
                    self._put_event_if_active(run_id, queue, None)
                except Exception:
                    pass
                self.registry.remove_control(run_id)
                self.approval_sessions.pop(run_id, None)

        self.hooks.activate_admitted_request()
        task = asyncio.create_task(run_and_close())
        self.registry.register_task(run_id, task)
        self.hooks.track_task(task)
        return run_id

    @staticmethod
    def _approval_choices(event: Dict[str, Any]) -> List[str]:
        if bool(event.get("smart_denied")):
            return ["once", "deny"]
        if event.get("allow_permanent") is False:
            return ["once", "session", "deny"]
        return ["once", "session", "always", "deny"]

    def _safe_redact_error(self, value: Any) -> str:
        try:
            redacted = self.hooks.redact_error(value)
        except Exception:
            logger.exception("run error redaction failed")
            return "Run failed"
        return redacted if isinstance(redacted, str) and redacted else "Run failed"

    def _cancel(
        self,
        run_id: str,
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]",
    ) -> None:
        self.registry.set_status(
            run_id, "cancelled", last_event="run.cancelled"
        )
        self._put_event_if_active(
            run_id,
            queue,
            {
                "event": "run.cancelled",
                "run_id": run_id,
                "timestamp": self._clock(),
            },
        )

    def _finish_failed(
        self,
        run_id: str,
        queue: "asyncio.Queue[Optional[Dict[str, Any]]]",
        error: str,
    ) -> None:
        self.registry.set_status(
            run_id, "failed", error=error, last_event="run.failed"
        )
        self._put_event_if_active(
            run_id,
            queue,
            {
                "event": "run.failed",
                "run_id": run_id,
                "timestamp": self._clock(),
                "error": error,
            },
        )

    def stop(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional[Dict[str, str]]:
        target = self.registry.claim_stop_target(run_id, expected_session_id)
        if target is None:
            return None
        if target.owns_lease:
            try:
                if target.agent is not None:
                    try:
                        self.hooks.interrupt_agent(target.agent)
                    except Exception:
                        pass
            finally:
                self.registry.release_stop_target(run_id)
        return {"run_id": run_id, "status": "stopping"}

    def publish_approval_response(
        self,
        run_id: str,
        *,
        expected_session_id: Optional[str] = None,
        choice: str,
        resolved: int,
    ) -> bool:
        """Publish lifecycle state after the adapter resolves an approval."""
        updated = self.registry.set_status_if_active(
            run_id,
            "running",
            expected_session_id=expected_session_id,
            last_event="approval.responded",
        )
        if updated is None:
            return False
        queue = self.streams.get(run_id)
        if queue is not None:
            self._put_event_if_active(
                run_id,
                queue,
                {
                    "event": "approval.responded",
                    "run_id": run_id,
                    "timestamp": self._clock(),
                    "choice": choice,
                    "resolved": resolved,
                },
            )
        return True

    def subscribe(
        self, run_id: str, expected_session_id: Optional[str] = None
    ) -> Optional["asyncio.Queue[Optional[Dict[str, Any]]]"]:
        canonical_queue = self.stream_for(run_id, expected_session_id)
        if canonical_queue is None:
            return None
        subscribers = self.stream_subscriber_queues.setdefault(run_id, set())
        if len(subscribers) >= self._max_subscribers:
            raise RunSubscriberLimitError(run_id)
        queue = (
            canonical_queue
            if not subscribers
            else asyncio.Queue(maxsize=self._queue_maxsize)
        )
        if queue is not canonical_queue:
            for event in self._terminal_replays.get(run_id, ()):
                self._enqueue_latest(
                    queue,
                    None if event is None else _snapshot_status_value(event)
                )
        subscribers.add(queue)
        self.stream_subscribers.add(run_id)
        return queue

    def unsubscribe(
        self,
        run_id: str,
        queue: Optional["asyncio.Queue[Optional[Dict[str, Any]]]"] = None,
    ) -> None:
        subscribers = self.stream_subscriber_queues.get(run_id)
        if queue is not None and subscribers is not None:
            if queue not in subscribers:
                return
            subscribers.discard(queue)
            if subscribers:
                return
        self.stream_subscriber_queues.pop(run_id, None)
        self.stream_subscribers.discard(run_id)
        status = self.registry.get(run_id)
        if status is not None and status.get("status") not in TERMINAL_RUN_STATUSES:
            return
        self.streams.pop(run_id, None)
        self.streams_created.pop(run_id, None)
        self._terminal_replays.pop(run_id, None)

    def sweep(self, now: float, stream_ttl: float, status_ttl: float) -> None:
        stale = [
            run_id
            for run_id, created_at in list(self.streams_created.items())
            if now - created_at > stream_ttl
            and run_id not in self.stream_subscribers
        ]
        for run_id in stale:
            task = self.registry.task_for(run_id)
            task_done = task is None or task.done()
            if task_done:
                approval_session_key = self.approval_sessions.get(run_id)
                if approval_session_key:
                    try:
                        self.hooks.unregister_approval_notify(approval_session_key)
                    except Exception:
                        pass
            self.streams.pop(run_id, None)
            self.streams_created.pop(run_id, None)
            self.stream_subscriber_queues.pop(run_id, None)
            self.stream_subscribers.discard(run_id)
            self._terminal_replays.pop(run_id, None)
            if task_done:
                self.registry.remove_control(run_id)
                self.approval_sessions.pop(run_id, None)
        self.registry.expire_terminal_statuses(now, status_ttl)
