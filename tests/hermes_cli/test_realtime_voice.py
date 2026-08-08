"""Contract tests for the backend-minted OpenAI Realtime session."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch


def test_minted_session_restores_full_duplex_spoken_presence() -> None:
    from hermes_cli.realtime_voice import mint_realtime_session

    response = MagicMock()
    response.read.return_value = json.dumps({"value": "ephemeral-secret"}).encode()
    response.__enter__.return_value = response
    response.__exit__.return_value = False

    with (
        patch("hermes_cli.realtime_voice.resolve_openai_audio_api_key", return_value="platform-key"),
        patch("hermes_cli.realtime_voice.urllib.request.urlopen", return_value=response) as urlopen,
    ):
        mint_realtime_session("session-123")

    request = urlopen.call_args.args[0]
    body = json.loads(request.data.decode("utf-8"))
    session = body["session"]
    audio_input = session["audio"]["input"]
    instructions = session["instructions"]

    assert session["output_modalities"] == ["audio"]
    assert audio_input["turn_detection"]["type"] == "server_vad"
    assert audio_input["turn_detection"]["create_response"] is True
    assert audio_input["turn_detection"]["interrupt_response"] is True
    assert audio_input["transcription"]["model"] == "gpt-4o-mini-transcribe"
    assert "One to two sentences per turn unless asked for more." in instructions
    assert "Never restate or summarize what the person just said." in instructions
    assert "Never list what you can or can't do." in instructions
    assert "Never end a turn with an offer or a question unless you genuinely need an answer to proceed." in instructions
    assert "Silence after you finish is normal, not a failure." in instructions
    assert "British cadence" in instructions
    assert "You are Evie, the librarian" in instructions
    assert "Evie is your identity, not a costume or temporary style" in instructions
    assert "You are not a separate assistant, interface, or front desk" in instructions
    assert "identity remains Hermes" not in instructions
    assert "Style outranks persona" not in instructions
    assert "canonical Hermes" not in instructions
    assert "cannot directly execute" not in instructions
    assert "tools" not in session


def test_minted_session_adds_only_bounded_dispatch_tool_when_explicitly_granted() -> None:
    from hermes_cli.realtime_voice import mint_realtime_session

    response = MagicMock()
    response.read.return_value = json.dumps({"value": "ephemeral-secret"}).encode()
    response.__enter__.return_value = response
    response.__exit__.return_value = False

    with (
        patch("hermes_cli.realtime_voice.resolve_openai_audio_api_key", return_value="platform-key"),
        patch("hermes_cli.realtime_voice.urllib.request.urlopen", return_value=response) as urlopen,
    ):
        mint_realtime_session("session-123", enable_intent_dispatch=True)

    body = json.loads(urlopen.call_args.args[0].data.decode("utf-8"))
    session = body["session"]
    instructions = session["instructions"]
    assert session["tool_choice"] == "auto"
    assert "Infer when your tools, local environment, memory, or current evidence are needed" in instructions
    assert "The user never needs to name a tool or ask you to delegate" in instructions
    assert "command-line utilities, Hermes skills, and Hermes tools" in instructions
    assert "same practical agency as working with Hermes in the terminal" in instructions
    assert "Do not describe a separate agent or internal routing boundary" in instructions
    assert session["tools"] == [
        {
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
    ]
