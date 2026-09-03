const nullableText = (value, label) => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label} 형식이 올바르지 않습니다.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > 100) throw new Error(`${label} 값이 너무 깁니다.`);
  return text;
};

const requiredText = (value, label) => {
  const text = nullableText(value, label);
  if (!text) throw new Error(`${label} 값이 필요합니다.`);
  return text;
};

const uuid = (value, label) => {
  const text = requiredText(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error(`${label} 값이 올바르지 않습니다.`);
  return text;
};

const pair = (input, label, { optional = false } = {}) => ({
  model: optional ? nullableText(input?.model, `${label} 모델`) : requiredText(input?.model, `${label} 모델`),
  reasoningEffort: optional ? nullableText(input?.reasoningEffort, `${label} 추론 수준`) : requiredText(input?.reasoningEffort, `${label} 추론 수준`)
});

function validatePair(catalog, model, effort, label) {
  const available = catalog.get(model);
  if (!available) throw new Error(`${label}에서 사용할 수 없는 모델입니다: ${model}`);
  if (!available.efforts.includes(effort)) throw new Error(`${label}: ${model}에서 ${effort} 추론 수준을 지원하지 않습니다.`);
}

export async function getRuntimeSettings(queryable, projectId) {
  const project = (await queryable.query(`SELECT id,default_model AS "characterModel",default_reasoning_effort AS "characterEffort",
    COALESCE(director_model,default_model) AS "directorModel",director_reasoning_effort AS "directorEffort",
    COALESCE(utility_model,default_model) AS "utilityModel",utility_reasoning_effort AS "utilityEffort",
    active_director_thread_id AS "directorThreadId" FROM projects WHERE id=$1`, [projectId])).rows[0];
  if (!project) return null;
  const characters = (await queryable.query(`SELECT id,name,active_thread_id AS "threadId",model_override AS "modelOverride",
    reasoning_effort_override AS "reasoningEffortOverride",COALESCE(model_override,$2) AS "effectiveModel",
    COALESCE(reasoning_effort_override,$3) AS "effectiveReasoningEffort"
    FROM characters WHERE project_id=$1 ORDER BY sort_order,name`, [projectId, project.characterModel, project.characterEffort])).rows;
  const worldBuilders = (await queryable.query(`SELECT id,COALESCE(NULLIF(draft_data->'world'->>'title',''),'이름 없는 초안') AS name,
    thread_id AS "threadId",model,reasoning_effort AS "reasoningEffort",updated_at AS "updatedAt"
    FROM world_creation_drafts WHERE source_project_id=$1 AND status='ACTIVE' ORDER BY updated_at DESC`, [projectId])).rows;
  return {
    projectId,
    project: {
      character: { name: '캐릭터 기본값', model: project.characterModel, reasoningEffort: project.characterEffort },
      director: { name: '월드 디렉터', threadId: project.directorThreadId, model: project.directorModel, reasoningEffort: project.directorEffort },
      utility: { name: '추천·보조 작업', model: project.utilityModel, reasoningEffort: project.utilityEffort }
    },
    characters,
    worldBuilders
  };
}

export async function updateRuntimeSettings(pool, projectId, input, models) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('AI 스레드 설정 형식이 올바르지 않습니다.');
  const catalog = new Map(models.map((model) => [model.id, model]));
  const projectInput = input.project || {};
  const characterDefault = pair(projectInput.character, '캐릭터 기본값');
  const director = pair(projectInput.director, '월드 디렉터');
  const utility = pair(projectInput.utility, '추천·보조 작업');
  validatePair(catalog, characterDefault.model, characterDefault.reasoningEffort, '캐릭터 기본값');
  validatePair(catalog, director.model, director.reasoningEffort, '월드 디렉터');
  validatePair(catalog, utility.model, utility.reasoningEffort, '추천·보조 작업');

  if (!Array.isArray(input.characters) || !Array.isArray(input.worldBuilders)) throw new Error('스레드별 설정 목록이 필요합니다.');
  const characters = input.characters.map((item, index) => {
    const id = uuid(item?.id, `캐릭터 ${index + 1} ID`);
    const override = pair({ model: item.modelOverride, reasoningEffort: item.reasoningEffortOverride }, `캐릭터 ${index + 1}`, { optional: true });
    validatePair(catalog, override.model || characterDefault.model, override.reasoningEffort || characterDefault.reasoningEffort, `캐릭터 ${index + 1}`);
    return { id, ...override };
  });
  const worldBuilders = input.worldBuilders.map((item, index) => {
    const id = uuid(item?.id, `월드 설계자 ${index + 1} ID`);
    const settings = pair(item, `월드 설계자 ${index + 1}`);
    validatePair(catalog, settings.model, settings.reasoningEffort, `월드 설계자 ${index + 1}`);
    return { id, ...settings };
  });
  if (new Set(characters.map((item) => item.id)).size !== characters.length) throw new Error('캐릭터 설정이 중복되었습니다.');
  if (new Set(worldBuilders.map((item) => item.id)).size !== worldBuilders.length) throw new Error('월드 설계자 설정이 중복되었습니다.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
    const current = await getRuntimeSettings(client, projectId);
    if (!current) throw new Error('Project not found.');
    const currentCharacterIds = new Set(current.characters.map((item) => item.id));
    const currentBuilderIds = new Set(current.worldBuilders.map((item) => item.id));
    if (characters.some((item) => !currentCharacterIds.has(item.id))) throw new Error('이 월드에 속하지 않은 캐릭터 설정이 포함되어 있습니다.');
    if (worldBuilders.some((item) => !currentBuilderIds.has(item.id))) throw new Error('활성 상태가 아니거나 다른 월드의 설계자 설정이 포함되어 있습니다.');
    if (characters.length !== current.characters.length || worldBuilders.length !== current.worldBuilders.length) throw new Error('설정 화면을 연 뒤 캐릭터나 월드 초안 목록이 변경되었습니다. 다시 열어 주세요.');

    await client.query(`UPDATE projects SET default_model=$2,default_reasoning_effort=$3,director_model=$4,director_reasoning_effort=$5,
      utility_model=$6,utility_reasoning_effort=$7,updated_at=NOW() WHERE id=$1`, [projectId, characterDefault.model, characterDefault.reasoningEffort, director.model, director.reasoningEffort, utility.model, utility.reasoningEffort]);
    for (const item of characters) await client.query(`UPDATE characters SET model_override=$2,reasoning_effort_override=$3,updated_at=NOW()
      WHERE id=$1 AND project_id=$4`, [item.id, item.model, item.reasoningEffort, projectId]);
    for (const item of [...worldBuilders].sort((a, b) => a.id.localeCompare(b.id))) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('world-draft:' || $1::text))", [item.id]);
      const result = await client.query(`UPDATE world_creation_drafts SET model=$2,reasoning_effort=$3,updated_at=NOW()
        WHERE id=$1 AND source_project_id=$4 AND status='ACTIVE'`, [item.id, item.model, item.reasoningEffort, projectId]);
      if (!result.rowCount) throw new Error('저장 중 월드 설계자 초안 상태가 변경되었습니다. 다시 열어 주세요.');
    }
    await client.query('COMMIT');
    return getRuntimeSettings(client, projectId);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
