"""Model-callable durable work orchestration tools.

The model supplies only the task contract. Conversation ownership and profile
selection always come from trusted gateway session context.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from gateway.session_context import async_delivery_supported, get_session_env
from hermes_constants import get_hermes_home
from tools.registry import registry, tool_error
from tui_gateway.work_runs import WorkRunNotFound, get_work_runs


WORK_START_SCHEMA = {
    "name": "work_start",
    "description": (
        "Start durable background work while remaining available in the current "
        "conversation. Use for multi-step work that should continue independently. "
        "The result returns a run_id immediately; completion returns to this chat."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "task": {
                "type": "string",
                "description": "Self-contained goal for the background worker.",
            },
            "context": {
                "type": "string",
                "description": "Optional constraints or context the worker needs.",
            },
        },
        "required": ["task"],
    },
}


WORK_STATUS_SCHEMA = {
    "name": "work_status",
    "description": "Get the current status of durable work started in this conversation.",
    "parameters": {
        "type": "object",
        "properties": {
            "run_id": {"type": "string", "description": "Authoritative work run ID."}
        },
        "required": ["run_id"],
    },
}

WORK_STOP_SCHEMA = {
    "name": "work_stop",
    "description": "Request that durable work started in this conversation stop.",
    "parameters": WORK_STATUS_SCHEMA["parameters"],
}


def _handle_work_start(args: dict[str, Any], **_kwargs: Any) -> str:
    task = args.get("task")
    if not isinstance(task, str) or not task.strip():
        return tool_error("task is required")
    if get_session_env("HERMES_SESSION_SOURCE").strip() == "work_run":
        return tool_error("work runs cannot recursively delegate durable work")
    if not async_delivery_supported():
        return tool_error("this conversation cannot receive durable work results")

    session_id = get_session_env("HERMES_SESSION_ID").strip()
    session_key = get_session_env("HERMES_SESSION_KEY").strip()
    ui_session_id = get_session_env("HERMES_UI_SESSION_ID").strip()
    if not session_id or not session_key:
        return tool_error("durable work requires an active conversation session")

    context = args.get("context")
    history = []
    if isinstance(context, str) and context.strip():
        history = [{"role": "user", "content": context.strip()}]

    result = get_work_runs(Path(get_hermes_home()).resolve()).start(
        session_id=session_id,
        gateway_session_key=session_key,
        origin_ui_session_id=ui_session_id,
        user_input=task.strip(),
        history=history,
    )
    return json.dumps(result, ensure_ascii=False)


def _handle_work_status(args: dict[str, Any], **_kwargs: Any) -> str:
    session_id = get_session_env("HERMES_SESSION_ID").strip()
    run_id = args.get("run_id")
    if not session_id:
        return tool_error("durable work requires an active conversation session")
    if not isinstance(run_id, str) or not run_id.strip():
        return tool_error("run_id is required")
    try:
        result = get_work_runs(Path(get_hermes_home()).resolve()).status(
            session_id=session_id,
            run_id=run_id.strip(),
        )
    except WorkRunNotFound:
        return tool_error("run not found")
    return json.dumps(result, ensure_ascii=False)


def _handle_work_stop(args: dict[str, Any], **_kwargs: Any) -> str:
    session_id = get_session_env("HERMES_SESSION_ID").strip()
    run_id = args.get("run_id")
    if not session_id:
        return tool_error("durable work requires an active conversation session")
    if not isinstance(run_id, str) or not run_id.strip():
        return tool_error("run_id is required")
    try:
        result = get_work_runs(Path(get_hermes_home()).resolve()).stop(
            session_id=session_id,
            run_id=run_id.strip(),
        )
    except WorkRunNotFound:
        return tool_error("run not found")
    return json.dumps(result, ensure_ascii=False)


registry.register(
    name="work_start",
    toolset="work",
    schema=WORK_START_SCHEMA,
    handler=_handle_work_start,
    emoji="⚙️",
)

registry.register(
    name="work_status",
    toolset="work",
    schema=WORK_STATUS_SCHEMA,
    handler=_handle_work_status,
    emoji="⚙️",
)

registry.register(
    name="work_stop",
    toolset="work",
    schema=WORK_STOP_SCHEMA,
    handler=_handle_work_stop,
    emoji="⏹️",
)
