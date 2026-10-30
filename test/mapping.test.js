import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport } from '../src/engine.js';
import { readJson, atomicJson, acquireLock } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseMapping, transform, requestFor, validateConfig, hash, iso } from '../src/model.js';
import { loadConnection, loadEnvironment } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/mapping.json', import.meta.url), 65536);
const simple = () => ({ ...structuredClone(example), targets: structuredClone(example.targets.slice(0,2)) });
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-mapping-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.readings.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later mappings; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'live'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a mapping', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'live'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.mapped, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across mappings', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'live'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).mapped, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'live');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'live'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'live'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing resolver before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'live');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'live'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).mapped, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});

const outcomesFor = (input,values) => validateInput(input).targets.map((field,i)=>({targetId:field.id,...parseMapping(values[i],input.columns.map(column=>column.id))}));
const mapped = (input,values) => transform(input,outcomesFor(input,values));
const inputFor = (rows,targets) => ({mappingId:'test-table',title:'Column mapping',columns:Object.keys(rows[0]).map(id=>({id,label:id})),rows,targets});
const field = (id,type,nullable=false) => ({id,label:id,type,nullable});

test('only exact normalized source IDs and the two exact sentinels are accepted', () => {
  assert.deepEqual(parseMapping('caption',['caption']),{kind:'source',sourceId:'caption'});
  assert.deepEqual(parseMapping('Unknown',['caption']),{kind:'unknown',sourceId:null});
  assert.deepEqual(parseMapping('NoMatch',['caption']),{kind:'no_match',sourceId:null});
  for(const text of ['Caption','caption ',' caption','CAPTION','unknown','nomatch','No Match','',null,1,'constructor','other','caption\n'])assert.throws(()=>parseMapping(text,['caption']));
  for(const ids of [[],['a','a'],['constructor'],['a'.repeat(13)]])assert.throws(()=>parseMapping('Unknown',ids));
});

test('real SDK mock resolves semantics, preserves row order and produces complete private export offline', async t => {
  const s=await setup(t,example),result=await decide(s,['live','caption','qty']);
  assert.equal(result.status,'complete');assert.equal(result.sourceWrites,false);
  assert.deepEqual(result.mapped.rows,[{active:true,name:'Paper clips',quantity:24},{active:false,name:'Label rolls',quantity:0}]);
  assert.deepEqual(result.mapped.unusedSourceColumns,[{id:'notes',label:'Internal note'}]);
  assert.deepEqual(result.mapped.mapping,[{targetId:'active',sourceId:'live'},{targetId:'name',sourceId:'caption'},{targetId:'quantity',sourceId:'qty'}]);
  for(const reading of result.readings){assert.equal(reading.responderId,CONFIG.participant.id);assert.equal(reading.askerId,ASKER);assert.ok(reading.answeredAt);assert.ok(reading.observedAt);}
  const calls=s.api.calls.length;assert.deepEqual((await s.run()).mapped,result.mapped);assert.equal(s.api.calls.length,calls);assert.equal(sends(s.api),3);
  assert.deepEqual((await localReport(s.directory,example,{exportMapped:true})).mapped,result.mapped);
  assert.deepEqual(await readJson(join(s.directory,'mapped.json')),result.mapped);assert.equal(s.api.calls.length,calls);
  assert.equal((await stat(join(s.directory,'mapped.json'))).mode&0o777,0o600);assert.equal((await stat(s.directory)).mode&0o777,0o700);
});

test('strings, whitespace, Unicode, nulls, false, zero and safe integer extremes retain their exact values', () => {
  const input=inputFor([
    {text:'',number:0,bool:false,optional:null},
    {text:'  padded value  ',number:Number.MAX_SAFE_INTEGER,bool:true,optional:'🙂e\u0301'},
    {text:'é',number:Number.MIN_SAFE_INTEGER,bool:false,optional:''},
  ],[field('a','string'),field('b','integer'),field('c','boolean'),field('d','string',true)]);
  const before=structuredClone(input),result=mapped(input,['text','number','bool','optional']);
  assert.equal(result.status,'complete');assert.deepEqual(result.mapped.rows,[
    {a:'',b:0,c:false,d:null},{a:'  padded value  ',b:Number.MAX_SAFE_INTEGER,c:true,d:'🙂e\u0301'},{a:'é',b:Number.MIN_SAFE_INTEGER,c:false,d:''},
  ]);assert.deepEqual(input,before);
});

test('null is a present nullable value; missing keys are invalid and every required target still needs a source', () => {
  const input=inputFor([{a:null,b:'value'}],[field('x','integer',true)]);
  assert.equal(mapped(input,['a']).status,'complete');
  assert.equal(mapped(input,['NoMatch']).status,'no_match');assert.equal(mapped(input,['NoMatch']).mapped,null);
  const absent=structuredClone(input);delete absent.rows[0].a;assert.throws(()=>validateInput(absent),/exact source keyset/);
  input.targets[0].nullable=false;assert.equal(mapped(input,['a']).status,'type_error');
});

