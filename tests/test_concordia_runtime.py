import json
import subprocess
import sys

from concordia.agents.entity_agent_with_logging import EntityAgentWithLogging

from concordia_runtime import ENGINE_NAME, ENGINE_VERSION
from concordia_runtime.runtime import run_character, run_game_master


class FakeBridge:
    def __init__(self, value):
        self.value = value
        self.requests = []

    def sample(self, request):
        self.requests.append(request)
        return {"value": self.value, "runtime": {"threadId": "thread-test"}}


def test_character_runs_through_concordia_entity_and_engine():
    bridge = FakeBridge({"contentBlocks": [{"type": "DIALOGUE", "text": "알겠어."}], "actionScope": "NONE"})
    result = run_character(
        {
            "name": "루카",
            "premise": "장면 1",
            "components": {"identity": "마법 기사 견습생", "scene": "도서관"},
            "modelRequest": {"kind": "character"},
        },
        bridge,
    )

    assert result["value"]["contentBlocks"] == [{"type": "DIALOGUE", "text": "알겠어."}]
    assert result["engine"] == {"name": ENGINE_NAME, "version": ENGINE_VERSION}
    assert result["concordia"]["entity"] == "루카"
    assert result["concordia"]["steps"] == 1
    assert "CONCORDIA ACTION SPEC" in bridge.requests[0]["prompt"]
    assert "마법 기사 견습생" in bridge.requests[0]["prompt"]


def test_game_master_observes_events_before_structured_judgment():
    bridge = FakeBridge({"action": "CONTINUE", "responders": []})
    result = run_game_master(
        {
            "components": {"world": "별빛 마도학원"},
            "observations": ["루카가 문을 두드렸다."],
            "modelRequest": {"kind": "game_master"},
        },
        bridge,
    )

    assert result["value"]["action"] == "CONTINUE"
    assert result["concordia"]["entity"] == "World Director"
    assert "루카가 문을 두드렸다." in bridge.requests[0]["prompt"]


def test_concordia_entity_type_is_real_package_class():
    assert EntityAgentWithLogging.__module__.startswith("concordia.")


def test_worker_reverse_rpc_round_trip():
    worker = subprocess.Popen(
        [sys.executable, "-m", "concordia_runtime.worker"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        request = {
            "id": 7,
            "method": "entity/act",
            "params": {
                "name": "세라",
                "premise": "장면 1",
                "components": {"identity": "견습 마녀"},
                "modelRequest": {"kind": "character"},
            },
        }
        worker.stdin.write(json.dumps(request, ensure_ascii=False) + "\n")
        worker.stdin.flush()
        callback = json.loads(worker.stdout.readline())
        assert callback["method"] == "model/sample"
        worker.stdin.write(
            json.dumps(
                {
                    "id": callback["id"],
                    "result": {
                        "value": {"contentBlocks": [{"type": "DIALOGUE", "text": "확인했습니다."}], "actionScope": "NONE"},
                        "runtime": {"threadId": "thread-rpc"},
                    },
                },
                ensure_ascii=False,
            )
            + "\n"
        )
        worker.stdin.flush()
        response = json.loads(worker.stdout.readline())
        assert response["id"] == 7
        assert response["result"]["value"]["contentBlocks"] == [{"type": "DIALOGUE", "text": "확인했습니다."}]
        assert response["result"]["runtime"]["threadId"] == "thread-rpc"
    finally:
        worker.terminate()
        worker.wait(timeout=5)
