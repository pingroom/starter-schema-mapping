import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}$/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key,index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length <= max && /^[\x20-\x7e]+$/.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


const compareId = (a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const safeInteger = value => Number.isSafeInteger(value) && !Object.is(value,-0);
const cellString = value => typeof value==='string' && value.isWellFormed() && [...value].length<=100 && !/[\p{Cc}\p{Cf}]/u.test(value);
const scalar = value => value===null || typeof value==='boolean' || safeInteger(value) || cellString(value);
const fieldId = value => word(value) && value.length<=12 && !['constructor','prototype','__proto__'].includes(value);
export function validateInput(input) {
  if (!keys(input,['mappingId','title','columns','rows','targets']) || !word(input.mappingId) || !line(input.title,60)
    || !Array.isArray(input.columns) || input.columns.length<1 || input.columns.length>5
    || !Array.isArray(input.targets) || input.targets.length<1 || input.targets.length>4
    || input.targets.length>input.columns.length
    || !Array.isArray(input.rows) || input.rows.length<1 || input.rows.length>50) throw new Error('Provide a bounded mapping manifest with source columns, a complete scalar table and required targets.');
  for (const [kind,fields] of [['source',input.columns],['target',input.targets]]) {
    const ids=new Set();
    for (const field of fields) {
      if (!keys(field,kind==='source'?['id','label']:['id','label','type','nullable']) || !fieldId(field.id) || ids.has(field.id) || !line(field.label,24)
        || kind==='target' && (!['string','integer','boolean'].includes(field.type) || typeof field.nullable!=='boolean')) throw new Error('Fields need unique safe IDs, bounded labels and exact target types.');
      ids.add(field.id);
    }
  }
  const sourceIds=input.columns.map(field=>field.id);
  for (const row of input.rows) if (!keys(row,sourceIds) || Object.values(row).some(value=>!scalar(value))) throw new Error('Every row needs the exact source keyset and bounded well-formed scalar values.');
  return {...structuredClone(input),columns:structuredClone(input.columns).sort(compareId),targets:structuredClone(input.targets).sort(compareId)};
}
export function validateConfig(config) {
  if (!keys(config,['participant']) || !keys(config.participant,['id','label']) || !isId(config.participant.id) || !line(config.participant.label,60)) throw new Error('Config requires an exact resolver UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => validateInput(input).targets;
export function parseMapping(text,sourceIds) {
  if (!Array.isArray(sourceIds) || sourceIds.length<1 || sourceIds.length>5 || sourceIds.some(id=>!fieldId(id)) || new Set(sourceIds).size!==sourceIds.length) throw new Error('Invalid source column IDs.');
  if (text==='Unknown') return {kind:'unknown',sourceId:null};
  if (text==='NoMatch') return {kind:'no_match',sourceId:null};
  if (typeof text!=='string' || !sourceIds.includes(text)) throw new Error('Answer with an exact listed source column ID, NoMatch or Unknown.');
  return {kind:'source',sourceId:text};
}
export function requestFor(rawInput,config,taskId,attemptId) {
  config=validateConfig(config);
  const input=validateInput(rawInput),target=input.targets.find(field=>field.id===taskId);
  if (!target || !isId(attemptId)) throw new Error('Invalid target or attempt.');
  const sources=input.columns.map(field=>`${field.id}: ${field.label}`).join('\n');
  const prompt=`${input.title}\nTarget ${target.id}: ${target.label} (${target.type}, null ${target.nullable?'allowed':'forbidden'}).\nSources:\n${sources}\nType its matching source ID, NoMatch if none matches, or Unknown if unsure. One source per target; no reuse.`;
  if (prompt.length>500) throw new Error('Mapping prompt exceeds 500 characters.');
  const key=`mapping-${attemptId}`;
  return {prompt,context:`Schema mapping ${hash(input).slice(0,20)}`,text_input:{placeholder:'Column ID, NoMatch or Unknown',max_length:60},
    responder_scope:'direct',target_user_id:config.participant.id,ttl:TTL,correlation_id:key,
    data:{input_hash:hash(input),task_id:taskId,source_ids:input.columns.map(field=>field.id),attempt_id:attemptId},idempotencyKey:key};
}
export function validateState(state,rawInput) {
  const input=validateInput(rawInput), tasks=tasksFor(input);
  if (!keys(state,['version','inputHash','config','room','credentialHash','startedAt','attempts']) || state.version!==1
    || state.inputHash!==hash(input) || typeof state.room!=='string' || !ROOM.test(state.room)
    || typeof state.credentialHash!=='string' || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length>tasks.length || iso(state.startedAt)!==state.startedAt) throw new Error('Invalid state or changed mapping manifest. Restore the original inputs.');
  validateConfig(state.config);
  const ids=new Set(),questionIds=new Set();let previous=state.startedAt,askerId;
  for (const [index,attempt] of state.attempts.entries()) {
    if (!keys(attempt,['id','taskId','createdAt','request','questionId','status','observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.taskId!==tasks[index].id || iso(attempt.createdAt)!==attempt.createdAt || attempt.createdAt<previous
      || hash(attempt.request)!==hash(requestFor(input,state.config,attempt.taskId,attempt.id))
      || !['creating','pending','answered','expired','cancelled','invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved mapping request.');
    ids.add(attempt.id);previous=attempt.createdAt;
    if (attempt.status==='creating') {
      if (attempt.questionId!==null || attempt.observation!==null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);validateObservation(attempt.observation,attempt.status,attempt.request);
      if (Date.parse(attempt.observation.createdAt)<Date.parse(attempt.createdAt)-CLOCK_SKEW_MS || attempt.observation.checkedAt<attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous=attempt.observation.checkedAt;
      if (askerId!==undefined && attempt.observation.askerId!==askerId) throw new Error('Questions belong to different asking registrations.');
      askerId=attempt.observation.askerId;
    }
    if (['creating','pending'].includes(attempt.status) && index!==state.attempts.length-1) throw new Error('Only the last task may have an active Question.');
  }
  return state;
}
const actualType = value => value===null?'null':typeof value==='number'?'integer':typeof value;
/** Deterministic transformation only; validated reports supply responder provenance. */
export function transform(rawInput,outcomes) {
  const input=validateInput(rawInput),sourceIds=input.columns.map(field=>field.id);
  if (!Array.isArray(outcomes) || outcomes.length!==input.targets.length || outcomes.some((outcome,index)=>!keys(outcome,['targetId','kind','sourceId'])
    || outcome.targetId!==input.targets[index].id || !['source','no_match','unknown','missing'].includes(outcome.kind)
    || (outcome.kind==='source' ? !sourceIds.includes(outcome.sourceId) : outcome.sourceId!==null))) throw new Error('Transformation requires one ordered mapping outcome for every target.');
  const mapping=outcomes.map(outcome=>({...outcome}));
  const unresolvedTargetIds=mapping.filter(item=>item.kind==='missing').map(item=>item.targetId);
  const noMatchTargetIds=mapping.filter(item=>item.kind==='no_match').map(item=>item.targetId);
  const unknownTargetIds=mapping.filter(item=>item.kind==='unknown').map(item=>item.targetId);
  const duplicateSources=sourceIds.flatMap(sourceId=>{
    const targetIds=mapping.filter(item=>item.sourceId===sourceId).map(item=>item.targetId);
    return targetIds.length>1?[{sourceId,targetIds}]:[];
  });
  const typeErrors=[];
  for (const [rowIndex,row] of input.rows.entries()) for (const [index,item] of mapping.entries()) {
    if (item.kind!=='source') continue;
    const target=input.targets[index],value=row[item.sourceId];
    const valid=value===null?target.nullable:actualType(value)===target.type;
    if (!valid) typeErrors.push({rowIndex,targetId:target.id,sourceId:item.sourceId,expectedType:target.type,nullable:target.nullable,actualType:actualType(value)});
  }
  const unusedSourceColumns=input.columns.filter(field=>!mapping.some(item=>item.sourceId===field.id));
  const status=unresolvedTargetIds.length?'incomplete':noMatchTargetIds.length?'no_match':unknownTargetIds.length?'unknown':duplicateSources.length?'conflict':typeErrors.length?'type_error':'complete';
  const mapped=status==='complete'?{mappingId:input.mappingId,inputHash:hash(input),schema:input.targets,
    mapping:mapping.map(({targetId,sourceId})=>({targetId,sourceId})),rows:input.rows.map(row=>Object.fromEntries(mapping.map(item=>[item.targetId,row[item.sourceId]]))),unusedSourceColumns,sourceWrites:false}:null;
  return {status,mapping,unresolvedTargetIds,noMatchTargetIds,unknownTargetIds,duplicateSources,typeErrors,unusedSourceColumns,mapped};
}
export function report(state,rawInput) {
  const input=validateInput(rawInput);validateState(state,input);
  const readings=tasksFor(input).map(target=>{
    const attempt=state.attempts.find(item=>item.taskId===target.id),answer=attempt?.observation?.answer;
    return {targetId:target.id,label:target.label,status:attempt?.status==='creating'?'create_unknown':attempt?.status??'unasked',
      text:answer?.text??null,sourceId:answer?.sourceId??null,kind:answer?.kind??null,questionId:attempt?.questionId??null,attemptId:attempt?.id??null,
      responderId:answer?.responderId??null,answeredAt:answer?.answeredAt??null,askerId:attempt?.observation?.askerId??null,observedAt:attempt?.observation?.checkedAt??null};
  });
  const calculation=transform(input,readings.map(({targetId,kind,sourceId})=>({targetId,kind:kind??'missing',sourceId})));
  const active=readings.find(item=>['create_unknown','pending'].includes(item.status));
  const status=active?.status??(readings.some(item=>item.status==='unasked')?'ready':calculation.status);
  return {mappingId:input.mappingId,title:input.title,inputHash:hash(input),participant:state.config.participant,readings,...calculation,status,sourceWrites:false};
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'sourceId', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseMapping(answer.text, request.data.source_ids)) !== hash({ kind: answer.kind, sourceId: answer.sourceId })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved mapping evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain mapping evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or resolver.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseMapping(answer.text, request.data.source_ids), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