test('all cells are checked, without coercion or first-row-only inference', () => {
  const input=inputFor([{a:1,b:'1',c:true},{a:null,b:'2',c:false},{a:'3',b:'3',c:true}],[field('x','integer')]);
  const result=mapped(input,['a']);assert.equal(result.status,'type_error');assert.equal(result.mapped,null);
  assert.deepEqual(result.typeErrors.map(error=>[error.rowIndex,error.actualType]),[[1,'null'],[2,'string']]);
  assert.equal(mapped(input,['b']).typeErrors.length,3);assert.equal(mapped(input,['c']).typeErrors.length,3);
  input.targets[0].nullable=true;assert.deepEqual(mapped(input,['a']).typeErrors.map(error=>error.rowIndex),[2]);
});

test('source reuse is a conflict even when every value satisfies both target types', () => {
  const input=inputFor([{a:'same',b:'spare'}],[field('x','string'),field('y','string')]),result=mapped(input,['a','a']);
  assert.equal(result.status,'conflict');assert.deepEqual(result.typeErrors,[]);assert.equal(result.mapped,null);
  assert.deepEqual(result.duplicateSources,[{sourceId:'a',targetIds:['x','y']}]);
});

test('NoMatch, Unknown, collision and type errors remain distinct and never export a partial table', async t => {
  for(const [values,status] of [[['live','NoMatch','qty'],'no_match'],[['live','Unknown','qty'],'unknown'],[['live','caption','caption'],'conflict'],[['live','qty','caption'],'type_error']]) {
    const s=await setup(t,example),result=await decide(s,values);assert.equal(result.status,status);assert.equal(result.mapped,null);
    await assert.rejects(localReport(s.directory,example,{exportMapped:true}),/complete/);assert.equal(await readJson(join(s.directory,'mapped.json')),null);
    assert.equal(sends(s.api),3);assert.equal((await localReport(s.directory,example,{save:true})).mapped,null);
  }
  const input=inputFor([{a:1,b:2,c:3,d:4}],[field('w','string'),field('x','string'),field('y','string'),field('z','string')]);
  const result=mapped(input,['a','a','NoMatch','Unknown']);assert.equal(result.status,'no_match');
  assert.equal(result.duplicateSources.length,1);assert.equal(result.typeErrors.length,2);assert.deepEqual(result.noMatchTargetIds,['y']);assert.deepEqual(result.unknownTargetIds,['z']);
});

test('independent exhaustive mapping oracle agrees on all 729 two-target source/value combinations', () => {
  const values=[false,0,''];let cases=0;
  for(const a of values)for(const b of values)for(const c of values)for(const left of ['a','b','c'])for(const right of ['a','b','c'])for(const type of ['boolean','integer','string']) {
    const input=inputFor([{a,b,c},{a,b,c}],[field('x',type),field('y',type)]),result=mapped(input,[left,right]);
    const expected=left!==right && [input.rows[0][left],input.rows[0][right]].every(value=>typeof value===(type==='integer'?'number':type));
    assert.equal(result.status==='complete',expected);assert.equal(result.mapped!==null,expected);
    if(expected)assert.deepEqual(result.mapped.rows,input.rows.map(row=>({x:row[left],y:row[right]})));
    cases++;
  }
  assert.equal(cases,729);
});

test('canonical field ordering ignores array/key order but keeps source row order immutable', async t => {
  const input=structuredClone(example),reordered=structuredClone(input);reordered.columns.reverse();reordered.targets.reverse();
  reordered.rows=reordered.rows.map(row=>Object.fromEntries(Object.entries(row).reverse()));
  assert.equal(hash(validateInput(input)),hash(validateInput(reordered)));assert.deepEqual(mapped(input,['live','caption','qty']),mapped(reordered,['live','caption','qty']));
  const s=await setup(t,input);await s.run();const state=await s.saved();assert.doesNotThrow(()=>validateState(state,reordered));
  reordered.rows.reverse();assert.throws(()=>validateState(state,reordered),/changed mapping manifest/);
});

test('maximum manifest fits bounded file reads and at most four maximum-sized prompts', async t => {
  const columns=Array.from({length:5},(_,i)=>({id:`s${String(i).repeat(11)}`,label:'L'.repeat(24)}));
  const input={mappingId:'m'.repeat(40),title:'T'.repeat(60),columns,rows:Array.from({length:50},()=>Object.fromEntries(columns.map(column=>[column.id,'🙂'.repeat(100)]))),
    targets:Array.from({length:4},(_,i)=>({id:`t${String(i).repeat(11)}`,label:'L'.repeat(24),type:'string',nullable:false}))};
  const text=JSON.stringify(input,null,2);assert.ok(Buffer.byteLength(text)<128*1024);
  const s=await setup(t,input);await writeFile(join(s.directory,'input.json'),text);assert.deepEqual(validateInput(await readJson(join(s.directory,'input.json'),128*1024)),validateInput(input));
  for(const task of tasksFor(input)){const request=requestFor(input,CONFIG,task.id,id(20));assert.ok(request.prompt.length<=500);assert.ok(request.context.length<=40);assert.equal(request.options,undefined);assert.equal(request.text_input.max_length,60);assert.equal(request.data.source_ids.length,5);}
  const result=await decide(s,columns.slice(0,4).map(column=>column.id));assert.equal(result.status,'complete');assert.equal(result.mapped.rows.length,50);assert.equal(sends(s.api),4);
  await localReport(s.directory,input,{exportMapped:true});assert.equal((await readJson(join(s.directory,'mapped.json'))).rows[49].t33333333333,'🙂'.repeat(100));
  const calls=s.api.calls.length;await s.run();assert.equal(s.api.calls.length,calls);
});

