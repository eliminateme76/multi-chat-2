"""A bounded one-entity Concordia engine for a durable web progression step."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from concordia.environment import engine as engine_lib
from concordia.typing import entity as entity_lib


class SceneweaverSequentialEngine(engine_lib.Engine):
    """Runs exactly one actor action, leaving persistence to Sceneweaver."""

    def __init__(self, action_spec: entity_lib.ActionSpec):
        self._action_spec = action_spec
        self._acting_index = 0
        self._last_event = ""

    def make_observation(
        self, game_master: entity_lib.Entity, entity: entity_lib.Entity
    ) -> str:
        del game_master, entity
        return self._last_event

    def next_acting(
        self,
        game_master: entity_lib.Entity,
        entities: Sequence[entity_lib.Entity],
    ) -> tuple[entity_lib.Entity, entity_lib.ActionSpec]:
        del game_master
        if not entities:
            raise ValueError("Sceneweaver Concordia step requires one entity.")
        entity = entities[self._acting_index % len(entities)]
        self._acting_index += 1
        return entity, self._action_spec

    def resolve(self, game_master: entity_lib.Entity, event: str) -> None:
        self._last_event = event
        game_master.observe(event)

    def terminate(self, game_master: entity_lib.Entity) -> bool:
        del game_master
        return self._acting_index >= 1

    def next_game_master(
        self,
        game_master: entity_lib.Entity,
        game_masters: Sequence[entity_lib.Entity],
    ) -> entity_lib.Entity:
        return game_masters[0] if game_masters else game_master

    def run_loop(
        self,
        game_masters: Sequence[entity_lib.Entity],
        entities: Sequence[entity_lib.Entity],
        premise: str,
        max_steps: int,
        verbose: bool,
        log: list[Mapping[str, Any]] | None,
        checkpoint_callback=None,
        step_controller=None,
        step_callback=None,
    ) -> str:
        del verbose, step_controller
        if not game_masters:
            raise ValueError("Sceneweaver Concordia step requires a game master.")
        game_master = game_masters[0]
        if premise:
            for entity in entities:
                entity.observe(premise)
            game_master.observe(premise)
        result = ""
        for step in range(min(max_steps, 1)):
            actor, action_spec = self.next_acting(game_master, entities)
            result = actor.act(action_spec)
            self.resolve(game_master, result)
            if log is not None:
                log.append({"step": step, "actor": actor.name, "action": result})
            if checkpoint_callback:
                checkpoint_callback(step)
            if step_callback:
                step_callback({"step": step, "actor": actor.name})
            if self.terminate(game_master):
                break
        return result
