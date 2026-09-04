"""Concordia components backed by Sceneweaver's Node model callback."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Protocol

from concordia.typing import entity as entity_lib
from concordia.typing import entity_component


class ModelBridge(Protocol):
    def sample(self, request: Mapping[str, Any]) -> Mapping[str, Any]: ...


class SnapshotComponent(entity_component.ContextComponent):
    """A reconstructable DB snapshot exposed through Concordia's pre-act hook."""

    def __init__(self, heading: str, text: str):
        self._heading = heading
        self._text = text

    def pre_act(self, action_spec: entity_lib.ActionSpec) -> str:
        del action_spec
        return f"[{self._heading}]\n{self._text}" if self._text else ""

    def get_state(self) -> entity_component.ComponentState:
        return {"text": self._text}

    def set_state(self, state: entity_component.ComponentState) -> None:
        self._text = str(state.get("text", ""))


class ObservationComponent(entity_component.ContextComponent):
    """Tracks only observations supplied from PostgreSQL for the current step."""

    def __init__(self, observations: list[str] | None = None, limit: int = 40):
        self._observations = list(observations or [])[-limit:]
        self._limit = limit

    def pre_observe(self, observation: str) -> str:
        self._observations.append(observation)
        self._observations = self._observations[-self._limit :]
        return observation

    def pre_act(self, action_spec: entity_lib.ActionSpec) -> str:
        del action_spec
        if not self._observations:
            return ""
        return "[이번 단계에서 관찰한 사건]\n" + "\n".join(self._observations)

    def get_state(self) -> entity_component.ComponentState:
        return {"observations": list(self._observations)}

    def set_state(self, state: entity_component.ComponentState) -> None:
        observations = state.get("observations", [])
        self._observations = [str(item) for item in observations][-self._limit :]


class BridgeActingComponent(entity_component.ActingComponent):
    """Delegates one structured action to Codex app-server through Node."""

    def __init__(self, bridge: ModelBridge, request: Mapping[str, Any]):
        self._bridge = bridge
        self._request = dict(request)
        self.last_runtime: dict[str, Any] = {}

    def get_action_attempt(
        self,
        context: entity_component.ComponentContextMapping,
        action_spec: entity_lib.ActionSpec,
    ) -> str:
        component_context = "\n\n".join(value for value in context.values() if value)
        request = {
            **self._request,
            "prompt": (
                f"{component_context}\n\n[CONCORDIA ACTION SPEC]\n"
                f"{action_spec.call_to_action}"
            ).strip(),
        }
        response = self._bridge.sample(request)
        self.last_runtime = dict(response.get("runtime") or {})
        return json.dumps(response["value"], ensure_ascii=False, separators=(",", ":"))

    def get_state(self) -> entity_component.ComponentState:
        return {"last_runtime": self.last_runtime}

    def set_state(self, state: entity_component.ComponentState) -> None:
        self.last_runtime = dict(state.get("last_runtime") or {})


class PassiveActingComponent(entity_component.ActingComponent):
    """An observer-only game master component used while a character acts."""

    def get_action_attempt(
        self,
        context: entity_component.ComponentContextMapping,
        action_spec: entity_lib.ActionSpec,
    ) -> str:
        del context, action_spec
        return ""

    def get_state(self) -> entity_component.ComponentState:
        return {}

    def set_state(self, state: entity_component.ComponentState) -> None:
        del state
