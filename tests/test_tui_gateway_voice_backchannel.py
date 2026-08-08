"""N2a: user barge-in over result narration must not destroy the delivery.

`narration_interrupted` is the user speaking over Evie while she reads a
verified canonical result. That is not a delivery failure: the result must
stay deliverable once the channel is idle again. `narration_failed` keeps the
strict N3 budget (two same-provider attempts, one cross-provider recovery,
recovery failure final). Interrupt redeliveries have their own hard cap so
the N3 storm bound stays structural.
"""

import threading
import time

import pytest

from tui_gateway import server


@pytest.fixture
def voice_session(monkeypatch):
    sid = "voice-backchannel"
    provider_session_id = "provider-backchannel"
    persisted = {}

    class FakeDB:
        def set_meta(self, key, value):
            persisted[key] = value

    session = {
        "_correlated_turns": {
            "call-backchannel": {
                "delivery_id": "delivery-initial",
                "delivery_provider_session_id": provider_session_id,
                "delivery_stage": "pending",
                "result_text": "Verified canonical result.",
                "result_truncated": False,
                "status": "completed",
            }
        },
        "_voice_intent_grant": {
            "active": True,
            "expires_at": time.time() + 60,
            "provider_session_id": provider_session_id,
        },
        "history": [],
        "history_lock": threading.RLock(),
        "running": False,
        "session_key": "voice-stored-backchannel",
    }
    server._sessions[sid] = session
    monkeypatch.setattr(server, "_get_db", lambda: FakeDB())

    def ack(delivery_id, stage):
        return server._methods["voice.intent.ack"](
            f"ack-{delivery_id}-{stage}",
            {
                "call_id": "call-backchannel",
                "delivery_id": delivery_id,
                "provider_session_id": session["_voice_intent_grant"]["provider_session_id"],
                "session_id": sid,
                "stage": stage,
            },
        )

    def pending(tag):
        return server._methods["voice.intent.pending"](
            f"pending-{tag}", {"session_id": sid}
        )["result"]["results"]

    yield session, ack, pending, persisted
    server._sessions.pop(sid, None)


def _deliver_until(ack, delivery_id, stage):
    assert ack(delivery_id, "consumed")["result"]["stage"] == "consumed"
    assert ack(delivery_id, "narration_started")["result"]["stage"] == "narration_started"
    assert ack(delivery_id, stage)["result"]["stage"] == stage


def test_backchannel_interrupts_do_not_exhaust_result_delivery(voice_session):
    """Two barge-ins while Evie reads the answer must not destroy the answer."""
    session, ack, pending, _ = voice_session
    state = session["_correlated_turns"]["call-backchannel"]

    _deliver_until(ack, "delivery-initial", "narration_interrupted")
    retry = pending("after-first-interrupt")
    assert len(retry) == 1

    _deliver_until(ack, retry[0]["delivery_id"], "narration_interrupted")
    assert state.get("delivery_exhausted") is not True

    second_retry = pending("after-second-interrupt")
    assert len(second_retry) == 1

    _deliver_until(ack, second_retry[0]["delivery_id"], "narration_completed")
    assert state["delivery_stage"] == "narration_completed"
    assert state.get("delivery_exhausted") is not True


def test_interrupt_redeliveries_hit_a_hard_cap(voice_session):
    """The interrupt lane stays bounded: the storm stays structurally impossible."""
    session, ack, pending, _ = voice_session
    state = session["_correlated_turns"]["call-backchannel"]
    cap = getattr(server, "_MAX_NARRATION_INTERRUPT_REDELIVERIES", 5)

    delivery_id = "delivery-initial"

    for round_number in range(1, cap + 1):
        _deliver_until(ack, delivery_id, "narration_interrupted")

        if round_number < cap:
            assert state.get("delivery_exhausted") is not True, (
                f"exhausted after only {round_number} interrupts"
            )
            remint = pending(f"after-interrupt-{round_number}")
            assert len(remint) == 1, f"no redelivery after interrupt {round_number}"
            delivery_id = remint[0]["delivery_id"]

    assert state.get("delivery_exhausted") is True
    assert pending("after-cap") == []


def test_failure_budget_survives_interleaved_interrupts(voice_session):
    """Failures keep their own strict budget: two failed deliveries exhaust."""
    session, ack, pending, _ = voice_session
    state = session["_correlated_turns"]["call-backchannel"]

    _deliver_until(ack, "delivery-initial", "narration_interrupted")
    retry = pending("after-interrupt")
    assert len(retry) == 1

    _deliver_until(ack, retry[0]["delivery_id"], "narration_failed")
    assert state.get("delivery_exhausted") is not True

    failure_retry = pending("after-first-failure")
    assert len(failure_retry) == 1

    _deliver_until(ack, failure_retry[0]["delivery_id"], "narration_failed")
    assert state.get("delivery_exhausted") is True
    assert pending("after-second-failure") == []


def test_recovery_failure_stays_final(voice_session):
    """A failed cross-provider recovery delivery still ends the line."""
    session, ack, pending, _ = voice_session
    state = session["_correlated_turns"]["call-backchannel"]

    _deliver_until(ack, "delivery-initial", "narration_failed")

    session["_voice_intent_grant"]["provider_session_id"] = "provider-recovered"
    recovery = pending("cross-provider-recovery")
    assert len(recovery) == 1
    assert state["delivery_kind"] == "recovery"

    _deliver_until(ack, recovery[0]["delivery_id"], "narration_failed")
    assert state.get("delivery_exhausted") is True
    assert pending("after-recovery-failure") == []
