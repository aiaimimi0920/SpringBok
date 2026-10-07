const $ = id => document.getElementById(id);
let session, listing, busy = false, generation = 0;
const notice = (text, tone = 'info') => { $('resource-notice').textContent = text; $('resource-notice').dataset.tone = tone; };
function controls() { $('resource-fields').disabled = busy || !session; $('resource-refresh').disabled = busy; $('resource-next').disabled = busy || !listing?.next; }
function invalidate() { generation++; session = null; listing = null; $('resource-discovered').replaceChildren(); $('resource-registered').replaceChildren(); $('resource-connection').replaceChildren(); controls(); }
async function request(path, body) {
  const r = await fetch(path,{ method: body ? 'POST' : 'GET',credentials:'same-origin',redirect:'error',headers: body ? {'content-type':'application/json','x-csrf-token':session?.csrf ?? ''} : {},...(body ? {body:JSON.stringify(body)} : {}) });
  if (r.status === 403) { invalidate(); notice('身份验证失败，请重新登录', 'error'); throw new Error('身份验证失败，请重新登录'); }
  if (!r.ok) throw new Error('读取或登记失败，请检查身份、权限和连接状态，然后刷新；没有自动重试'); return r.json();
}
async function registered(version) {
  const value = await request('/api/admin/resources'); if (version !== generation) return;
  $('resource-registered').replaceChildren();
  for (const row of value.resources) { const li=document.createElement('li'); li.textContent=`${row.kind.toUpperCase()} · ${row.name} · ${row.remoteId} · ${row.available ? '已登记' : '连接已变化，请重新读取并登记'} · ${new Date(row.checkedAt).toLocaleString()}`; $('resource-registered').append(li); }
  if (!value.resources.length) $('resource-registered').textContent='尚无已登记资源';
}
async function refresh() {
  if(busy)return; invalidate(); const version=generation;busy=true;controls();
  try {
    const current=await request('/api/admin/state');if(version!==generation)return;
    if(!current.connectionsEnabled)throw new Error('连接管理尚未启用'); session=current;
    const {connections}=await request('/api/admin/connections');if(version!==generation)return;
    for(const row of connections.filter(r=>r.provider==='cloudflare'&&r.state==='verified')){const option=document.createElement('option');option.value=row.id;option.textContent=`${row.name} · ${row.target}`;$('resource-connection').append(option);}
    await registered(version);if(version===generation)notice($('resource-connection').options.length ? '请选择资源类型并读取' : '请先到连接设置添加可用的 Cloudflare 连接');
  } catch(error){if(version===generation){invalidate();notice(error.message, 'error');}}finally{busy=false;controls();}
}
async function discover(cursor='') {
  if(busy||!session||!$('resource-connection').value)return;
  const version=generation;busy=true;listing=null;$('resource-discovered').replaceChildren();controls();notice('正在读取云资源…');
  try{
    const value=await request('/api/admin/resources',{action:'discover',connectionId:$('resource-connection').value,kind:$('resource-kind').value,cursor});if(version!==generation)return;listing=value;
    for(const item of value.items){const li=document.createElement('li'),button=document.createElement('button'),label=document.createElement('p');label.textContent=`${item.name} · ${item.id}`;button.textContent='登记资源';button.type='button';button.addEventListener('click',()=>register(item,button));li.append(label,button);$('resource-discovered').append(li);}
    notice(value.items.length ? `本页 ${value.items.length} 项；列表 5 分钟内可登记` : '本页没有资源');
  }catch(error){if(version===generation)notice(error.message, 'error');}finally{busy=false;controls();}
}
async function register(item,button){
  if(busy||!session||!listing)return;const version=generation;busy=true;button.disabled=true;controls();
  try{await request('/api/admin/resources',{action:'register',connectionId:listing.connectionId,kind:listing.kind,listingId:listing.id,resourceId:item.id});if(version!==generation)return;await registered(version);notice('资源已登记，没有创建或修改云资源', 'success');button.textContent='已登记';}
  catch(error){if(version===generation)notice(error.message, 'error');}finally{busy=false;controls();}
}
$('resource-form').addEventListener('submit',event=>{event.preventDefault();void discover();});
$('resource-next').addEventListener('click',()=>{if(listing?.next)void discover(listing.next);});
for(const id of ['resource-kind','resource-connection'])$(id).addEventListener('change',()=>{listing=null;$('resource-discovered').replaceChildren();controls();});
$('resource-refresh').addEventListener('click',refresh);addEventListener('pagehide',invalidate);addEventListener('pageshow',event=>{if(event.persisted)void refresh();});void refresh();
