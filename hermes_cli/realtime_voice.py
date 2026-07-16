"""Secure OpenAI Realtime client-secret minting shared by Desktop transports."""

from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.request
from typing import Any

from tools.tool_backend_helpers import resolve_openai_audio_api_key

REALTIME_MODEL = "gpt-realtime-2.1"


class RealtimeCredentialUnavailable(RuntimeError):
    """A direct OpenAI Platform credential is not configured."""


class RealtimeProviderError(RuntimeError):
    """The provider could not mint a usable ephemeral client secret."""


def mint_realtime_session(session_id: str, profile: str | None = None) -> dict[str, Any]:
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

    session_config = {
        "session": {
            "type": "realtime",
            "model": REALTIME_MODEL,
            "output_modalities": ["audio"],
            "instructions": (
                "You are Hermes, the same assistant in the user's current Desktop "
                "conversation. Be concise and natural in speech. You cannot directly "
                "execute tools or claim actions completed; consequential actions require "
                "confirmation through the normal Hermes conversation."
            ),
            "audio": {
                "input": {
                    "noise_reduction": {"type": "far_field"},
                    "transcription": {"model": "gpt-4o-mini-transcribe"},
                    "turn_detection": {
                        "type": "server_vad",
                        "create_response": False,
                        "interrupt_response": True,
                        "silence_duration_ms": 500,
                    },
                },
                "output": {"voice": "marin"},
            },
        }
    }
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
