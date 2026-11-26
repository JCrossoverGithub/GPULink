"""Disposable browser acceptance. Offline bridge is QA-only, not a shipped transport."""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright, expect

ROOT = pathlib.Path(__file__).resolve().parents[2]
BRIDGE = '--offline-bridge' in sys.argv
p = subprocess.Popen(['node', 'manager/qa/preview-fixture.mjs', '--enable-controls', '--qa-disconnect'], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
try:
    url = p.stdout.readline().strip()
    assert url.startswith('http://127.0.0.1:')
    assert p.stdout.readline().startswith('Isolated QA Core')
    posts = []
    def bridge(source, request):
        path, method, headers, body = request['path'], request['method'], request['headers'], request['body']
        assert path in ['/api/snapshot', '/api/operation']
        if method == 'POST':
            posts.append(json.loads(body))
            headers.update({'Origin': url.rstrip('/'), 'Sec-Fetch-Site': 'same-origin'})
        try:
            with urllib.request.urlopen(urllib.request.Request(url.rstrip('/') + path, data=body.encode() if body else None, headers=headers, method=method), timeout=10) as response:
                return {'status': response.status, 'body': json.load(response)}
        except urllib.error.HTTPError as error:
            return {'status': error.code, 'body': json.load(error)}
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width':1440,'height':1000})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        if BRIDGE:
            page.expose_binding('__qaHttp', bridge)
            src = ROOT / 'manager/public'
            page.set_content((src / 'index.html').read_text().replace('<link rel="stylesheet" href="/manager.css">', '<style>' + (src / 'manager.css').read_text() + '</style>').replace('<script type="module" src="/manager.js"></script>', ''))
            page.evaluate('''() => {window.fetch=async(path,options={})=>{const r=await window.__qaHttp({path,method:options.method||'GET',headers:options.headers||{},body:options.body||''});return {ok:r.status>=200&&r.status<300,status:r.status,json:async()=>r.body};};window.EventSource=class extends EventTarget{};}''')
            page.add_script_tag(content=(src/'refresh-controller.js').read_text().replace('export function','function',1)+'\n'+(src/'manager.js').read_text().replace("import {createRefreshController} from './refresh-controller.js';",'',1))
        else:
            page.on('request', lambda r: posts.append(r.post_data_json) if r.method=='POST' else None)
            page.goto(url)
        expect(page.locator('#managerMode')).to_have_text('OPERATOR MODE')
        def nav(name): page.locator('#nav').get_by_role('button',name=name,exact=True).click()
        def select(name): page.locator('#main').get_by_role('button',name=name,exact=True).first.click()
        def action(name, confirm=True):
            page.locator('#drawerContent').get_by_role('button',name=name,exact=True).click()
            expect(page.locator('#operationDialog')).to_be_visible()
            if not confirm:
                page.locator('#operationDismiss').click()
                expect(page.locator('#operationDialog')).not_to_be_visible()
                return
            page.locator('#operationConfirm').click()
            expect(page.locator('.operation-notice')).to_contain_text('Core acknowledged: '+name,timeout=15000)
            expect(page.locator('#conn')).to_contain_text('Core snapshot',timeout=15000)
        nav('Workers');select('qa-atlas');action('Drain worker',False);assert not posts
        page.locator('#drawerContent').get_by_role('button',name='Drain worker',exact=True).click()
        page.screenshot(path=str(pathlib.Path(tempfile.gettempdir())/'gpulink-operator-confirm.png'))
        page.locator('#operationDismiss').click();action('Drain worker')
        expect(page.locator('#drawerContent').get_by_role('button',name='Resume worker',exact=True)).to_be_enabled()
        page.screenshot(path=str(pathlib.Path(tempfile.gettempdir())/'gpulink-operator-drained.png'))
        action('Resume worker');expect(page.locator('#drawerContent').get_by_role('button',name='Drain worker',exact=True)).to_be_enabled()
        page.locator('#closeDrawer').click();nav('Jobs');page.locator('#recordFilter').select_option('pending');select('diagnostic.echo');action('Cancel job');expect(page.locator('#drawerContent')).to_contain_text('cancelled');assert page.locator('[data-operation="cancel-job"]').count()==0
        page.locator('#closeDrawer').click();nav('Sessions');select('diagnostic.echo');action('Close session');expect(page.locator('#drawerContent')).to_contain_text('closed')
        page.locator('#closeDrawer').click();nav('Workers');select('qa-atlas')
        assert [post['action'] for post in posts]==['drain','resume','cancel-job','close-session']
        p.stdin.write('disconnect\n');p.stdin.flush();assert p.stdout.readline().strip()=='QA Core stopped'
        page.locator('#refresh').click();expect(page.locator('#conn')).to_contain_text('Snapshot stale',timeout=15000);expect(page.locator('[data-operation="drain"]')).to_be_disabled()
        assert not errors,errors
        print('PASS: confirmation dismissal, four real gateway actions, authoritative refresh, stale disable, no JavaScript errors')
        browser.close()
finally:
    p.stdin.close();p.terminate();p.wait(timeout=10)
