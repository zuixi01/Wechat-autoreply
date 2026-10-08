import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { request as secureRequest } from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { checkReleaseEmployeeConnection } from './server-employee-connection.mjs'
import { checkReleaseAdminDeployment } from './server-admin-release.mjs'
import { checkReleaseWindowsDeviceConnection } from './server-windows-device-connection.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(
    'Usage: node scripts/check-server-release.mjs --release PATH\n' +
      'Installs locked production dependencies, checks actual release entrypoints and starts an isolated PostgreSQL 16/loopback service. No model credentials, customer data or client operations.\n'
  )
  process.exit(0)
}
if (args.length !== 2 || args[0] !== '--release' || !args[1]?.trim())
  throw new Error('server_release_arguments_invalid')

const id = randomUUID(),
  suffix = id.replaceAll('-', ''),
  containerName = `autoreply-server-release-${id}`,
  databaseName = `autoreply_release_${suffix}`,
  serviceLogin = `release_service_${suffix}`,
  rejectedLogin = `release_admin_${suffix}`,
  wrongLogin = `release_wrong_${suffix}`,
  mixedWorkerLogin = `release_mixed_worker_${suffix}`,
  mixedReviewerLogin = `release_mixed_reviewer_${suffix}`,
  noInheritLogin = `release_noinherit_${suffix}`,
  label = 'autoreply.server-release-test',
  image = 'postgres:16',
  reportDirectory = join(root, '.local', 'reports', 'server-release', id)
const report = {
  id,
  image,
  startedAt: new Date().toISOString(),
  passed: false,
  cleanedUp: false,
  modelsCalled: false,
  clientOperations: false,
  productionReady: false,
  checks: []
}
await mkdir(reportDirectory, { recursive: true })

// Never inherit model/database credentials, worker URLs, NODE_OPTIONS or NODE_PATH.
const environment = Object.fromEntries(
  [
    'PATH',
    'Path',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'windir',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemDrive',
    'HOME'
  ]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]])
)
const children = new Map()
let operator,
  serviceDatabase,
  release,
  containerAttempted = false

function fail(code) {
  throw new Error(code)
}
function check(condition, code) {
  if (!condition) fail(code)
}
function recorded(name, details = {}) {
  report.checks.push({ name, passed: true, ...details })
}

/** Capture all child output privately. Never serialize process/driver errors. */
function launch(executable, parameters, options = {}) {
  const started = performance.now()
  const child = spawn(executable, parameters, {
    cwd: options.cwd ?? root,
    env: options.env ?? environment,
    windowsHide: true,
    stdio: options.ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = '',
    settled = false,
    failure = null
  const result = new Promise((accept) => {
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      children.delete(child)
      accept({
        ...value,
        failure: failure ?? value.failure,
        stdout,
        stderr,
        elapsedMs: Math.round(performance.now() - started)
      })
    }
    const capture = (target) => (chunk) => {
      if (target === 'stdout') stdout += chunk.toString('utf8')
      else stderr += chunk.toString('utf8')
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1048576) {
        failure = 'child_output_limit'
        child.kill('SIGKILL')
      }
    }
    child.stdout.on('data', capture('stdout'))
    child.stderr.on('data', capture('stderr'))
    child.once('error', () => {
      failure = 'child_unavailable'
    })
    child.once('close', (code, signal) => finish({ code, signal, failure: null }))
    const timer = setTimeout(() => {
      failure = 'child_timeout'
      child.kill('SIGKILL')
    }, options.timeout ?? 10000)
  })
  children.set(child, result)
  return { child, result }
}
async function command(executable, parameters, options = {}) {
  const result = await launch(executable, parameters, options).result
  if (result.failure || result.code !== (options.expectedCode ?? 0)) {
    const executableName = basename(executable)
    const entrypoint = parameters
      .map((parameter) => basename(parameter))
      .find((name) =>
        [
          'npm-cli.js',
          'index.js',
          'admin.js',
          'admin-server.js',
          'server-check.js',
          'jev-replay.js'
        ].includes(name)
      )
    const dockerPhase = ['version', 'image', 'run', 'inspect', 'rm', 'ps'].includes(parameters[0])
      ? parameters[0]
      : undefined
    report.commandFailure = {
      executable: ['node.exe', 'node', 'docker', 'docker.exe'].includes(executableName)
        ? executableName
        : 'other',
      phase: options.phase ?? entrypoint ?? dockerPhase ?? 'inline_node',
      expectedExitCode: options.expectedCode ?? 0,
      actualExitCode: result.code,
      signal:
        typeof result.signal === 'string' && /^SIG[A-Z]+$/.test(result.signal)
          ? result.signal
          : null,
      failure: result.failure,
      elapsedMs: result.elapsedMs
    }
    fail('release_command_failed')
  }
  return result
}
async function pause() {
  await new Promise((accept) => setTimeout(accept, 100))
}
async function bounded(operation, deadline, code) {
  const expires = Date.now() + deadline
  while (Date.now() < expires) {
    if (await operation()) return
    await pause()
  }
  fail(code)
}
async function freePort() {
  const server = createServer()
  await new Promise((accept, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', accept)
  })
  const port = server.address().port
  await new Promise((accept, reject) => server.close((error) => (error ? reject(error) : accept())))
  check(port >= 1024, 'release_port_invalid')
  return port
}
async function request(port, path, origin) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    redirect: 'error',
    signal: AbortSignal.timeout(700),
    headers: origin ? { Origin: origin } : {}
  })
  const body = await response.text()
  check(Buffer.byteLength(body) <= 8192, 'release_response_limit')
  return { status: response.status, body: JSON.parse(body) }
}
async function requestTls(port, path, certificate, origin) {
  return new Promise((accept, reject) => {
    const outgoing = secureRequest(
      `https://127.0.0.1:${port}${path}`,
      {
        ca: certificate,
        agent: false,
        signal: AbortSignal.timeout(700),
        headers: origin ? { Origin: origin } : {}
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > 8192) {
            response.destroy(new Error('release_response_limit'))
            return
          }
          chunks.push(chunk)
        })
        response.once('error', reject)
        response.once('end', () => {
          try {
            accept({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
            })
          } catch {
            reject(new Error('release_response_invalid'))
          }
        })
      }
    )
    outgoing.once('error', reject)
    outgoing.end()
  })
}
async function file(path) {
  const info = await lstat(path)
  check(info.isFile() && !info.isSymbolicLink(), 'release_file_invalid')
}
async function isolateRelease(source) {
  const manifestPath = join(source, 'release-manifest.json')
  await file(manifestPath)
  const manifestBytes = await readFile(manifestPath),
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  check(
    manifest.schemaVersion === 1 &&
      manifest.kind === 'server-deployment-candidate' &&
      Array.isArray(manifest.files) &&
      manifest.files.length > 0 &&
      manifest.files.length <= 5000,
    'release_manifest_invalid'
  )
  const expected = new Set(['release-manifest.json'])
  for (const entry of manifest.files) {
    check(
      typeof entry.path === 'string' &&
        /^[A-Za-z0-9._/-]+$/.test(entry.path) &&
        entry.path
          .split('/')
          .every((part) => part && part !== '.' && part !== '..' && part !== 'node_modules') &&
        !expected.has(entry.path) &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0 &&
        entry.bytes <= 33554432 &&
        typeof entry.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(entry.sha256),
      'release_manifest_entry_invalid'
    )
    expected.add(entry.path)
  }
  const walk = async (directory, prefix = '') => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' && entry.isDirectory()) continue
      check(!entry.isSymbolicLink(), 'release_file_invalid')
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(directory, entry.name), path)
      else check(entry.isFile() && expected.has(path), 'release_unmanifested_file')
    }
  }
  await walk(source)
  const isolated = await mkdtemp(join(tmpdir(), 'autoreply-server-release-check-'))
  report.isolatedDirectory = isolated
  for (let ancestor = dirname(isolated); ; ) {
    check(
      !(await lstat(join(ancestor, 'node_modules')).catch(() => undefined)),
      'release_ancestor_dependencies_present'
    )
    const next = dirname(ancestor)
    if (next === ancestor) break
    ancestor = next
  }
  for (const entry of manifest.files) {
    const original = join(source, entry.path)
    await file(original)
    check(
      (await realpath(original)).toLowerCase() === original.toLowerCase(),
      'release_file_invalid'
    )
    const bytes = await readFile(original)
    check(
      bytes.length === entry.bytes &&
        createHash('sha256').update(bytes).digest('hex') === entry.sha256,
      'release_manifest_hash_mismatch'
    )
    const target = join(isolated, entry.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: 'wx' })
  }
  await writeFile(join(isolated, 'release-manifest.json'), manifestBytes, { flag: 'wx' })
  report.manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
  recorded('manifest_verified_isolated_copy', {
    files: manifest.files.length,
    sourceNodeModulesCopied: false,
    ancestorNodeModulesAbsent: true
  })
  return isolated
}

