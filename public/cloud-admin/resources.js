import { projectAccounts, brandName, resourceLabels } from './resource-model.mjs';
import { createResourceTree, renderResourceDetail } from './resource-tree.js';
const $ = id => document.getElementById(id);
let session = null, connections = [], sources = [], generation = 0, busy = false, lastRead = 0, createId = crypto.randomUUID(), view = 'account';
let budgetTarget = null, detailFocus = null, budgetFocus = null;
const notice = (text, tone='info') => { $('resource-notice').textContent=text; $('resource-notice').dataset.tone=tone; };
const loading = text => { $('resource-loading').textContent=text; };
const dialogNotice = (text, tone='info') => { $('resource-dialog-notice').textContent=text; $('resource-dialog-notice').dataset.tone=tone; };
const budgetNotice = (text, tone='info') => { $('resource-budget-notice').textContent=text; $('resource-budget-notice').dataset.tone=tone; };
const clearSecret = () => { $('resource-token').value=''; };
function controls() { $('resource-fields').disabled=busy || !session; $('resource-budget-fields').disabled=busy || !session; }
function restoreFocus(previous) {
  let target = previous?.isConnected ? previous : null;
  if (!target && previous) {
    const key = previous.closest('[data-node-key]')?.dataset.nodeKey, item = previous.closest('li')?.dataset.id;
    const role = ['detail', 'use', 'budget'].find(role => previous.hasAttribute('data-' + role));
    const node = key && $('resource-accounts').querySelector(`[data-node-key="${CSS.escape(key)}"]`);
    if (node && role) target = node.querySelector((item ? `li[data-id="${CSS.escape(item)}"] ` : '') + `[data-${role}]`);
  }
  (target || $('resource-view-' + (view === 'account' ? 'account' : 'kind'))).focus();
}
const tree = createResourceTree($('resource-accounts'), {
  use: (...args) => void useResource(...args),
  more: (source, button) => void more(source, button),
  detail: (group, entry, button) => {
    detailFocus = button; $('resource-detail-title').textContent = entry.item.name;
    renderResourceDetail($('resource-detail'), group, entry); $('resource-detail-dialog').showModal(); $('resource-detail-close').focus();
  },
  budget: (group, button) => {
    if (busy || !session || !group.readySource) return;
    budgetTarget = { group, version: generation }; budgetFocus = button;
    $('resource-budget-title').textContent = resourceLabels[group.kind] + ' · 规划容量';
    $('resource-budget-account').textContent = brandName(group.account.provider) + ' · ' + group.account.name;
    $('resource-budget-value').value = group.budget.value === null ? '' : String(group.budget.value / 1e9);
    budgetNotice(''); $('resource-budget-dialog').showModal(); $('resource-budget-value').focus();
  },
});
function invalidate() {
  generation++;busy=false;session=null;connections=[];sources=[];budgetTarget=null;clearSecret();tree.clear();loading('');
  $('resource-detail-dialog').close();$('resource-budget-dialog').close();$('resource-detail').replaceChildren();controls();
}
async function request(path, body) {
  const version=generation;
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',headers:body?{'content-type':'application/json','x-csrf-token':session?.csrf??''}:{},...(body?{body:JSON.stringify(body)}:{})});
  if(response.status===403){if(version===generation){invalidate();notice('身份验证失败，请重新登录','error');if($('resource-dialog').open)dialogNotice('身份验证失败，请重新登录','error');}throw new Error('身份验证失败，请重新登录');}
  if(!response.ok)throw new Error(body?.action === 'budget' ? '规划保存未确认，请重新读取后核对。' : body && !['inventory','usage'].includes(body.action) ? '保存或选用未确认，请检查密钥、权限和连接容量。' : '读取失败，请检查权限或平台状态。');
  return response.json();
}
function render() { tree.render(projectAccounts(sources), view); }
function types(row) { return row.provider==='cloudflare'?['worker','d1','kv','r2','zone']:['repository']; }
async function readKind(source, version, cursor='') {
  let current=cursor,pages=0;const seen=new Set([cursor]);source.status='loading';
  try {
    do {
      const pageCursor=current;
      const data=await request('/api/admin/resources',{action:'inventory',connectionId:source.row.id,kind:source.kind,cursor:current});
      if(version!==generation)return;
      if(data.connectionRevision!==source.row.revision)throw new Error('连接已变更');
      for(const item of data.items)if(!source.items.some(existing=>existing.id===item.id))source.items.push({...item,cursor:pageCursor});
      current=data.next||'';pages++;source.next=current;
      if(current){if(seen.has(current))throw new Error('分页未前进，列表不完整');seen.add(current);}
    } while(current && pages<5);
    source.status=current?'partial':'complete';
  }catch(error){if(version===generation){source.status='error';source.error=error.message;}}
  if(version===generation)render();
}
async function readUsage(source,version){
  if(['repository','zone'].includes(source.kind))return;
  try{
    const result=await request('/api/admin/resources',{action:'usage',connectionId:source.row.id,kind:source.kind});
    if(version!==generation)return;
    if(result.connectionRevision!==source.row.revision)throw new Error('连接已变更');source.usage=result;
  }catch{if(version===generation)source.usage={status:'unavailable',metrics:[],samples:{}};}
  if(version===generation)render();
}
async function more(source,button){
  if(busy || !session || !source.next)return;
  const version=generation;busy=true;controls();button.disabled=true;
  try{await readKind(source,version,source.next);}finally{if(version===generation){busy=false;controls();}}
}
async function refresh() {
  if(busy || document.hidden)return;
  const version=++generation;busy=true;controls();notice('');loading('正在读取账户与云资源');
  try {
    const state=await request('/api/admin/state');if(version!==generation)return;
    if(!state.connectionsEnabled)throw new Error('连接管理尚未启用');session=state;
    const result=await request('/api/admin/connections');if(version!==generation)return;connections=result.connections;
    sources=connections.filter(row=>!row.parentId).flatMap(row=>types(row).map(kind=>({row,kind,items:[],next:'',status:row.state==='verified'?'loading':'disabled',usage:null})));
    render();let next=0;const tasks=sources.filter(source=>source.row.state==='verified');
    const read=async()=>{while(next<tasks.length && version===generation){const source=tasks[next++];await readKind(source,version);if(version===generation)await readUsage(source,version);}};
    await Promise.all([read(),read()]);if(version===generation){lastRead=Date.now();notice('');}
  }catch(error){if(version===generation){invalidate();notice(error.message,'error');}}
  finally{if(version===generation){busy=false;controls();loading('');}}
}
async function save(event) {
  event.preventDefault();if(busy || !session)return;
  const body={action:'connect',id:createId,name:$('resource-name').value,provider:document.querySelector('[name="resource-brand"]:checked').value,token:$('resource-token').value,accountId:$('resource-account-id').value.trim()};
  const version=generation;busy=true;controls();clearSecret();notice('正在添加账户…');dialogNotice('添加中…');
  try {
    await request('/api/admin/connections',body);if(version!==generation)return;
    createId=crypto.randomUUID();$('resource-form').reset();providerChanged();$('resource-dialog').close();
    busy=false;await refresh();
  }catch(error){if(version===generation){notice(error.message,'error');dialogNotice(error.message,'error');}}
  finally{body.token=undefined;if(version===generation){busy=false;controls();}}
}
async function saveBudget(clear=false){
  if(busy || !session || !budgetTarget || budgetTarget.version!==generation)return;
  if(!clear && !$('resource-budget-value').reportValidity())return;
  const {group}=budgetTarget,version=generation,value=clear?null:Math.round(Number($('resource-budget-value').value)*1e9),row=group.readySource.row;
  busy=true;controls();budgetNotice('正在保存…');
  try{
    const result=await request('/api/admin/resources',{action:'budget',connectionId:row.id,connectionRevision:row.revision,kind:group.kind,revision:group.budget.revision,value});
    if(version!==generation)return;
    for(const source of sources)if(source.row.provider===row.provider && source.row.target===row.target && source.kind===group.kind){source.usage??={status:'unavailable',metrics:[],samples:{}};source.usage.budget=result.budget;}
    render();$('resource-budget-dialog').close();
  }catch(error){if(version===generation)budgetNotice(error.message,'error');}
  finally{if(version===generation){busy=false;controls();}}
}
async function useResource(row,kind,item,cursor,button) {
  if(busy || !session)return;const version=generation;busy=true;controls();button.disabled=true;notice('正在核对所选资源…');
  try {
    const params=new URLSearchParams();
    if(kind==='repository'){
      let connection=row;
      if(row.target.startsWith('@'))({connection}=await request('/api/admin/connections',{action:'use-repository',id:row.id,revision:row.revision,repository:item.id}));
      params.set('github',connection.id);
    }else{
      const listing=await request('/api/admin/resources',{action:'discover',connectionId:row.id,kind,cursor});if(version!==generation)return;
      const result=await request('/api/admin/resources',{action:'register',connectionId:row.id,kind,listingId:listing.id,resourceId:item.id});if(version!==generation)return;
      params.set('cloudflare',row.id);params.set('resource',result.resource.id);
    }
    if(version===generation)location.assign('/deploy#'+params);
  }catch(error){if(version===generation)notice(error.message,'error');}
  finally{if(version===generation){busy=false;controls();button.disabled=false;}}
}
function providerChanged(){clearSecret();dialogNotice('');$('resource-account-id').value='';const github=document.querySelector('[name="resource-brand"]:checked').value==='github';$('resource-account-field').hidden=github;$('resource-account-id').disabled=github;$('resource-token-label').textContent=github?'GitHub PAT':'API Token';}
for(const radio of document.querySelectorAll('[name="resource-brand"]'))radio.addEventListener('change',providerChanged);
for(const [id,mode] of [['resource-view-account','account'],['resource-view-kind','resource']])$(id).addEventListener('click',()=>{view=mode;$('resource-view-account').setAttribute('aria-pressed',String(mode==='account'));$('resource-view-kind').setAttribute('aria-pressed',String(mode==='resource'));render();});
$('resource-add').addEventListener('click',()=>{if(!busy)dialogNotice(session?'':'身份验证失败，请重新登录',session?'info':'error');$('resource-dialog').showModal();($('resource-fields').disabled?$('resource-close'):document.querySelector('[name="resource-brand"]:checked')).focus();});
$('resource-close').addEventListener('click',()=>$('resource-dialog').close());
$('resource-dialog').addEventListener('close',()=>{clearSecret();$('resource-add').focus();});
$('resource-detail-close').addEventListener('click',()=>$('resource-detail-dialog').close());
$('resource-detail-dialog').addEventListener('close',()=>restoreFocus(detailFocus));
$('resource-budget-close').addEventListener('click',()=>$('resource-budget-dialog').close());
$('resource-budget-dialog').addEventListener('close',()=>{budgetTarget=null;restoreFocus(budgetFocus);});
$('resource-budget-form').addEventListener('submit',event=>{event.preventDefault();void saveBudget();});
$('resource-budget-clear').addEventListener('click',()=>void saveBudget(true));
$('resource-form').addEventListener('submit',save);
addEventListener('pagehide',invalidate);addEventListener('pageshow',event=>{if(event.persisted)void refresh();});
const dialogOpen=()=>document.querySelector('dialog[open]');
addEventListener('focus',()=>{if(Date.now()-lastRead>60000 && !dialogOpen())void refresh();});
addEventListener('visibilitychange',()=>{if(!document.hidden && Date.now()-lastRead>60000 && !dialogOpen())void refresh();});
providerChanged();void refresh();
