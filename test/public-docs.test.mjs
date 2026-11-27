import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = name => readFileSync(path.join(root,name),'utf8');
// Current top-level guides and public-facing author/consumer entry points.
// Dated acceptance, ADR and design records retain their historical assertions.
const current = [
  'README.md','CONTRIBUTING.md','SECURITY.md','manager/README.md',
  ...readdirSync(path.join(root,'docs')).filter(n=>n.endsWith('.md')).map(n=>`docs/${n}`),
  'docs/developer-platform/README.md',
  'docs/developer-platform/adapter-sdk-developer-contract-v0.1.md',
  'docs/developer-platform/operator-trusted-adapter-package-workflow.md',
  'packages/gpulink-sdk/README.md','packages/gpulink-adapter-sdk/README.md',
  'packages/gpulink-dotnet/GPULink.Client/README.md',
  'examples/vector-search/README.md','examples/gpulink-sdk/README.md',
];
// Check inline Markdown links outside fenced code. This is deliberately not
// a full Markdown parser or an external URL checker. GitHub ATX headings
// and explicit HTML anchors are supported, including repeated headings.
function prose(markdown) { return markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[ \t]*$/gm,''); }
function anchors(markdown) {
  const found=new Set(), counts=new Map();
  const text=prose(markdown);
  for(const m of text.matchAll(/^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug=m[1].toLowerCase().replace(/<[^>]*>/g,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[^\p{L}\p{N}\p{M}\s_-]/gu,'').replace(/\s/g,'-');
    let n=counts.get(slug)??0, id=n?`${slug}-${n}`:slug;
    while(found.has(id)) id=`${slug}-${++n}`;
    counts.set(slug,n+1);found.add(id);
  }
  for(const m of text.matchAll(/<(?:a|span)\s+(?:id|name)=["']([^"']+)["']/g)) found.add(m[1]);
  return found;
}
test('current public guides resolve local inline links and heading anchors',()=>{
  const broken=[];let checked=0;
  for(const file of current) {
    for(const match of prose(read(file)).matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) {
      const link=match[1];if(/^[a-z][a-z\d+.-]*:|^\/\//i.test(link)) continue;
      const [target,fragment]=link.split('#');
      const resolved=target?path.resolve(root,path.dirname(file),decodeURIComponent(target)):path.join(root,file);
      checked++;
      if(!existsSync(resolved)){broken.push(`${file}: ${link} (missing path)`);continue;}
      if(fragment&&statSync(resolved).isFile()&&resolved.endsWith('.md')&&!anchors(readFileSync(resolved,'utf8')).has(decodeURIComponent(fragment))) broken.push(`${file}: ${link} (missing anchor)`);
    }
  }
  assert.ok(checked>=50,`too few links checked: ${checked}`);
  console.log(`Checked ${checked} local inline links across ${current.length} current guides`);
  assert.deepEqual(broken,[]);
});

test('public guides do not regress to obsolete unpublished npm claims',()=>{
  const stale=/\b(?:SDKs?|authoring SDK) (?:is|are|remain[s]?) (?:intentionally )?\*{0,2}private\b|pre-1\.0 and private|not-yet-public|locally packed tarball until a release decision|public registry distribution remain[s]? separate work|no (?:accepted )?public npm release/i;
  for(const file of current) assert.doesNotMatch(read(file),stale,file);
  assert.match(read('docs/developer-platform/verified-milestone-status.md'),/Historical October checkpoint/);
});

test('documented first-workload lifecycle orders consent, observation and shutdown',()=>{
  const content=read('docs/FIRST_GPU_WORKLOAD.md');
  const commands=[
    'init local','doctor control-plane','local start','jobs','local worker start --accept-assigned-work',
    'local status','workers','submit-diagnostic 256','wait "$JOB_ID"','manager --no-open','local worker stop','local stop',
  ];
  const shell=[...content.matchAll(/```bash\n([\s\S]*?)\n```/g)].map(m=>m[1]).join('\n');
  let offset=-1;
  for(const command of commands){const next=shell.indexOf(`gpulink --config-dir "$SETUP" ${command}`,offset+1);assert.ok(next>offset,command);offset=next;}
  assert.match(shell,/job\['assignedGpuUuid'\] == job\['result'\]\['gpu'\]\['uuid'\]/);
  assert.equal((shell.match(/submit-diagnostic 256/g)||[]).length,1);
  assert.doesNotMatch(shell,/\bsudo\b|\bkill\b|\brm -rf\b/);
});

test('Linux public guide Bash snippets and acceptance scripts parse',t=>{
  if(process.platform!=='linux')return t.skip('Linux/WSL shell guides');
  for(const file of ['docs/FIRST_GPU_WORKLOAD.md','docs/DEVELOPER_BATCH_QUICKSTART.md','examples/vector-search/README.md']){
    for(const m of read(file).matchAll(/```(?:bash|sh)\n([\s\S]*?)\n```/g)){
      const result=spawnSync('bash',['-n'],{input:m[1],encoding:'utf8',timeout:5000});assert.equal(result.status,0,`${file}: ${result.stderr}`);
    }
  }
  for(const file of ['examples/vector-search/prepare.sh','scripts/acceptance/installed-local-gpu-diagnostic.sh','scripts/acceptance/public-docs-registry.sh']){
    const result=spawnSync('bash',['-n',path.join(root,file)],{encoding:'utf8',timeout:5000});assert.equal(result.status,0,`${file}: ${result.stderr}`);
  }
});

test('registry hardware gate refuses missing consent and invalid modes before setup',t=>{
  if(process.platform!=='linux')return t.skip('Linux/WSL lifecycle');
  const file=path.join(root,'scripts/acceptance/installed-local-gpu-diagnostic.sh');
  const env={...process.env};delete env.GPULINK_E2E_DIAGNOSTIC_ACK;
  let result=spawnSync('bash',[file,'--registry'],{env,encoding:'utf8',timeout:5000});
  assert.equal(result.status,2);assert.match(result.stderr,/REFUSED: Real worker startup/);
  result=spawnSync('bash',[file,'--unknown'],{env:{...env,GPULINK_E2E_DIAGNOSTIC_ACK:'YES_ALLOW_ONE_BOUNDED_GPU_DIAGNOSTIC'},encoding:'utf8',timeout:5000});
  assert.equal(result.status,2);assert.match(result.stderr,/Usage:/);
});
