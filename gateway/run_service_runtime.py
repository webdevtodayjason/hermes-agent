"""Process-lifetime asyncio owner for synchronous gateway callers."""

from __future__ import annotations

import atexit
import asyncio
import concurrent.futures
import threading
from collections.abc import Coroutine
from typing import Any, TypeVar


T = TypeVar("T")


class RunServiceRuntimeClosed(RuntimeError):
    """Raised when work is submitted after runtime shutdown."""


class RunServiceRuntimeStartupError(RuntimeError):
    """Raised when the owner loop cannot start within its configured bound."""


class RunServiceRuntimeShutdownError(RuntimeError):
    """Raised when the owner loop cannot stop within its configured bound."""


class RunServiceRuntime:
    """Own one daemon event-loop thread for long-lived run service work."""

    def __init__(self, *, startup_timeout: float = 5.0) -> None:
        self._lock = threading.RLock()
        self._ready = threading.Event()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._closed = False
        self._thread = threading.Thread(
            target=self._run_loop,
            name="hermes-run-service",
            daemon=True,
        )
        self._thread.start()
        if not self._ready.wait(timeout=startup_timeout):
            with self._lock:
                self._closed = True
                loop = self._loop
                if loop is not None:
                    loop.call_soon_threadsafe(loop.stop)
            raise RunServiceRuntimeStartupError(
                "run service runtime did not start before the timeout"
            )
        self._atexit_callback = self.shutdown
        atexit.register(self._atexit_callback)

    @property
    def thread_id(self) -> int | None:
        return self._thread.ident

    @property
    def is_daemon(self) -> bool:
        return self._thread.daemon

    @property
    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def submit(self, coro: Coroutine[Any, Any, T]) -> concurrent.futures.Future[T]:
        with self._lock:
            loop = self._loop
            if self._closed or loop is None or not loop.is_running():
                coro.close()
                raise RunServiceRuntimeClosed("run service runtime is shut down")
            try:
                return asyncio.run_coroutine_threadsafe(coro, loop)
            except RuntimeError as exc:
                coro.close()
                raise RunServiceRuntimeClosed(
                    "run service runtime is shut down"
                ) from exc

    def shutdown(self, *, timeout: float = 5.0) -> None:
        if threading.get_ident() == self._thread.ident:
            raise RunServiceRuntimeShutdownError(
                "run service runtime cannot synchronously shut down its owner thread"
            )
        with self._lock:
            if not self._closed:
                self._closed = True
                loop = self._loop
                if loop is not None:
                    loop.call_soon_threadsafe(loop.stop)
        self._thread.join(timeout=timeout)
        if self._thread.is_alive():
            raise RunServiceRuntimeShutdownError(
                "run service runtime did not stop before the timeout"
            )
        callback = getattr(self, "_atexit_callback", None)
        if callback is not None:
            atexit.unregister(callback)

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with self._lock:
            self._loop = loop
            closed_before_start = self._closed
        try:
            if closed_before_start:
                return
            loop.call_soon(self._ready.set)
            try:
                loop.run_forever()
            finally:
                with self._lock:
                    self._closed = True
                self._run_one_tick(loop)
                self._drain_pending_tasks(loop)
                self._drain_async_generators_and_tasks(loop)
                loop.run_until_complete(loop.shutdown_default_executor())
                self._drain_pending_tasks(loop)
                self._drain_async_generators_and_tasks(loop)
        finally:
            if not loop.is_closed():
                loop.close()
            with self._lock:
                if self._loop is loop:
                    self._loop = None

    @staticmethod
    def _run_one_tick(loop: asyncio.AbstractEventLoop) -> None:
        loop.call_soon(loop.stop)
        loop.run_forever()

    @classmethod
    def _drain_async_generators_and_tasks(
        cls,
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        while True:
            loop.run_until_complete(loop.shutdown_asyncgens())
            cls._drain_pending_tasks(loop)
            # asyncio has no public quiescence query; every stdlib BaseEventLoop
            # tracks live async generators in this cross-platform WeakSet.
            tracked = getattr(loop, "_asyncgens", ())
            if not tracked:
                return

    @staticmethod
    def _drain_pending_tasks(loop: asyncio.AbstractEventLoop) -> None:
        while pending := asyncio.all_tasks(loop):
            for task in pending:
                task.cancel()
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
