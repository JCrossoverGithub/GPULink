import subprocess, pathlib, os, urllib.request, urllib.error, sys, tempfile
ROOT=pathlib.Path(__file__).resolve().parents[2]
OFFLINE="--offline-render" in sys.argv
from playwright.sync_api import sync_playwright
p=subprocess.Popen(['node','manager/qa/preview-fixture.mjs','--qa-disconnect'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
try:
 url=p.stdout.readline().strip(); print(url,flush=True); assert url.startswith('http://127.0.0.1:')
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox']); page=b.new_page(viewport={'width':1440,'height':1000}); errors=[];requests=[]; page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append((r.method,r.url)))
  if OFFLINE:
   import tempfile, shutil, json
   with urllib.request.urlopen(urllib.request.Request(url+'api/snapshot',headers={'X-GPULink-Manager':'snapshot-v1'})) as response: snapshot=json.load(response)
   src=ROOT/'manager/public'
   page.set_content((src/'index.html').read_text().replace('<link rel="stylesheet" href="/manager.css">','<style>'+(src/'manager.css').read_text()+'</style>').replace('<script src="/manager.js" defer></script>',''))
   page.evaluate('window.__qaDisconnect=false; window.fetch=async()=>{if(window.__qaDisconnect)throw Error("QA offline");return {ok:true,json:async()=>('+json.dumps(snapshot)+')}};')
   page.add_script_tag(content=(src/'manager.js').read_text())
  else:
   page.goto(url)
  page.get_by_text('ISOLATED QA CORE · SYNTHETIC TELEMETRY').wait_for();page.get_by_text('qa-atlas',exact=True).first.wait_for();page.get_by_text('Job cleanup hold',exact=True).first.wait_for();page.screenshot(path=str(pathlib.Path(tempfile.gettempdir())/'gpulink-manager-overview.png'),full_page=True)
  page.locator('.c-slot').first.click();page.locator('#drawerTitle').get_by_text('QA device 01').wait_for();page.get_by_text('GPU-QA-1',exact=True).wait_for();page.screenshot(path=str(pathlib.Path(tempfile.gettempdir())/'gpulink-manager-inspection.png'),full_page=True);page.locator('#closeDrawer').click();
  for name in ['Workers','GPUs','Jobs','Sessions','Adapters','Events','Recovery','Settings','Overview']:
   page.locator('#nav').get_by_role('button',name=name,exact=True).click();assert page.locator('h1').inner_text()==('Cluster operations' if name=='Overview' else name)
  page.get_by_role('button',name='Topology',exact=True).click();page.locator('.topology-host').first.wait_for();page.get_by_role('button',name='Resources',exact=True).click();assert page.locator('#resourceTree').is_visible();page.get_by_role('button',name='Close resource tree').click();page.get_by_role('button',name='Rack',exact=True).click();
  for width in [1024,768,390]:
   page.set_viewport_size({'width':width,'height':950});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'),width
  page.set_viewport_size({'width':1440,'height':1000});
  if OFFLINE: page.evaluate('window.__qaDisconnect=true')
  else: p.stdin.write('disconnect\n');p.stdin.flush();page.wait_for_timeout(1200)
  page.locator('#refresh').click();page.get_by_text('Connection lost — last known snapshot',exact=True).wait_for(timeout=15000);assert page.get_by_text('qa-atlas',exact=True).first.is_visible();assert page.locator('.c-slot').first.get_by_text('Unknown',exact=True).is_visible();assert not errors,errors;assert (not requests if OFFLINE else all(m=='GET' and u.startswith(url) for m,u in requests)),requests;print('PASS: UI with actual Core snapshot, nine views, inspector, topology, tree, responsive, stale retention; no JS errors or external requests',flush=True);b.close()
finally:
 p.stdin.close();p.terminate();p.wait(timeout=5)
