const $ = id => document.getElementById(id);
let session = null, connections = [], generation = 0, busy = false, lastRead = 0, createId = crypto.randomUUID();
const labels = { worker:'Workers', d1:'D1 数据库', kv:'KV 键值存储', r2:'R2 对象存储', repository:'GitHub 仓库' };
const notice = (text, tone='info') => { for (const id of ['resource-notice','resource-dialog-notice']) { $(id).textContent=text; $(id).dataset.tone=tone; } };
const clearSecret = () => { $('resource-token').value=''; };
function controls() { $('resource-fields').disabled=busy || !session; }
function invalidate() { generation++;busy=false;session=null;connections=[];clearSecret();$('resource-accounts').replaceChildren();controls(); }
async function request(path, body) {
  const version=generation;
  const response=await fetch(path,{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',headers:body?{'content-type':'application/json','x-csrf-token':session?.csrf??''}:{},...(body?{body:JSON.stringify(body)}:{})});
  if(response.status===403){if(version===generation){invalidate();notice('身份验证失败，请重新登录','error');}throw new Error('身份验证失败，请重新登录');}
  if(!response.ok)throw new Error(body && body.action!=='inventory' ? '保存或选用未确认，请检查密钥、账号读取权限和连接容量；没有自动重试。' : '读取失败：请检查权限或平台状态，不能据此判断资源为空。');
  return response.json();
}
const textNode=(tag,text,className)=>{const node=document.createElement(tag);node.textContent=text;if(className)node.className=className;return node;};
function types(row) { return row.provider==='cloudflare'?['worker','d1','kv','r2']:['repository']; }
async function readKind(row, kind, host, version, cursor='') {
  let current=cursor,pages=0,count=Number(host.dataset.count||0),seen=new Set();
  const status=host.querySelector('.inventory-status'),list=host.querySelector('ul');
  host.querySelector('button[data-more]')?.remove();status.textContent='正在读取…';status.dataset.tone='info';
  try {
    do {
      const pageCursor=current;
      const data=await request('/api/admin/resources',{action:'inventory',connectionId:row.id,kind,cursor:current});
      if(version!==generation)return;
      for(const item of data.items){
        if([...list.children].some(node=>node.dataset.id===item.id))continue;
        const li=document.createElement('li');li.dataset.id=item.id;li.append(textNode('p',item.name));
        if(item.id!==item.name)li.append(textNode('small',item.id));
        if(kind!=='worker' && item.available!==false){const button=document.createElement('button');button.type='button';button.textContent='用于部署';button.addEventListener('click',()=>void useResource(row,kind,item,pageCursor,button));li.append(button);}
        else li.append(textNode('small',kind==='worker'?'已有服务，仅展示；不会自动覆盖':item.reason==='unsupported-name'?'当前部署契约不支持此仓库名称':'仓库已归档或停用'));
        list.append(li);count++;
      }
      current=data.next||'';pages++;host.dataset.count=String(count);
      if(current){if(seen.has(current))throw new Error('分页未前进，列表不完整');seen.add(current);}
      status.textContent=`${count} 项 · ${new Date(data.checkedAt).toLocaleString()}`;
    } while(current && pages<5);
    if(!count)status.textContent='暂无可读取资源';
    if(current){status.textContent+= ' · 仍有未加载资源';const button=document.createElement('button');button.type='button';button.dataset.more='true';button.textContent='加载更多';button.addEventListener('click',async()=>{if(busy || version!==generation)return;busy=true;controls();button.disabled=true;try{await readKind(row,kind,host,version,current);}finally{if(version===generation){busy=false;controls();}}});host.append(button);}
  } catch(error) { if(version===generation){status.textContent=(count?'列表不完整 · ':'')+error.message;status.dataset.tone='error';} }
}
async function renderAccounts(version) {
  $('resource-accounts').replaceChildren();
  const roots=connections.filter(row=>!row.parentId);
  if(!roots.length){$('resource-accounts').append(textNode('p','尚未添加云账户，点击右上角“添加资源”连接品牌账户。','empty-state'));return;}
  for(const row of roots){
    if(version!==generation)return;
    const section=document.createElement('section'),heading=document.createElement('div');heading.className='section-heading';
    heading.append(textNode('h2',`${row.provider==='cloudflare'?'Cloudflare':'GitHub'} · ${row.accountName||row.target}`),textNode('span',row.name,'index'));
    section.append(heading,textNode('p',row.target,'account-target'));$('resource-accounts').append(section);
    if(row.state!=='verified'){section.append(textNode('p',row.state==='disabled'?'账户连接已停用':'账户验证失败；到连接设置检查凭据','section-note'));continue;}
    for(const kind of types(row)){
      const group=document.createElement('div');group.className='inventory-group';group.dataset.kind=kind;
      group.append(textNode('h3',labels[kind]),textNode('p','正在读取…','inventory-status'),document.createElement('ul'));section.append(group);
      await readKind(row,kind,group,version);if(version!==generation)return;
    }
  }
}
async function refresh() {
  if(busy || document.hidden)return;
  const version=++generation;busy=true;controls();notice('正在读取账户与云资源…');
  try {
    const state=await request('/api/admin/state');if(version!==generation)return;
    if(!state.connectionsEnabled)throw new Error('连接管理尚未启用');session=state;
    const result=await request('/api/admin/connections');if(version!==generation)return;connections=result.connections;
    await renderAccounts(version);if(version===generation){lastRead=Date.now();notice('已按账户更新资源；各类型的权限和读取结果见下方。');}
  }catch(error){if(version===generation){invalidate();notice(error.message,'error');}}
  finally{if(version===generation){busy=false;controls();}}
}
async function save(event) {
  event.preventDefault();if(busy || !session)return;
  const body={action:'connect',id:createId,name:$('resource-name').value,provider:document.querySelector('[name="resource-brand"]:checked').value,token:$('resource-token').value,accountId:$('resource-account-id').value.trim()};
  const version=generation;busy=true;controls();clearSecret();notice('正在验证并保存品牌密钥…');
  try {
    await request('/api/admin/connections',body);if(version!==generation)return;
    createId=crypto.randomUUID();$('resource-form').reset();providerChanged();$('resource-dialog').close();
    busy=false;await refresh();
  }catch(error){if(version===generation)notice(error.message,'error');}
  finally{body.token=undefined;if(version===generation){busy=false;controls();}}
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
function providerChanged(){clearSecret();$('resource-account-id').value='';const github=document.querySelector('[name="resource-brand"]:checked').value==='github';$('resource-account-field').hidden=github;$('resource-brand-help').textContent=github?'填写 GitHub PAT，保存后自动读取此凭据可访问的仓库。':'填写 Cloudflare API Token，自动识别可读取账户及其 Workers、D1、KV、R2。';}
for(const radio of document.querySelectorAll('[name="resource-brand"]'))radio.addEventListener('change',providerChanged);
$('resource-add').addEventListener('click',()=>{$('resource-dialog').showModal();($('resource-fields').disabled?$('resource-close'):document.querySelector('[name="resource-brand"]:checked')).focus();});
$('resource-close').addEventListener('click',()=>$('resource-dialog').close());
$('resource-dialog').addEventListener('close',()=>{clearSecret();$('resource-add').focus();});
$('resource-form').addEventListener('submit',save);
addEventListener('pagehide',invalidate);addEventListener('pageshow',event=>{if(event.persisted)void refresh();});
addEventListener('focus',()=>{if(Date.now()-lastRead>60000 && !$('resource-dialog').open)void refresh();});
addEventListener('visibilitychange',()=>{if(!document.hidden && Date.now()-lastRead>60000 && !$('resource-dialog').open)void refresh();});
providerChanged();void refresh();
