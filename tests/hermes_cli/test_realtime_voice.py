"""Contract tests for the backend-minted OpenAI Realtime session."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch


def test_minted_session_is_transcription_only() -> None:
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

    assert audio_input["turn_detection"]["type"] == "server_vad"
    assert audio_input["turn_detection"]["create_response"] is False
    assert audio_input["transcription"]["model"] == "gpt-4o-mini-transcribe"
    assert "tools" not in session
