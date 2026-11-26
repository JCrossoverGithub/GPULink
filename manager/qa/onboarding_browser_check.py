"""Empty cluster guidance using a real empty Core; offline render replaces browser transport only."""
import json, os, pathlib, subprocess, sys, tempfile, urllib.request
from playwright.sync_api import sync_playwright, expect
ROOT=pathlib.Path(__file__).resolve().parents[2]
p=subprocess.Popen(['node','manager/qa/preview-fixture.mjs','--qa-empty'],cwd=ROOT,stdout=subprocess.PIPE,text=True)
try:
    url=p.stdout.readline().strip();assert url.startswith('http://127.0.0.1:')
    assert p.stdout.readline().startswith('Isolated QA Core')
    with sync_playwright() as pw:
        b=pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        page=b.new_page(viewport={'width':1440,'height':1000});errors=[];requests=[]
        page.on('pageerror',lambda e:errors.append(str(e)));page.on('request',lambda r:requests.append((r.method,r.url)))
        if '--offline-render' in sys.argv:
            with urllib.request.urlopen(urllib.request.Request(url+'api/snapshot',headers={'X-GPULink-Manager':'snapshot-v1'})) as response: snapshot=json.load(response)
            assert not snapshot['workers'] and 'controlToken' not in snapshot
            src=ROOT/'manager/public'
            page.set_content((src/'index.html').read_text().replace('<link rel="stylesheet" href="/manager.css">','<style>'+(src/'manager.css').read_text()+'</style>').replace('<script type="module" src="/manager.js"></script>',''))
            page.evaluate('''s=>{window.fetch=async(path,opts)=>{if(path!='/api/snapshot'||opts.method)throw Error('unexpected request');return {ok:true,json:async()=>s}};window.EventSource=class extends EventTarget{};}''',snapshot)
            page.add_script_tag(content=(src/'refresh-controller.js').read_text().replace('export function','function',1)+'\n'+(src/'manager.js').read_text().replace("import {createRefreshController} from './refresh-controller.js';",'',1))
        else: page.goto(url)
        expect(page.locator('#managerMode')).to_have_text('READ ONLY')
        for mode in ['Rack','Table','Topology']:
            page.get_by_role('button',name=mode,exact=True).click()
            expect(page.get_by_text('No enrolled workers',exact=True)).to_be_visible()
            page.get_by_role('button',name='Connect a GPU worker').click()
            expect(page.locator('#guideDialog')).to_be_visible()
            expect(page.locator('#guideBody')).to_contain_text('setup invite --output')
            expect(page.locator('#guideBody')).to_contain_text('not a one-time or individually revocable credential')
            expect(page.locator('#guideBody')).to_contain_text('worker start --accept-assigned-work')
            page.screenshot(path=str(pathlib.Path(tempfile.gettempdir())/'gpulink-onboarding-guide.png'))
            page.locator('#guideClose').click()
        page.set_viewport_size({'width':390,'height':850})
        page.get_by_role('button',name='Connect a GPU worker').click()
        expect(page.locator('#guideDialog')).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1')
        page.keyboard.press('Escape');expect(page.locator('#guideDialog')).not_to_be_visible()
        assert not errors,errors
        assert all(m=='GET' and u.startswith(url) for m,u in requests),requests
        print('PASS: actual empty Core, read-only guidance in all three views, server commands, narrow dialog, no mutations or external requests')
        b.close()
finally:
    p.terminate();p.wait(timeout=10)
