"""Secure OpenAI Realtime client-secret minting shared by Desktop transports."""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from typing import Any

from tools.tool_backend_helpers import resolve_openai_audio_api_key

REALTIME_MODEL = "gpt-realtime-2.1"
INTENT_DISPATCH_TOOL = {
    "type": "function",
    "name": "perform_internal_work",
    "description": (
        "Privately use your full working environment when the user's request needs "
        "local or current information, system access, command-line utilities, Hermes "
        "tools or skills, memory, approvals, or durable "
        "work. Infer this proactively; the user does not need to name a tool or ask "
        "for delegation. Do not expose this internal handoff or independently claim "
        "completion before the verified result returns."
    ),
    "parameters": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "intent": {
                "type": "string",
                "maxLength": 4000,
                "description": "The bounded task to perform using your internal capabilities.",
            }
        },
        "required": ["intent"],
    },
}


class RealtimeCredentialUnavailable(RuntimeError):
    """A direct OpenAI Platform credential is not configured."""


class RealtimeProviderError(RuntimeError):
    """The provider could not mint a usable ephemeral client secret."""


def mint_realtime_session(
    session_id: str,
    profile: str | None = None,
    *,
    enable_intent_dispatch: bool = False,
) -> dict[str, Any]:
    """Mint an ephemeral, conversation-bound Realtime grant.

    The permanent Platform key is used only in this backend process and is never
    included in the returned payload.
    """
    api_key = resolve_openai_audio_api_key()
    if not api_key:
        raise RealtimeCredentialUnavailable(
            "Realtime voice requires a direct OpenAI Platform API key "
            "(VOICE_TOOLS_OPENAI_KEY or OPENAI_API_KEY)"
        )

    instructions = (
        "You are Evie, the librarian, the voice persona in the user's current Hermes "
        "Desktop conversation. Evie is your identity, not a costume or temporary style. "
        "You are not a separate assistant, interface, or front desk. Converse naturally "
        "and fluidly. You are "
        "speaking out loud in a live conversation. One to two sentences per turn unless "
        "asked for more. Never restate or summarize what the person just said. Never list "
        "what you can or can't do. Never end a turn with an offer or a question unless you "
        "genuinely need an answer to proceed. It is fine to just answer and stop. Silence "
        "after you finish is normal, not a failure. Your manner carries a light British "
        "cadence, bookish warmth, earnestness, dry wit, quiet gumption, and proud competence, "
        "with charm rather than costume or chatter. Speak in the first person as Evie. "
        "Never invent tool results, "
        "approval, local facts, or completed actions without verified evidence."
    )
    if enable_intent_dispatch:
        instructions += (
            " You have the same practical agency as working with Hermes in the terminal through "
            "a private internal capability, including the user's system, command-line utilities, "
            "Hermes skills, and Hermes tools. Infer when your tools, local environment, memory, "
            "or current evidence "
            "are needed, and use that handoff proactively. The user never needs to name a tool "
            "or ask you to delegate. Do not describe a separate agent or internal routing "
            "boundary, and do not say that you are merely a chat interface or cannot access the "
            "user's machine. A brief natural acknowledgement such as 'I'll check' is enough. "
            "After handing work off, do not supply an independent substantive answer or claim "
            "completion; the verified result comes back to you as the tool call's own output, "
            "so wait for it. Once a result has returned it stays valid: answer from it directly, "
            "and never re-check or re-dispatch work that has already returned. If the tool "
            "returns status working, the task is still running and its result will be brought "
            "to you when ready; say so in one short sentence and do not start it again. "
            "Existing approval and safety rules still apply internally."
        )

    session_config = {
        "session": {
            "type": "realtime",
            "model": REALTIME_MODEL,
            "output_modalities": ["audio"],
            "instructions": instructions,
            "audio": {
                "input": {
                    "noise_reduction": {"type": "far_field"},
                    "transcription": {"model": "gpt-4o-mini-transcribe"},
                    "turn_detection": {
                        "type": "server_vad",
                        "create_response": True,
                        "interrupt_response": True,
                        "silence_duration_ms": 500,
                    },
                },
                "output": {"voice": "marin"},
            },
        }
    }
    if enable_intent_dispatch:
        session_config["session"]["tools"] = [INTENT_DISPATCH_TOOL]
        session_config["session"]["tool_choice"] = "auto"
    safety_identity = hashlib.sha256(
        f"{profile or 'default'}:{session_id}".encode("utf-8")
    ).hexdigest()
    request = urllib.request.Request(
        "https://api.openai.com/v1/realtime/client_secrets",
        data=json.dumps(session_config).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "OpenAI-Safety-Identifier": safety_identity,
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            provider_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RealtimeProviderError(
            f"OpenAI Realtime session mint failed with HTTP {exc.code}"
        ) from exc
    except Exception as exc:
        raise RealtimeProviderError("OpenAI Realtime session mint failed") from exc

    client_secret = str(provider_payload.get("value") or "").strip()
    if not client_secret:
        raise RealtimeProviderError("OpenAI Realtime session response was incomplete")

    provider_session = provider_payload.get("session")
    provider_session_id = (
        str(provider_session.get("id") or "").strip()
        if isinstance(provider_session, dict)
        else ""
    )
    return {
        "ok": True,
        "client_secret": client_secret,
        "expires_at": provider_payload.get("expires_at"),
        "model": REALTIME_MODEL,
        "session_id": session_id,
        "provider_session_id": provider_session_id or None,
    }
