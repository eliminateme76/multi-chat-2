"""Reconstructs Concordia entities from authoritative Sceneweaver snapshots."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

from concordia.agents.entity_agent_with_logging import EntityAgentWithLogging
from concordia.typing import entity as entity_lib

from . import ENGINE_NAME, ENGINE_VERSION
from .components import (
    BridgeActingComponent,
    ModelBridge,
    ObservationComponent,
    PassiveActingComponent,
    SnapshotComponent,
)
from .engine import SceneweaverSequentialEngine


def _components(params: Mapping[str, Any]) -> dict[str, SnapshotComponent | ObservationComponent]:
    snapshots = params.get("components") or {}
    components: dict[str, SnapshotComponent | ObservationComponent] = {
        str(key): SnapshotComponent(str(key), str(value))
        for key, value in snapshots.items()
        if value
    }
    components["observations"] = ObservationComponent()
    return components


def run_character(params: Mapping[str, Any], bridge: ModelBridge) -> Mapping[str, Any]:
    acting = BridgeActingComponent(bridge, params["modelRequest"])
    character = EntityAgentWithLogging(
        agent_name=str(params.get("name") or "Character"),
        act_component=acting,
        context_components=_components(params),
    )
    observer = EntityAgentWithLogging(
        agent_name="World Director",
        act_component=PassiveActingComponent(),
        context_components={"observations": ObservationComponent()},
    )
    action_spec = entity_lib.free_action_spec(
        call_to_action="DB 상태와 관찰 가능한 사건만 근거로 이 캐릭터의 다음 반응을 구조화해 결정하세요.",
        tag="sceneweaver_character_action",
    )
    trace: list[Mapping[str, Any]] = []
    result = SceneweaverSequentialEngine(action_spec).run_loop(
        [observer], [character], str(params.get("premise") or ""), 1, False, trace
    )
    return {
        "value": json.loads(result),
        "runtime": acting.last_runtime,
        "engine": {"name": ENGINE_NAME, "version": ENGINE_VERSION},
        "concordia": {"entity": character.name, "components": list(_components(params)), "steps": len(trace)},
    }


def run_game_master(params: Mapping[str, Any], bridge: ModelBridge) -> Mapping[str, Any]:
    acting = BridgeActingComponent(bridge, params["modelRequest"])
    game_master = EntityAgentWithLogging(
        agent_name="World Director",
        act_component=acting,
        context_components=_components(params),
    )
    for observation in params.get("observations") or []:
        game_master.observe(str(observation))
    action_spec = entity_lib.free_action_spec(
        call_to_action="세계의 현재 상태와 방금 행동을 판정하고, 다음 세계 진행 결정을 구조화해 반환하세요.",
        tag="sceneweaver_game_master_judgment",
    )
    result = game_master.act(action_spec)
    return {
        "value": json.loads(result),
        "runtime": acting.last_runtime,
        "engine": {"name": ENGINE_NAME, "version": ENGINE_VERSION},
        "concordia": {"entity": game_master.name, "components": list(_components(params)), "steps": 1},
    }