test('manifest rejects malformed scalars, unsafe/reserved IDs, extra keys and impossible target counts before network', async t => {
  const invalids=[
    x=>{x.rows=[];},x=>{x.rows=Array.from({length:51},()=>x.rows[0]);},x=>{x.rows[0].extra=1;},x=>{delete x.rows[0].notes;},
    x=>{x.rows[0].qty=-0;},x=>{x.rows[0].qty=Number.MAX_SAFE_INTEGER+1;},x=>{x.rows[0].qty=1.5;},x=>{x.rows[0].qty=Infinity;},x=>{x.rows[0].qty=NaN;},
    x=>{x.rows[0].caption='x'.repeat(101);},x=>{x.rows[0].caption='a\n';},x=>{x.rows[0].caption='\u0000';},x=>{x.rows[0].caption='\u200d';},x=>{x.rows[0].caption='\ud800';},
    x=>{x.rows[0].caption={};},x=>{x.rows[0].caption=[];},x=>{x.rows[0].caption=undefined;},x=>{x.rows[0].caption=1n;},
    x=>{x.columns.push({...x.columns[0]});},x=>{x.columns[0].id='constructor';},x=>{x.columns[0].id='prototype';},x=>{x.columns[0].id='__proto__';},
    x=>{x.columns[0].id='a'.repeat(13);},x=>{x.columns[0].id='Unknown';},x=>{x.columns[0].label='x'.repeat(25);},x=>{x.title=' x';},
    x=>{x.targets[0].nullable='true';},x=>{x.targets[0].type='number';},x=>{x.targets.push({...x.targets[0]});},x=>{x.targets[0].id='constructor';},
    x=>{x.columns=x.columns.slice(0,1);x.rows=[{caption:'ok'}];},x=>{x.targets=[];},x=>{x.targets=Array.from({length:5},(_,i)=>field(`t${i}`,'string'));},
  ];
  for(const mutate of invalids){const input=structuredClone(example);mutate(input);assert.throws(()=>validateInput(input));}
  const s=await setup(t);const input=structuredClone(example);input.columns=input.columns.slice(0,1);input.rows=[{caption:'ok'}];
  await assert.rejects(s.run({input}));assert.equal(s.api.calls.length,0);
  assert.throws(()=>requestFor(example,{participant:{id:'name',label:'Resolver'}},'active',id(1)));
});

test('mapping evidence, source whitelist and checked time cannot be altered or regressed on replay', async t => {
  const s=await setup(t,example);await s.run();s.api.answer(id(1),'live');await s.run();const original=await s.saved();
  for(const mutate of [x=>{x.attempts[0].observation.answer.sourceId='caption';},x=>{x.attempts[0].observation.answer.kind='unknown';},x=>{x.attempts[0].request.data.source_ids=['live'];}]) {
    const state=structuredClone(original);mutate(state);assert.throws(()=>validateState(state,example));
  }
  const p=await setup(t);await p.run();p.clock.value='2026-01-01T09:00:30.000Z';await p.run();p.clock.value='2026-01-01T09:00:20.000Z';await assert.rejects(p.run(),/regressed/);
  const another=await setup(t,example);await decide(another,['live','caption']);another.clock.value='2026-01-01T08:59:59.000Z';
  await assert.rejects(another.run(),/saved mapping request/);assert.equal(sends(another.api),2);
});

test('export requires complete evidence, honors locks and never overwrites an existing artifact on failure', async t => {
  const s=await setup(t,example);await assert.rejects(localReport(s.directory,example,{exportMapped:true}),/No complete/);
  await decide(s,['live','Unknown','qty']);await atomicJson(s.directory,'mapped.json',{prior:'preserved'});
  await assert.rejects(localReport(s.directory,example,{exportMapped:true}),/complete/);assert.deepEqual(await readJson(join(s.directory,'mapped.json')),{prior:'preserved'});
  const release=await acquireLock(s.directory);await assert.rejects(localReport(s.directory,example,{exportMapped:true}),/lock exists/);await release();
});


test('exact keysets reject comma-merged keys in source rows and root manifests', () => {
  const input=inputFor([{a:'valid',b:1,c:true}],[field('x','string')]);
  input.rows=[{a:'valid','b,c':'x'}];assert.throws(()=>validateInput(input),/exact source keyset/);
  const malformed=structuredClone(example);delete malformed.columns;delete malformed.mappingId;malformed['columns,mappingId']='merged';assert.throws(()=>validateInput(malformed));
  const reordered=structuredClone(example);reordered.rows[0]={'caption,live':'merged',qty:24,notes:null};assert.throws(()=>validateInput(reordered));
});
