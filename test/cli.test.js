import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.env.PROBE_QUESTIONS;
const questions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Offline command attempted a request');
  const url = new URL(raw);
  assert.equal(url.origin, 'https://api.pingroom.io');
  assert.equal(init.redirect, 'manual');
  if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json([{ invite_code: 'DEMO12345678', type: 'standard', is_public: false, members: [{ user_id: '11111111-1111-4111-8111-111111111111' }] }]);
  if (init.method === 'POST' && url.pathname === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    assert.equal(body.options, undefined);
    assert.deepEqual(body.text_input, {placeholder:'Column ID, NoMatch or Unknown',max_length:60});
    assert.equal(new Headers(init.headers).get('idempotency-key'), body.correlation_id);
    const id = '01990000-0000-7000-8000-' + String(Object.keys(questions).length + 1).padStart(12, '0');
    const q = { ...body, id, kind: 'question', is_handoff: false, resolution_policy: 'first', room_code: 'DEMO12345678', room: { code: 'DEMO12345678' },
      asker: { type: 'agent', id: '33333333-3333-4333-8333-333333333333' }, results: null, options: [],
      state: 'pending', created_at: now, expires_at: new Date(Date.parse(now) + 900000).toISOString(), resolved_at: null, answer: null, reply_to: null };
    questions[id] = q; writeFileSync(file, JSON.stringify(questions));
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost creation response');
    return Response.json(q, { status: 201 });
  }
  if (init.method === 'GET' && url.pathname === '/api/agent/questions') return Response.json({questions:Object.values(questions)});
  if (init.method === 'GET' && url.pathname.startsWith('/api/agent/questions/')) {
    const q = questions[url.pathname.split('/').at(-1)];
    if (!q) throw new Error('Unexpected Question');
    if (process.env.PROBE_ANSWER !== undefined) {
      q.state = 'answered'; q.resolved_at = new Date().toISOString();
      q.answer = { value:null, label:null, text:process.env.PROBE_ANSWER, responder:{id:q.target_user_id}, answered_at:q.resolved_at };
    } else if (process.env.PROBE_CANCEL === 'yes') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); }
    writeFileSync(file, JSON.stringify(questions)); return Response.json(q);
  }
  throw new Error('Unexpected mocked request');
};
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mapping-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await cp(join(source, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  await cp(join(source, 'examples/mapping.json'), join(directory, 'mapping.json'));
  return directory;
}
function run(directory, command = ['run'], extra = {}) {
  const env = { ...process.env, PINGROOM_TOKEN: 'offline-fixture', PINGROOM_ROOM: 'DEMO12345678', PROBE_QUESTIONS: join(directory, 'questions.json') };
  for (const key of ['NODE_OPTIONS','PROBE_ANSWER','PROBE_CANCEL','PROBE_LOST','PROBE_OFFLINE']) delete env[key];
  Object.assign(env,extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), ...command], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function collect(directory, values) {
  let answer;
  for(const [i,value] of values.entries()) {
    const pending=await run(directory);assert.equal(pending.code,3,pending.stderr);assert.equal(JSON.parse(pending.stdout).status,'pending');
    answer=await run(directory,['run'],{PROBE_ANSWER:value});
    if(i<values.length-1)assert.equal(answer.code,3,answer.stderr);
  }
  return answer;
}

test('CLI collects exact mappings from another directory and exports a complete private table offline without editing source', async t => {
  const directory=await fixture(t),before=await readFile(join(directory,'mapping.json'),'utf8');
  const validation=await run(directory,['validate'],{PROBE_OFFLINE:'yes'});assert.equal(validation.code,0,validation.stderr);
  assert.equal(JSON.parse(validation.stdout).targets.length,3);assert.equal(JSON.parse(validation.stdout).rowCount,2);
  const finished=await collect(directory,['live','caption','qty']);assert.equal(finished.code,0,finished.stderr);assert.equal(JSON.parse(finished.stdout).status,'complete');
  for(const command of ['status','report','export']) {
    const result=await run(directory,[command],{PROBE_OFFLINE:'yes'});assert.equal(result.code,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).mapped.rows,[{active:true,name:'Paper clips',quantity:24},{active:false,name:'Label rolls',quantity:0}]);
  }
  const artifact=JSON.parse(await readFile(join(directory,'.schema-mapping/mapped.json'),'utf8'));
  assert.deepEqual(artifact,JSON.parse(finished.stdout).mapped);assert.match(artifact.inputHash,/^[a-f0-9]{64}$/);
  for(const name of ['mapped.json','report.json'])assert.equal((await stat(join(directory,'.schema-mapping',name))).mode&0o777,0o600);
  assert.equal(await readFile(join(directory,'mapping.json'),'utf8'),before);
  const questions=JSON.parse(await readFile(join(directory,'questions.json'),'utf8'));assert.equal(Object.keys(questions).length,3);
  assert.deepEqual(Object.values(questions).map(q=>q.data.task_id),['active','name','quantity']);
});