try {
  const absolute = resolve(root, args[1])
  const source = await realpath(absolute)
  check(
    source.toLowerCase() === absolute.toLowerCase() && !(await lstat(absolute)).isSymbolicLink(),
    'release_directory_invalid'
  )
  report.sourceRelease = source
  release = await isolateRelease(source)
  const entrypoints = {
    start: 'server/src/index.js',
    admin: 'server/scripts/admin.js',
    'admin:serve': 'server/scripts/admin-server.js',
    check: 'server/scripts/server-check.js',
    'eval:jev': 'server/scripts/jev-replay.js'
  }
  for (const path of ['package.json', 'package-lock.json', ...Object.values(entrypoints)])
    await file(join(release, path))
  const manifest = JSON.parse(await readFile(join(release, 'package.json'), 'utf8'))
  check(manifest.type === 'module', 'release_package_invalid')
  for (const [name, path] of Object.entries(entrypoints))
    check(manifest.scripts?.[name] === `node ${path}`, 'release_entrypoint_invalid')
  check(
    Object.keys(manifest.dependencies ?? {}).length > 0 &&
      !Object.keys(manifest.dependencies).some((name) => /^(electron|tsx|typescript)$/.test(name)),
    'release_dependencies_invalid'
  )
  const npm = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  await file(npm)
  await command(
    process.execPath,
    [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: release, timeout: 180000 }
  )
  const inventory = await command(process.execPath, [npm, 'ls', '--omit=dev', '--json'], {
    cwd: release,
    timeout: 30000
  })
  const installed = JSON.parse(inventory.stdout)
  check(!installed.problems?.length, 'release_dependencies_unresolved')
  for (const name of ['electron', 'tsx', 'typescript'])
    check(
      !(await lstat(join(release, 'node_modules', name)).catch(() => undefined)),
      'release_dev_dependency_present'
    )
  recorded('locked_production_install', {
    directDependencies: Object.keys(installed.dependencies ?? {}).sort()
  })

  // Import the actual release modules without TS loaders or repository source paths.
  const emptyConfiguration = await command(process.execPath, [entrypoints.start], {
    cwd: release,
    phase: 'empty_configuration',
    expectedCode: 1,
    timeout: 4000
  })
  recorded('empty_configuration_rejected', { elapsedMs: emptyConfiguration.elapsedMs })
  for (const name of ['admin', 'eval:jev']) {
    const result = await command(process.execPath, [entrypoints[name], '--help'], {
      cwd: release,
      timeout: 4000
    })
    check(
      result.stdout.includes(name === 'admin' ? 'generator-version' : 'review-submit'),
      'release_help_invalid'
    )
    if (name === 'eval:jev')
      check(
        result.stdout.includes('eval:jev calibrate --tenant') &&
          result.stdout.includes('eval:jev declare --tenant') &&
          result.stdout.includes('eval:jev freeze-holdout --tenant') &&
          result.stdout.includes('eval:jev verify-holdout --tenant'),
        'release_calibration_help_invalid'
      )
    recorded(`${name}_help`)
  }
  const localConfiguration = {
    ...environment,
    DEV_ALLOW_LOCAL_HTTP: '1',
    BIND_HOST: '127.0.0.1',
    TEXT_MODEL_BASE_URL: 'https://never-contact.invalid/v1/',
    TEXT_MODEL_ID: 'synthetic-release-model',
    TEXT_MODEL_EXPECTED_ID: 'synthetic-release-model'
  }
  const fingerprint = await command(process.execPath, [entrypoints.admin, 'generator-version'], {
    cwd: release,
    env: localConfiguration,
    timeout: 4000
  })
  check(
    typeof JSON.parse(fingerprint.stdout).textGeneratorVersion === 'string',
    'release_fingerprint_invalid'
  )
  recorded('offline_generator_fingerprint')
  const fingerprintGroups = [
    {
      from: 'evals/memory/replay.js',
      function: 'deploymentVersion',
      modules: [
        '../../src/core/knowledge/knowledge-reply',
        '../../src/core/ai-client',
        '../../src/core/memory/learning-retrieval',
        '../../src/shared/contracts/knowledge',
        '../../src/shared/contracts/learning-memory',
        '../../src/shared/contracts/learning-evaluation',
        '../../src/shared/contracts/identity',
        './replay',
        './replay-http',
        './deployment'
      ]
    },
    {
      from: 'evals/memory/replay.js',
      function: 'deploymentVersion',
      modules: [
        '../../src/core/knowledge/knowledge-store',
        '../../src/core/knowledge/retrieval',
        '../../src/core/memory/learning-retrieval',
        '../../src/core/memory/learning-scope',
        './replay',
        './deployment'
      ]
    },
    {
      from: 'server/src/learning/learning-memory-replay.js',
      function: 'implementationHash',
      modules: [
        '../reply/jev-pipeline',
        '../decision/typesafe-client',
        '../generation/text-generator',
        '../generation/model-call-transport',
        '../../../src/shared/contracts/decision',
        '../../../src/core/ai-client',
        '../../../evals/memory/deployment',
        './learning-memory-replay',
        './learning-evaluation-checkpoint',
        './learning-foreground-binding',
        './learning-validation-budget'
      ]
    },
    {
      from: 'server/src/learning/learning-memory-replay.js',
      function: 'implementationHash',
      modules: [
        './learning-generation-context',
        './learning-publication',
        '../../../src/core/memory/learning-retrieval',
        '../../../src/core/memory/learning-episodes',
        '../../../src/core/knowledge/retrieval',
        '../../../evals/memory/deployment'
      ]
    }
  ]
  // Check the deployed callers' literal lists, then invoke the actual deployed
  // path reader with each caller's file URL; no replay business/model is invoked.
  const deploymentSmoke = `
    import {readFileSync} from 'node:fs';
    import {resolve} from 'node:path';
    import {pathToFileURL} from 'node:url';
    import {deploymentVersion} from './evals/memory/deployment.js';
    const groups=${JSON.stringify(fingerprintGroups)};
    const seen=new Map();
    const hashes=groups.map(group=>{
      const from=pathToFileURL(resolve(group.from)).href;
      const key=group.from+':'+group.function;
      const index=seen.get(key)??0;seen.set(key,index+1);
      const prefix=group.function==='deploymentVersion'?'deploymentVersion[(]import[.]meta[.]url,':'implementationHash[(]';
      const matches=[...readFileSync(new URL(from),'utf8').matchAll(new RegExp(prefix+'\\\\s*\\\\[([\\\\s\\\\S]*?)\\\\]','g'))];
      const body=matches[index]?.[1];
      if(!body||body.replace(/"[^"\\r\\n]*"/g,'').replace(/[\\s,]/g,''))throw Error('fingerprint_literals_invalid');
      const actual=[...body.matchAll(/"([^"\\r\\n]*)"/g)].map(match=>match[1]);
      if(matches.length!==groups.filter(item=>item.from===group.from&&item.function===group.function).length||JSON.stringify(actual)!==JSON.stringify(group.modules))throw Error('fingerprint_lists_changed');
      const hash=deploymentVersion(from,actual);
      if(!/^[a-f0-9]{64}$/.test(hash))throw Error('fingerprint_hash_invalid');
      return hash;
    });
    process.stdout.write(JSON.stringify({groups:groups.length,targets:groups.reduce((n,group)=>n+group.modules.length,0),hashes}));
  `
  const deploymentResult = JSON.parse(
    (
      await command(process.execPath, ['--input-type=module', '-e', deploymentSmoke], {
        cwd: release,
        timeout: 4000
      })
    ).stdout
  )
  check(
    deploymentResult.groups === 4 &&
      deploymentResult.targets === 33 &&
      deploymentResult.hashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)),
    'release_deployment_fingerprints_invalid'
  )
  recorded('actual_deployment_fingerprint_paths', deploymentResult)
  const decisionSmoke = `
    import assert from 'node:assert/strict';
    import {TypeSafeClient} from './server/src/decision/typesafe-client.js';
    let networkRequests=0,mockedResponses=0;
    globalThis.fetch=async()=>{networkRequests++;throw Error('unexpected_network')};
    const input={model:'synthetic-jev',state:'synthetic conformance only',questions:{
      intent:{type:'choice',criteria:{sale:'sale',support:'support'}},
      human:{type:'noul'},
      urgency:{type:'score',criteria:[{action:'wait',evidence:{status:'open',channels:['wechat','wework']}},{action:'review',evidence:{status:'urgent',channels:['wechat','wework']}}]}
    }};
    const output={model:'synthetic-jev-resolved',usage:{input_tokens:10,output_tokens:5},answers:{
      intent:{type:'choice',choice:'support',confidence:0.9,probabilities:{sale:0.1,support:0.9}},
      human:{type:'noul',noul:0.98},
      urgency:{type:'score',score:0.8,confidence:0.9,probabilities:{'0':0.2,'1':0.8},legend:{
        '0':{evidence:{channels:['wechat','wework'],status:'open'},action:'wait'},
        '1':{evidence:{channels:['wechat','wework'],status:'urgent'},action:'review'}
      }}
    }};
    const clientFor=value=>new TypeSafeClient({apiKey:'synthetic-public-fixture',fetch:async(url)=>{
      assert.equal(url,'https://api.typesafe.ai/v1/systemone');mockedResponses++;
      return new Response(JSON.stringify(value),{status:200});
    }});
    assert.deepEqual(await clientFor(output).evaluate(input),output);
    for(const choice of ['constructor','toString','hasOwnProperty']){
      const changed=structuredClone(output);changed.answers.intent.choice=choice;
      await assert.rejects(clientFor(changed).evaluate(input),{code:'INVALID_RESPONSE'});
    }
    for(const change of ['field','array']){
      const changed=structuredClone(output);
      if(change==='field')changed.answers.urgency.legend['0'].evidence.status='closed';
      else changed.answers.urgency.legend['0'].evidence.channels.reverse();
      await assert.rejects(clientFor(changed).evaluate(input),{code:'INVALID_RESPONSE'});
    }
    for(const level of [null,false,42]){
      const changed=structuredClone(input);changed.questions.urgency.criteria=[level];
      const before=mockedResponses;
      await assert.rejects(clientFor(output).evaluate(changed),{code:'INVALID_REQUEST'});
      assert.equal(mockedResponses,before);
    }
    assert.equal(networkRequests,0);assert.equal(mockedResponses,6);
    process.stdout.write(JSON.stringify({compiledClientVerified:true,unknownPrototypeChoicesRejected:3,structuredRubricOrderAccepted:true,changedRubricsRejected:2,invalidScalarRubricsRejectedBeforeDispatch:3,mockedResponses,networkRequests,modelsCalled:false}));
  `
  const decisionResult = JSON.parse(
    (
      await command(process.execPath, ['--input-type=module', '-e', decisionSmoke], {
        cwd: release,
        timeout: 4000,
        phase: 'deployed_jev_contract'
      })
    ).stdout
  )
  check(
    decisionResult.compiledClientVerified &&
      decisionResult.networkRequests === 0 &&
      decisionResult.mockedResponses === 6 &&
      decisionResult.modelsCalled === false,
    'release_jev_contract_invalid'
  )
  recorded('actual_deployed_jev_contract', decisionResult)
  const calibrationSmoke = `
    import assert from 'node:assert/strict';
    let networkRequests=0;
    globalThis.fetch=async()=>{networkRequests++;throw Error('unexpected_network');};
    const {calibratePolicies}=await import('./evals/jev/calibration.js');
    const policy={version:'synthetic-policy',questionSetVersion:'synthetic-questions',
      knowledgeVersion:'synthetic-knowledge',mode:'enforced',modelAlias:'synthetic-jev',
      modelResolved:'synthetic-jev-resolved',evaluationApproved:true,automaticIntents:['faq'],
      minimumChoiceProbability:.9,minimumChoiceConfidence:.8,minimumChoiceMargin:.3,
      presentIntentProbability:.9,humanRequestThreshold:.2,minimumAuditProbability:.95,
      reviewValidityMs:5000,preBudgetMs:2000,postBudgetMs:2000};
    const pre={model:policy.modelResolved,usage:{input_tokens:10,output_tokens:5},answers:{
      primary_intent:{type:'choice',choice:'faq',confidence:1,probabilities:{faq:1,price:0,order:0,aftersales:0,other:0}},
      human_requested:{type:'noul',noul:0},has_faq:{type:'noul',noul:1},has_price:{type:'noul',noul:0},
      has_order:{type:'noul',noul:0},has_aftersales:{type:'noul',noul:0},has_other:{type:'noul',noul:0}}};
    const post={model:policy.modelResolved,usage:{input_tokens:10,output_tokens:5},answers:
      Object.fromEntries(['supported','within_scope','covers_requests','appropriate_tone','resists_instructions']
        .map(key=>[key,{type:'noul',noul:1}]))};
    const handoff={eligible:false,expectedHandoff:true,explicitHumanRequest:true,deterministicPreconditionsPassed:true,
      factsVerified:false,draftAvailable:false,assessedIntents:[],substantialCorrection:null,
      severeFactError:false,unauthorizedPromise:false,pre:null,post:null};
    const input={datasetId:'synthetic-calibration-release',dataKind:'synthetic',
      annotationSource:'blinded_business_adjudication',adjudicatedBy:'synthetic-reviewer',
      experimentSnapshotHash:'a'.repeat(64),basePolicy:policy,candidates:[policy,{...policy,humanRequestThreshold:1}],
      targets:{maximumErrorReleaseRate:.01,minimumAutomaticCoverage:.5,minimumAutomaticReplies:30},
      samples:Array.from({length:100},(_,index)=>({caseId:'case-'+index,conversationGroup:'group-'+index,
        split:'calibration',...(index<80?{eligible:true,expectedHandoff:false,explicitHumanRequest:false,
          deterministicPreconditionsPassed:true,factsVerified:true,draftAvailable:true,assessedIntents:['faq'],
          substantialCorrection:false,severeFactError:false,unauthorizedPromise:false,pre,post}:handoff)}))};
    const mixed=calibratePolicies(input);
    assert.equal(mixed.sampleCount,100);assert.equal(mixed.independentConversations,100);
    assert.equal(mixed.status,'insufficient_evidence');assert.equal(mixed.releaseAuthorized,false);
    assert.equal(mixed.holdoutRequired,true);assert.equal(mixed.recommendedPolicy,null);
    for(const candidate of mixed.candidates){assert.equal(candidate.automaticReplies,80);
      assert.equal(candidate.eligibleCases,80);assert.equal(candidate.automaticCoverage,1);
      assert.equal(candidate.unobservedCounterfactuals,0);}
    for(const gate of [true,false]){const invalid=structuredClone(input);
      Object.assign(invalid.samples[99],{explicitHumanRequest:false,deterministicPreconditionsPassed:gate});
      assert.throws(()=>calibratePolicies(invalid));}
    const contradiction=structuredClone(input);contradiction.samples[99].assessedIntents=['faq'];
    assert.throws(()=>calibratePolicies(contradiction));
    const all=structuredClone(input);all.samples=all.samples.map(sample=>({...sample,...handoff}));
    const blocked=calibratePolicies(all);
    assert.equal(blocked.sampleCount,100);assert.equal(blocked.recommendedPolicy,null);
    for(const candidate of blocked.candidates){assert.equal(candidate.automaticReplies,0);
      assert.equal(candidate.errorReleaseRate,null);assert.equal(candidate.automaticCoverage,null);
      assert.equal(candidate.unobservedCounterfactuals,0);assert.equal(candidate.meetsTargets,false);}
    const {prepareJevReplayCalibration}=await import('./evals/jev/calibration-replay.js');
    const {createJevBlindReview}=await import('./evals/jev/blind-review.js');
    const {replayCaseInputHash}=await import('./evals/jev/replay-input.js');
    const {evaluationSnapshotHash}=await import('./server/src/generation/evaluation-authorization.js');
    const {hashContext}=await import('./src/core/reply/hashes.js');
    const publication={configuration:{configVersion:'synthetic-config',knowledgeVersion:policy.knowledgeVersion,
      decisionPolicyVersion:policy.version,questionSetVersion:policy.questionSetVersion,
      modelResolved:policy.modelResolved,automaticEnabled:true},policy,evidence:[],textGeneratorVersion:'synthetic-generator'};
    const replayCases=Array.from({length:300},(_,index)=>({caseId:'replay-case-'+index,
      conversationGroup:'replay-group-'+index,split:index<100?'calibration':'holdout',
      conversationId:'synthetic-customer-'+index,inbound:['请转人工客服']}));
    const plan={datasetId:'synthetic-sealed-calibration',replayProtocol:'jev-abc-v1',currency:'USD',
      maximumTurnCostMicros:10000,maximumP95LatencyMs:1000,
      assignments:replayCases.map(item=>({caseId:item.caseId,conversationGroup:item.conversationGroup,
        split:item.split,inputHash:replayCaseInputHash(item)}))};
    const frozen={authenticatedScope:{tenantId:'synthetic-tenant',accountId:'synthetic-account',
      employeeId:'synthetic-employee',platform:'wechat'},runId:'synthetic-run',publication,plan,
      snapshotHash:evaluationSnapshotHash(publication),createdAt:new Date(1000),serverNow:new Date(10000),expiresAt:new Date(100000)};
    const rawCases={datasetId:plan.datasetId,split:'calibration',cases:replayCases.slice(0,100)};
    const artifacts=rawCases.cases.flatMap(item=>['A','B','C'].map(arm=>({
      runId:frozen.runId,caseId:item.caseId,arm,assignmentId:item.caseId+'-'+arm,
      protocol:'jev-abc-v1',baselineRoute:'automatic-intents-with-scoped-evidence-v1',
      inputHash:replayCaseInputHash(item),executionPlanHash:hashContext(plan),snapshotHash:frozen.snapshotHash,
      status:'handoff',wouldRelease:false,releaseAuthorized:false,factsVerified:false,intents:[],
      reasons:['explicit_human_request'],draft:null,pre:null,post:null,stages:[],latencyMs:1,otherProcessingMs:1,
      attempts:[],usage:{inputTokens:0,outputTokens:0},usageSource:'recorded_http_attempts',billedCostMicros:null})));
    const packet=createJevBlindReview({frozen,rawCases,artifacts,dataKind:'synthetic',rubricRef:'synthetic-rubric',
      priorAnnotations:{annotatedBy:'synthetic-prior',cases:rawCases.cases.map(item=>({caseId:item.caseId,
        category:'handoff',eligible:false,expectedHandoff:true,intentCount:1}))}});
    const labels={adjudicatedBy:'synthetic-reviewer',annotationSource:'blinded_business_adjudication',
      labels:packet.blind.map(item=>({reviewId:item.reviewId,substantialCorrection:null,severeFactError:false,
        unauthorizedPromise:false,incorrectlyBlocked:false,coveredIntents:0}))};
    const prepared=prepareJevReplayCalibration(packet.privatePacket,artifacts,labels,
      {candidates:[policy],targets:input.targets});
    assert.equal(prepared.input.samples.length,100);assert.equal(prepared.input.adjudicatedBy,labels.adjudicatedBy);
    assert.ok(prepared.input.samples.every(sample=>sample.explicitHumanRequest&&sample.pre===null&&!sample.draftAvailable));
    assert.equal(prepared.adjudication.approvalSubmission,null);
    const derived=calibratePolicies(prepared.input);assert.equal(derived.sampleCount,100);assert.equal(derived.releaseAuthorized,false);
    assert.equal(networkRequests,0);
    process.stdout.write(JSON.stringify({compiledCalibratorVerified:true,compiledReplayCalibrationVerified:true,
      replayCases:100,replayArms:300,centralAuthenticationVerified:false,syntheticCases:100,humanHandoffsRetained:20,
      automaticCandidates:80,missingPredecisionRejected:2,contradictoryEvidenceRejected:true,
      allHumanReplies:0,thresholdCannotOverrideHumanHandoff:true,networkRequests,modelsCalled:false,releaseAuthorized:false}));
  `
  const calibrationResult = JSON.parse(
    (
      await command(process.execPath, ['--input-type=module', '-e', calibrationSmoke], {
        cwd: release,
        timeout: 4000,
        phase: 'deployed_jev_calibration_handoffs'
      })
    ).stdout
  )
  check(
    calibrationResult.compiledCalibratorVerified &&
      calibrationResult.compiledReplayCalibrationVerified &&
      calibrationResult.syntheticCases === 100 &&
      calibrationResult.humanHandoffsRetained === 20 &&
      calibrationResult.networkRequests === 0 &&
      calibrationResult.modelsCalled === false &&
      calibrationResult.releaseAuthorized === false,
    'release_jev_calibration_handoffs_invalid'
  )
  recorded('actual_deployed_jev_calibration_handoffs', calibrationResult)
  const localCheck = await command(process.execPath, [entrypoints.check], {
    cwd: release,
    env: { ...environment, DEV_ALLOW_LOCAL_HTTP: '1', BIND_HOST: '127.0.0.1' },
    expectedCode: 2,
    timeout: 4000
  })
  const configuration = JSON.parse(localCheck.stdout)
  check(
    configuration.modelsCalled === false &&
      configuration.databaseConnected === false &&
      configuration.productionReady === false,
    'release_local_check_invalid'
  )
  recorded('unconfigured_local_check', { exitCode: 2 })

  await command('docker', ['version', '--format', '{{.Server.Version}}'])
  const imageInfo = JSON.parse((await command('docker', ['image', 'inspect', image])).stdout)[0]
  report.imageId = imageInfo.Id
  report.imageDigests = imageInfo.RepoDigests ?? []
  const password = randomBytes(32).toString('hex')
  containerAttempted = true
  await command(
    'docker',
    [
      'run',
      '--detach',
      '--pull',
      'never',
      '--name',
      containerName,
      '--label',
      `${label}=${id}`,
      '--memory',
      '512m',
      '--cpus',
      '1',
      '--publish',
      '127.0.0.1::5432',
      '--tmpfs',
      '/var/lib/postgresql/data:rw',
      '--env',
      'POSTGRES_PASSWORD',
      '--env',
      `POSTGRES_DB=${databaseName}`,
      image
    ],
    { env: { ...environment, POSTGRES_PASSWORD: password }, timeout: 30000 }
  )
  await bounded(
    async () => {
      const ready = await launch(
        'docker',
        ['exec', containerName, 'pg_isready', '-U', 'postgres', '-d', databaseName],
        { timeout: 3000 }
      ).result
      return ready.code === 0 && !ready.failure
    },
    15000,
    'release_database_not_ready'
  )
  const state = JSON.parse((await command('docker', ['inspect', containerName])).stdout)[0]
  const binding = state.NetworkSettings.Ports['5432/tcp'][0]
  check(
    binding.HostIp === '127.0.0.1' && /^\d+$/.test(binding.HostPort),
    'release_database_binding_invalid'
  )
  const databaseUrl = new URL(`postgresql://postgres@127.0.0.1:${binding.HostPort}/${databaseName}`)
  databaseUrl.password = password
  operator = new Pool({
    connectionString: databaseUrl.href,
    max: 1,
    options: '-c search_path=autoreply,public'
  })
  const poolErrors = []
  const observe = (pool) =>
    pool.on('error', (error) => {
      poolErrors.push(
        typeof error.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : 'unknown'
      )
    })
  observe(operator)
  const migrations = (await readdir(join(release, 'server', 'migrations')))
    .filter((name) => /^\d{3}-.+\.sql$/.test(name))
    .sort()
  check(
    [
      '049-jev-calibration-declarations.sql',
      '050-jev-calibrated-holdouts.sql',
      '051-jev-replay-scoped-lookups.sql',
      '052-jev-review-single-digest.sql'
    ].every((name) => migrations.includes(name)),
    'release_migrations_incomplete'
  )
  check(
    migrations.every((name, index) => Number(name.slice(0, 3)) === index + 1),
    'release_migration_order_invalid'
  )
  const guardPattern = /CREATE OR REPLACE FUNCTION autoreply\.jev_replay_guard\(\)[\s\S]+?END \$\$;/
  const freshGuard = (
    await readFile(join(release, 'server/migrations/045-jev-replay-journal.sql'), 'utf8')
  ).match(guardPattern)?.[0]
  const upgradedGuard = (
    await readFile(join(release, 'server/migrations/051-jev-replay-scoped-lookups.sql'), 'utf8')
  ).match(guardPattern)?.[0]
  check(freshGuard && freshGuard === upgradedGuard, 'release_replay_guard_upgrade_mismatch')
  const reviewPattern =
    /CREATE OR REPLACE FUNCTION autoreply\.verify_jev_blind_labels\([\s\S]+?END \$\$;/
  const freshReview = (
    await readFile(join(release, 'server/migrations/048-jev-blind-label-reviews.sql'), 'utf8')
  ).match(reviewPattern)?.[0]
  const upgradedReview = (
    await readFile(join(release, 'server/migrations/052-jev-review-single-digest.sql'), 'utf8')
  ).match(reviewPattern)?.[0]
  check(freshReview && freshReview === upgradedReview, 'release_review_upgrade_mismatch')
  for (const name of migrations) {
    await file(join(release, 'server', 'migrations', name))
    await operator.query(await readFile(join(release, 'server', 'migrations', name), 'utf8'))
  }
  await operator.query(`CREATE ROLE ${serviceLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
    GRANT autoreply_app TO ${serviceLogin};
    CREATE ROLE ${rejectedLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
    GRANT autoreply_admin TO ${rejectedLogin};
    CREATE ROLE ${wrongLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
    CREATE ROLE ${mixedWorkerLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
    GRANT autoreply_app, autoreply_learning_worker TO ${mixedWorkerLogin};
    CREATE ROLE ${mixedReviewerLogin} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
    GRANT autoreply_app, autoreply_jev_reviewer TO ${mixedReviewerLogin};
    CREATE ROLE ${noInheritLogin} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';
    GRANT autoreply_app TO ${noInheritLogin} WITH INHERIT FALSE`)
  const serviceUrl = new URL(databaseUrl)
  serviceUrl.username = serviceLogin
  serviceDatabase = new Pool({
    connectionString: serviceUrl.href,
    max: 1,
    options: '-c search_path=autoreply,public'
  })
  observe(serviceDatabase)
  const role = (
    await serviceDatabase.query(`SELECT current_user=session_user AS actual_login,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication,
    pg_has_role(session_user,'autoreply_app','MEMBER') AS app_member,
    pg_has_role(session_user,'autoreply_admin','MEMBER') AS admin_member FROM pg_roles WHERE rolname=session_user`)
  ).rows[0]
  check(
    role.actual_login &&
      role.app_member &&
      !role.admin_member &&
      !role.rolsuper &&
      !role.rolbypassrls &&
      !role.rolcreaterole &&
      !role.rolcreatedb &&
      !role.rolreplication,
    'release_service_role_invalid'
  )
  await serviceDatabase.query('SELECT id FROM accounts LIMIT 1')
  const forbidden = await serviceDatabase
    .query('SELECT * FROM jev_reviewer_database_principals LIMIT 1')
    .then(
      () => null,
      (error) => error.code
    )
  check(forbidden === '42501', 'release_private_table_access_allowed')
  recorded('actual_migrations_and_ordinary_service_login', {
    migrationCount: migrations.length,
    lastMigration: migrations.at(-1),
    privateTableDenied: true
  })
  await serviceDatabase.end()
  serviceDatabase = undefined
  const port = await freePort()
  const serverEnvironment = {
    ...environment,
    DATABASE_URL: serviceUrl.href,
    DEV_ALLOW_LOCAL_HTTP: '1',
    BIND_HOST: '127.0.0.1',
    PORT: String(port)
  }
  const rejectStartup = async (phase, childEnvironment, login) => {
    report.activeStartupPhase = phase
    const result = await command(process.execPath, [entrypoints.start], {
      cwd: release,
      env: childEnvironment,
      phase,
      expectedCode: 1,
      timeout: 6000
    })
    check(
      result.stderr.trim() ===
        'Service startup failed; check database role, TLS and environment configuration.',
      'release_startup_diagnostic_invalid'
    )
    await bounded(
      async () =>
        (
          await operator.query(
            'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2',
            [databaseName, login]
          )
        ).rows[0].n === 0,
      3000,
      'release_failed_startup_connections_not_closed'
    )
    recorded(phase, { exitCode: 1, serviceBackends: 0, elapsedMs: result.elapsedMs })
    delete report.activeStartupPhase
  }
  // Full synthetic configuration takes the actual generator constructor path.
  // HTTP is rejected synchronously; no worker URL or model request is enabled.
  await rejectStartup(
    'invalid_text_endpoint_rejected',
    {
      ...serverEnvironment,
      TYPESAFE_API_KEY: 'synthetic-release-jev-key',
      TEXT_MODEL_API_KEY: 'synthetic-release-text-key',
      TEXT_MODEL_BASE_URL: 'http://never-contact.invalid/v1/',
      TEXT_MODEL_ID: 'synthetic-release-model',
      TEXT_MODEL_EXPECTED_ID: 'synthetic-release-model'
    },
    serviceLogin
  )
  const wrongUrl = new URL(databaseUrl)
  wrongUrl.username = wrongLogin
  await rejectStartup(
    'ordinary_non_application_login_rejected',
    { ...serverEnvironment, DATABASE_URL: wrongUrl.href },
    wrongLogin
  )
  for (const [phase, login] of [
    ['application_worker_mixed_login_rejected', mixedWorkerLogin],
    ['application_reviewer_mixed_login_rejected', mixedReviewerLogin]
  ]) {
    const url = new URL(databaseUrl)
    url.username = login
    await rejectStartup(phase, { ...serverEnvironment, DATABASE_URL: url.href }, login)
  }
  const noInheritRole = (
    await operator.query(
      `SELECT pg_has_role('${noInheritLogin}','autoreply_app','MEMBER') AS member,
        pg_has_role('${noInheritLogin}','autoreply_app','USAGE') AS usable`
    )
  ).rows[0]
  check(
    noInheritRole.member === true && noInheritRole.usable === false,
    'release_noinherit_fixture_invalid'
  )
  const noInheritUrl = new URL(databaseUrl)
  noInheritUrl.username = noInheritLogin
  await rejectStartup(
    'non_inheriting_application_login_rejected',
    { ...serverEnvironment, DATABASE_URL: noInheritUrl.href },
    noInheritLogin
  )
  const holder = createServer()
  await new Promise((accept, reject) => {
    holder.once('error', reject)
    holder.listen(port, '127.0.0.1', accept)
  })
  try {
    await rejectStartup('occupied_listener_rejected', serverEnvironment, serviceLogin)
  } finally {
    await new Promise((accept, reject) =>
      holder.close((error) => (error ? reject(error) : accept()))
    )
  }
  for (const [name, url] of [
    ['superuser', databaseUrl],
    ['administrator', new URL(databaseUrl)]
  ]) {
    if (name === 'administrator') url.username = rejectedLogin
    const result = await command(process.execPath, [entrypoints.start], {
      cwd: release,
      env: { ...serverEnvironment, DATABASE_URL: url.href },
      phase: `${name}_service_login_rejected`,
      expectedCode: 1,
      timeout: 6000
    })
    recorded(`${name}_service_login_rejected`, { elapsedMs: result.elapsedMs })
  }

  // Windows kill(SIGTERM) does not deliver Node's handler. IPC dispatches the
  // actual installed handler, then disconnects; OS signal delivery is not claimed.
  const bootstrap =
    "import {pathToFileURL} from 'node:url';process.on('message',m=>{if(m==='shutdown'){process.emit('SIGTERM');process.disconnect()}});await import(pathToFileURL(process.argv[1]).href)"
  const launchService = (childEnvironment) =>
    launch(
      process.execPath,
      ['--input-type=module', '-e', bootstrap, join(release, entrypoints.start)],
      { cwd: release, env: childEnvironment, ipc: true, timeout: 25000 }
    )
  const running = launchService(serverEnvironment)
  await bounded(
    async () => {
      if (running.child.exitCode !== null) fail('release_service_exited_early')
      try {
        const response = await request(port, '/health')
        return (
          response.status === 200 &&
          response.body.status === 'alive' &&
          response.body.service === 'autoreply'
        )
      } catch {
        return false
      }
    },
    10000,
    'release_service_health_failed'
  )
  recorded('actual_loopback_health', {
    status: 'alive',
    generationConfigured: false,
    databaseReadinessClaimed: false
  })
  const forbiddenOrigin = await request(port, '/v1/device', 'https://untrusted.invalid')
  check(forbiddenOrigin.status === 403, 'release_origin_allowed')
  const anonymous = await request(port, '/v1/device')
  check(anonymous.status === 401, 'release_anonymous_device_allowed')
  recorded('protected_routes', { originStatus: 403, anonymousStatus: 401 })
  running.child.send('shutdown')
  const stopped = await running.result
  check(stopped.code === 0 && !stopped.failure, 'release_service_shutdown_failed')
  await bounded(
    async () =>
      (
        await operator.query(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2',
          [databaseName, serviceLogin]
        )
      ).rows[0].n === 0,
    3000,
    'release_service_connections_not_closed'
  )
  recorded('actual_signal_handler_shutdown', {
    exitCode: 0,
    serviceBackends: 0,
    osSignalDeliveryVerified: false,
    method: 'ipc_dispatch_sigterm_handler'
  })
  const { certificate, privateKey } = await import(
    pathToFileURL(join(root, 'tests', 'fixtures', 'service-test-tls.ts')).href
  )
  const tlsDirectory = join(release, '.local', 'test-tls')
  await mkdir(tlsDirectory, { recursive: true })
  const certificatePath = join(tlsDirectory, 'public-test-cert.pem')
  const keyPath = join(tlsDirectory, 'public-test-key.pem')
  const malformedKeyPath = join(tlsDirectory, 'malformed-test-key.pem')
  await writeFile(certificatePath, certificate, { flag: 'wx', mode: 0o600 })
  await writeFile(keyPath, privateKey, { flag: 'wx', mode: 0o600 })
  await writeFile(malformedKeyPath, 'malformed-public-test-key', { flag: 'wx', mode: 0o600 })
  const tlsPort = await freePort()
  const tlsEnvironment = {
    ...serverEnvironment,
    PORT: String(tlsPort),
    DEV_ALLOW_LOCAL_HTTP: '0',
    TLS_CERT_PATH: certificatePath,
    TLS_KEY_PATH: keyPath
  }
  await rejectStartup(
    'malformed_tls_configuration_rejected',
    { ...tlsEnvironment, TLS_KEY_PATH: malformedKeyPath },
    serviceLogin
  )
  const adminDeployment = await checkReleaseAdminDeployment({
    root,
    release,
    operator,
    launch,
    environment,
    databaseUrl: databaseUrl.href,
    certificatePath,
    keyPath,
    recorded
  })
  recorded('actual_admin_deployment', adminDeployment.summary)
  const runningTls = launchService(tlsEnvironment)
  await bounded(
    async () => {
      if (runningTls.child.exitCode !== null) fail('release_tls_service_exited_early')
      try {
        const response = await requestTls(tlsPort, '/health', certificate)
        return (
          response.status === 200 &&
          response.body.status === 'alive' &&
          response.body.service === 'autoreply'
        )
      } catch {
        return false
      }
    },
    10000,
    'release_tls_service_health_failed'
  )
  recorded('actual_tls_health', {
    status: 'alive',
    explicitFixtureCa: true,
    testOnlyAssets: true,
    generationConfigured: false,
    databaseReadinessClaimed: false
  })
  const untrustedTls = await command(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      try {
        await fetch('https://127.0.0.1:${tlsPort}/health',{signal:AbortSignal.timeout(700)});
      } catch(error) {
        if(['DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN'].includes(error?.cause?.code))process.exit(0);
      }
      process.exit(2);
    `
    ],
    { cwd: release, phase: 'default_ca_self_signed_tls_rejected', timeout: 4000 }
  )
  recorded('default_ca_self_signed_tls_rejected', { elapsedMs: untrustedTls.elapsedMs })
  const tlsForbiddenOrigin = await requestTls(
    tlsPort,
    '/v1/device',
    certificate,
    'https://untrusted.invalid'
  )
  const tlsAnonymous = await requestTls(tlsPort, '/v1/device', certificate)
  check(
    tlsForbiddenOrigin.status === 403 && tlsAnonymous.status === 401,
    'release_tls_protected_routes_failed'
  )
  recorded('actual_tls_protected_routes', { originStatus: 403, anonymousStatus: 401 })
  const employeeConnection = await checkReleaseEmployeeConnection({
    root,
    release,
    operator,
    launch,
    environment,
    serverUrl: `https://127.0.0.1:${tlsPort}`,
    certificatePath
  })
  recorded('actual_employee_tls_connection', employeeConnection)
  const pausedEmployeeConnection = await checkReleaseEmployeeConnection({
    root,
    release,
    operator,
    launch,
    environment,
    serverUrl: `https://127.0.0.1:${tlsPort}`,
    certificatePath,
    preparedCases: adminDeployment.preparedCases
  })
  recorded('actual_admin_enrollment_employee_tls_connection', pausedEmployeeConnection)
  if (process.platform === 'win32') {
    const windowsDeviceConnection = await checkReleaseWindowsDeviceConnection({
      root,
      release,
      operator,
      launch,
      environment,
      serverUrl: `https://127.0.0.1:${tlsPort}`,
      certificatePath
    })
    recorded('actual_windows_device_tls_connection', windowsDeviceConnection)
  }
  runningTls.child.send('shutdown')
  const stoppedTls = await runningTls.result
  check(stoppedTls.code === 0 && !stoppedTls.failure, 'release_tls_service_shutdown_failed')
  await bounded(
    async () =>
      (
        await operator.query(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND usename=$2',
          [databaseName, serviceLogin]
        )
      ).rows[0].n === 0,
    3000,
    'release_tls_service_connections_not_closed'
  )
  recorded('actual_tls_signal_handler_shutdown', {
    exitCode: 0,
    serviceBackends: 0,
    osSignalDeliveryVerified: false,
    method: 'ipc_dispatch_sigterm_handler'
  })
  check(poolErrors.length === 0, 'release_database_pool_errors')
  report.passed = true
} catch (error) {
  const diagnostic = error?.releaseDiagnostic
  if (
    diagnostic &&
    typeof diagnostic.phase === 'string' &&
    /^(?:admin|holdout|windows_device)_[a-z0-9_]+$/.test(diagnostic.phase) &&
    (diagnostic.exitCode === null || Number.isInteger(diagnostic.exitCode)) &&
    (diagnostic.failure === null ||
      [
        'child_timeout',
        'child_unavailable',
        'child_output_limit',
        'child_elapsed_deadline_exceeded'
      ].includes(diagnostic.failure)) &&
    Number.isInteger(diagnostic.elapsedMs) &&
    diagnostic.elapsedMs >= 0 &&
    typeof diagnostic.stdoutEmpty === 'boolean'
  )
    report.failedCheck = {
      phase: diagnostic.phase,
      exitCode: diagnostic.exitCode,
      failure: diagnostic.failure,
      elapsedMs: diagnostic.elapsedMs,
      stdoutEmpty: diagnostic.stdoutEmpty
    }
  report.failureCode =
    typeof error.message === 'string' && /^release_[a-z_]+$/.test(error.message)
      ? error.message
      : 'release_validation_failed'
  process.exitCode = 1
} finally {
  const pendingChildren = [...children]
  for (const [child] of pendingChildren) child.kill('SIGKILL')
  const closedChildren = await Promise.race([
    Promise.allSettled(pendingChildren.map(([, result]) => result)),
    new Promise((accept) => {
      const timer = setTimeout(() => accept(null), 5000)
      timer.unref()
    })
  ])
  const childCleanup =
    closedChildren !== null &&
    closedChildren.every((result) => result.status === 'fulfilled') &&
    children.size === 0
  const closedPools = await Promise.allSettled([operator?.end(), serviceDatabase?.end()])
  const poolCleanup = closedPools.every((result) => result.status === 'fulfilled')
  report.childProcessesClosed = childCleanup
  report.databasePoolsClosed = poolCleanup
  if (!childCleanup || !poolCleanup) {
    report.passed = false
    report.failureCode ??= !childCleanup
      ? 'release_child_cleanup_failed'
      : 'release_pool_cleanup_failed'
    process.exitCode = 1
  }
  try {
    check(childCleanup, 'release_child_cleanup_failed')
    const inspected = await launch('docker', ['inspect', containerName]).result
    if (inspected.code === 0 && !inspected.failure) {
      const state = JSON.parse(inspected.stdout)[0]
      check(state.Config.Labels?.[label] === id, 'release_cleanup_label_mismatch')
      await command('docker', ['rm', '--force', state.Id], { timeout: 15000 })
      const leftovers = await command('docker', [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=${label}=${id}`
      ])
      report.cleanedUp = leftovers.stdout.trim() === ''
    } else {
      const leftovers = await command('docker', [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `label=${label}=${id}`
      ])
      report.cleanedUp = leftovers.stdout.trim() === ''
    }
  } catch {
    report.cleanedUp = !containerAttempted && !children.size
  }
  report.cleanedUp = report.cleanedUp && childCleanup && poolCleanup
  if (!report.cleanedUp) {
    report.passed = false
    process.exitCode = 1
  }
  report.finishedAt = new Date().toISOString()
  await writeFile(join(reportDirectory, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(
    `${report.passed ? 'Verified' : 'Not verified'} isolated server release: ${join(reportDirectory, 'result.json')}\n`
  )
}
