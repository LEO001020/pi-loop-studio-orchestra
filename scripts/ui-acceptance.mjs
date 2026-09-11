import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {APP_ROOT,uid,now,ensureDir,writeJSON} from '../server/util.mjs';
import {loadSettings} from '../server/settings.mjs';

const base=`http://127.0.0.1:${loadSettings().port}`,id=uid(),dir=ensureDir(path.join(APP_ROOT,'validation',`ui-${id}`));
const report={started:now(),command:process.argv,cwd:APP_ROOT,environment:{node:process.version,platform:process.platform,arch:process.arch,browser:'Fresh Microsoft Edge Playwright context'},results:[],pageErrors:[],exitCode:null};
let browser,page,backup,testPresetName,themeChanged=false;
const request=async(url,method='GET',body)=>{const r=await fetch(base+'/api'+url,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});const data=await r.json();if(!r.ok)throw new Error(JSON.stringify(data));return data;};
async function check(name,fn){const started=Date.now();try{const evidence=await fn();report.results.push({name,pass:true,durationMs:Date.now()-started,evidence});console.log('PASS '+name);}catch(e){report.results.push({name,pass:false,error:e.stack});console.error('FAIL '+name+': '+e.message);await page?.screenshot({path:path.join(dir,`${name}-failure.png`),fullPage:true}).catch(()=>{});await page?.keyboard.press('Escape').catch(()=>{});}}
try{
  browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1512,height:982},locale:'zh-CN'});page=await context.newPage();page.on('pageerror',e=>report.pageErrors.push(e.message));backup=await request('/settings');
  await check('initial-render',async()=>{await page.goto(base);await page.getByText('本地引擎已连接',{exact:true}).waitFor({timeout:30000});await page.getByRole('textbox',{name:'消息输入'}).fill('可编辑，不需要注入');assert(await page.getByRole('button',{name:'发送消息'}).isEnabled());await page.getByRole('textbox',{name:'消息输入'}).fill('');await page.screenshot({path:path.join(dir,'01-welcome.png'),fullPage:true});return {screenshot:'01-welcome.png',noInjection:true};});
  const inspectIndex=process.argv.indexOf('--inspect-run');
  if(inspectIndex>=0)await check('real-task-workbench-graph-jobs-diff-receipts',async()=>{
    const inspected=await request(`/runs/${process.argv[inspectIndex+1]}`);assert.equal(inspected.run.status,'completed');
    const session=await request(`/sessions/${inspected.run.sessionId}`);
    if(session.session.archived)await page.getByRole('checkbox',{name:'显示归档会话'}).check();
    await page.locator(`.session-item[data-session-id="${session.session.id}"]`).click();
    await page.getByRole('combobox',{name:'选择任务回执'}).selectOption(inspected.run.id);
    await page.locator('.react-flow__node').first().waitFor({timeout:30000});
    await page.getByRole('button',{name:'加载完整图事件回放',exact:true}).click();await page.getByRole('slider',{name:'回放位置'}).waitFor();
    await page.screenshot({path:path.join(dir,'06-real-task-graph.png'),fullPage:true});
    await page.locator('.workbench-tabs button').filter({hasText:'岗位'}).click();
    await page.waitForFunction(n=>document.querySelectorAll('.job-row').length===n,inspected.jobs.length);
    assert.equal(await page.locator('.job-row').count(),inspected.jobs.length);assert(await page.locator('.audit-result.passed').count()>0);
    await page.screenshot({path:path.join(dir,'07-real-task-jobs.png'),fullPage:true});
    await page.locator('.workbench-tabs button').filter({hasText:'变更'}).click();await page.locator('.diff-card').first().locator('summary').click();
    assert((await page.locator('.diff-text').first().innerText()).length>10);
    await page.screenshot({path:path.join(dir,'08-real-task-diff.png'),fullPage:true});
    await page.locator('.workbench-tabs button').filter({hasText:'回执'}).click();await page.locator('.command-card').first().locator('summary').click();
    assert((await page.locator('.command-card').first().innerText()).includes('stdout'));
    await page.screenshot({path:path.join(dir,'09-real-task-receipts.png'),fullPage:true});
    return {runId:inspected.run.id,jobs:inspected.jobs.length,spent:inspected.run.spent,graphReplay:true,diffVisible:true,commandsVisible:true};
  });
  await check('real-hello-send-and-reload',async()=>{
    await page.getByRole('button',{name:'新建对话'}).click();await page.getByRole('combobox',{name:'工作模式'}).selectOption('auto');
    const preset=backup.presets[0];assert(preset,'A valid saved role preset is needed for UI acceptance');
    await page.getByRole('combobox',{name:'下次任务岗位预设'}).selectOption(preset.id);await page.getByRole('spinbutton',{name:'下次任务预算',exact:true}).fill('123456');
    await page.getByRole('textbox',{name:'消息输入'}).fill('你好。请用一句中文回应，并准确说明这只是对话，没有执行文件任务。');await page.getByRole('button',{name:'发送消息'}).click();
    // assistant-ui may render its empty streaming message before the response
    // arrives. Await actual content, not merely the placeholder container.
    await page.waitForFunction(()=>Array.from(document.querySelectorAll('.assistant-message .markdown')).some(el=>(el.textContent||'').trim().length>5),undefined,{timeout:180000});
    const reply=await page.locator('.assistant-message .markdown').first().innerText();assert(reply.trim().length>5);assert.doesNotMatch(reply,/任务未启动|遇到明确阻塞|到预算阈值/);
    const sessionId=await page.evaluate(()=>localStorage.getItem('pi-loop-session'));const session=await request(`/sessions/${sessionId}`),run=await request(`/runs/${session.runs[0].id}`);
    assert.equal(run.run.status,'completed');assert(run.calls.some(c=>c.role==='auxiliary'&&c.status==='completed'&&c.tokens>0));
    assert(run.calls.some(c=>c.node==='routing')&&run.calls.some(c=>c.node==='chat'));assert.equal(run.jobs.length,0,'Auto-mode greeting must not manufacture a coding fan-out');
    assert.equal(run.run.budget,123456);assert.equal(run.run.settings.activePreset,preset.id);assert.deepEqual(run.run.settings.roles,preset.roles);assert.equal(run.run.settings.models.auxiliary.concurrency,preset.auxiliary);
    await page.reload();await page.locator('.assistant-message .markdown').first().waitFor({timeout:30000});assert.equal(await page.evaluate(()=>localStorage.getItem('pi-loop-session')),sessionId);assert.equal(await page.locator('.assistant-message .markdown').first().innerText(),reply);
    await page.screenshot({path:path.join(dir,'02-real-hello.png'),fullPage:true});return {sessionId,runId:run.run.id,reply,mode:'auto',taskBudget:run.run.budget,presetId:preset.id,actualTokens:run.run.spent,calls:run.calls,reloadPreserved:true,screenshot:'02-real-hello.png'};
  });
  await check('settings-preset-theme',async()=>{
    await page.getByRole('button',{name:'设置与模型'}).click();await page.getByRole('button',{name:'岗位与预设',exact:true}).click();const name=testPresetName=`界面验收-${id.slice(0,6)}`;
    await page.getByRole('textbox',{name:'新预设名称'}).fill(name);await page.getByRole('button',{name:'保存预设',exact:true}).click();await page.getByText(name,{exact:true}).waitFor();
    await page.getByRole('button',{name:'模型连接',exact:true}).click();assert.equal(await page.locator('input[type=password]').first().inputValue(),'');await page.screenshot({path:path.join(dir,'03-model-settings.png'),fullPage:true});
    await page.getByRole('button',{name:'任务与外观',exact:true}).click();await page.getByLabel('主题',{exact:true}).selectOption('light');await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});themeChanged=true;
    await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.theme==='light');const saved=await request('/settings');assert(saved.presets.some(p=>p.name===name));await page.screenshot({path:path.join(dir,'04-light.png'),fullPage:true});return {presetPersisted:true,themePersisted:true,credentialNotReturned:true};
  });
  await check('workspace-browser-and-budget',async()=>{
    await page.locator('.workspace-button').click();const dialog=page.locator('dialog');await dialog.getByRole('button',{name:/quant-foundry/}).waitFor();await dialog.getByRole('button',{name:/quant-g/}).waitFor();await dialog.getByRole('button',{name:'关闭',exact:true}).click();
    const budget=page.getByRole('spinbutton',{name:'本任务预算',exact:true});await budget.fill('42000');await page.getByRole('button',{name:'调整预算',exact:true}).click();await page.reload();await budget.waitFor();assert.equal(await budget.inputValue(),'42000');return {rootsVisible:['code','quant-foundry','quant-g'],runBudgetPersisted:42000};
  });
  await check('archive-and-restore-own-session',async()=>{
    const sessionId=await page.evaluate(()=>localStorage.getItem('pi-loop-session'));assert(sessionId);
    await page.getByRole('button',{name:'归档会话',exact:true}).click();
    await page.getByRole('checkbox',{name:'显示归档会话'}).check();
    await page.locator(`.session-item[data-session-id="${sessionId}"]`).click();
    await page.getByRole('button',{name:'恢复会话',exact:true}).click();
    await page.getByRole('button',{name:'归档会话',exact:true}).waitFor();
    const saved=await request(`/sessions/${sessionId}`);assert.equal(saved.session.archived,false);
    assert(saved.messages.length>0);return {sessionId,restored:true,messagesPreserved:saved.messages.length};
  });
  await check('missing-session-visible-recovery',async()=>{
    await page.evaluate(()=>localStorage.setItem('pi-loop-session','missing-session-for-ui-test'));await page.reload();await page.getByText(/之前选择的会话在此数据库中不存在/).waitFor({timeout:30000});
    await page.getByRole('textbox',{name:'消息输入'}).fill('仍可输入');assert(await page.getByRole('button',{name:'发送消息'}).isEnabled());await page.getByRole('textbox',{name:'消息输入'}).fill('');return {noInfiniteSpinner:true};
  });
  await check('generated-output-setting-persists',async()=>{
    await page.getByRole('button',{name:'设置与模型'}).click();await page.getByRole('button',{name:'运行与恢复',exact:true}).click();
    const field=page.getByRole('textbox',{name:'可再生构建输出目录（每行一个相对目录）'}),marker=`output-fixture-${id}`;
    await field.fill([...(backup.generatedDirectories||[]),marker].join('\n'));
    await page.getByRole('button',{name:'保存设置',exact:true}).click();await page.locator('dialog').waitFor({state:'hidden'});await page.reload();
    const saved=await request('/settings');assert(saved.generatedDirectories.includes(marker));
    await page.getByRole('button',{name:'设置与模型'}).click();await page.getByRole('button',{name:'运行与恢复',exact:true}).click();assert((await field.inputValue()).includes(marker));
    await page.screenshot({path:path.join(dir,'10-generated-outputs.png'),fullPage:true});await page.getByRole('button',{name:'取消',exact:true}).click();
    return {persisted:true,setting:'generatedDirectories',sourceExemption:false};
  });
  await check('mobile-layout',async()=>{
    await page.setViewportSize({width:390,height:844});await page.locator('.workbench').waitFor({state:'detached'});await page.getByRole('button',{name:'打开菜单'}).click();await page.getByRole('button',{name:'设置与模型'}).click();await page.getByRole('button',{name:'运行与恢复',exact:true}).click();await page.getByText('运行边界与恢复',{exact:true}).waitFor();
    await page.screenshot({path:path.join(dir,'05-mobile-settings.png'),fullPage:true});const bounds=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));assert(bounds.scroll<=bounds.width+2,JSON.stringify(bounds));return {viewport:[390,844],screenshot:'05-mobile-settings.png',bounds};
  });
}catch(e){report.results.push({name:'browser-or-bootstrap',pass:false,error:e.stack});console.error(e.stack);}
finally{
  // Remove only this run's test preset and restore the theme only if it still
  // has our test value. Never overwrite concurrent user changes to settings.
  if(backup)try{const current=await request('/settings');current.presets=current.presets.filter(p=>p.name!==testPresetName);current.generatedDirectories=(current.generatedDirectories||[]).filter(name=>name!==`output-fixture-${id}`);if(themeChanged&&current.theme==='light')current.theme=backup.theme;await request('/settings','PUT',current);}catch(e){report.results.push({name:'restore-settings',pass:false,error:e.message});}
  await browser?.close();
}
report.finished=now();report.exitCode=report.results.length>=6&&report.results.every(r=>r.pass)&&!report.pageErrors.length?0:1;writeJSON(path.join(dir,'receipt.json'),report);console.log(JSON.stringify({receipt:path.join(dir,'receipt.json'),exitCode:report.exitCode,pageErrors:report.pageErrors}));process.exitCode=report.exitCode;