test('CLI uncertain create stays blocked and recovers the exact original Question without resend', async t => {
  const directory=await fixture(t);assert.equal((await run(directory,['run'],{PROBE_LOST:'yes'})).code,4);
  assert.equal((await run(directory)).code,4);
  const found=await run(directory,['find']);assert.equal(found.code,4,found.stderr);
  const questionId=JSON.parse(found.stdout).candidates[0].id;
  const recovered=await run(directory,['recover',questionId],{PROBE_ANSWER:'live'});assert.equal(recovered.code,3,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).status,'ready');
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,1);
  assert.equal((await run(directory,['recover','not-a-uuid'])).code,1);
});

test('CLI diagnostic outcomes retain distinct statuses and offline export refuses partial tables', async t => {
  for(const [values,status] of [[['live','NoMatch','qty'],'no_match'],[['live','Unknown','qty'],'unknown'],[['live','caption','caption'],'conflict'],[['live','qty','caption'],'type_error']]) {
    const directory=await fixture(t),result=await collect(directory,values);
    assert.equal(result.code,2,result.stderr);assert.equal(JSON.parse(result.stdout).status,status);assert.equal(JSON.parse(result.stdout).mapped,null);
    const saved=await run(directory,['report'],{PROBE_OFFLINE:'yes'});assert.equal(saved.code,0,saved.stderr);assert.equal(JSON.parse(saved.stdout).mapped,null);
    assert.equal((await run(directory,['export'],{PROBE_OFFLINE:'yes'})).code,1);
    await assert.rejects(stat(join(directory,'.schema-mapping/mapped.json')));
  }
});

test('CLI cancellation and invalid normalized mapping answers fail even with later targets remaining', async t => {
  for(const extra of [{PROBE_CANCEL:'yes'},{PROBE_ANSWER:'Live'},{PROBE_ANSWER:' live '},{PROBE_ANSWER:'other'}]) {
    const directory=await fixture(t);await run(directory);
    const result=await run(directory,['run'],extra);assert.equal(result.code,2,result.stderr);assert.equal(JSON.parse(result.stdout).status,'ready');assert.equal(JSON.parse(result.stdout).mapped,null);
  }
});

test('CLI rejects blank environment credentials, impossible manifest and export before collecting', async t => {
  const directory=await fixture(t);
  assert.equal((await run(directory,['export'],{PROBE_OFFLINE:'yes'})).code,1);
  for(const extra of [{PINGROOM_TOKEN:''},{PINGROOM_ROOM:''},{PINGROOM_TOKEN:'has whitespace'}]) {
    const result=await run(directory,['run'],extra);assert.equal(result.code,1);assert.equal(result.stdout,'');assert.equal(result.stderr.includes('has whitespace'),false);
  }
  const input=JSON.parse(await readFile(join(directory,'mapping.json'),'utf8'));input.columns=input.columns.slice(0,1);input.rows=[{caption:'Example'}];
  await writeFile(join(directory,'mapping.json'),JSON.stringify(input));assert.equal((await run(directory,['run'],{PROBE_OFFLINE:'yes'})).code,1);
  await assert.rejects(stat(join(directory,'questions.json')));
});
