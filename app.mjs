import { SERVICE, WRITE, NOTIFY, makeMotorPacket, makePollyPackets, LatestWriter } from './protocol.mjs?v=20261013-plmx';
const $=id=>document.getElementById(id);
const sliders=[$('motor1'),$('motor2')], delays=[1000,2000,4000,8000,8000];
let device=null, characteristic=null, writer=null, connecting=false, stopping=false;
let wanted=false, timer=null, retries=0, generation=0, controlRevision=0, attemptActive=false;
let pageActive=true;
let lastLevels=[0,0], savedLevels=null, restoreDeadline=0, pendingStop=false;
let connectedAt=0, lastWriteAt=0, disconnectCount=0, wakeLock=null;
const models={qcsw:{prefix:'QCSW',title:'迷路 · 吮吸版'},plmx:{prefix:'PLMX',title:'Polly Max · PLMX'}};
let model='qcsw', choosing=false, switching=false, selectionEpoch=0;
const knownDevices=new Map(), quickLevels=[0,25,50,75,100];
const quickButtons=sliders.map((_,i)=>quickLevels.map(level=>$('quick'+(i+1)+'-'+level)));
const logs=[];
function log(message){
  logs.push(new Date().toLocaleTimeString('zh-CN')+' '+message);
  if(logs.length>100)logs.shift();
  $('log').textContent=logs.join('\n');
}
function feedback(message,error=false){$('feedback').textContent=message;$('feedback').classList.toggle('error',error);}
function connected(){return Boolean(device?.gatt?.connected && characteristic);}
function canOperate(){return pageActive && (!document.hidden || $('backgroundMode').checked);}
function render(){
  const on=connected(), retrying=timer!==null;
  const busy=stopping || connecting || attemptActive || switching || choosing;
  sliders.forEach(el=>el.disabled=!on || busy);
  quickButtons.forEach((buttons,i)=>buttons.forEach((button,j)=>{
    button.disabled=!on || busy;
    button.setAttribute('aria-pressed',String(on && lastLevels[i]===quickLevels[j]));
  }));
  $('connect').disabled=busy || retrying || !navigator.bluetooth || !window.isSecureContext;
  $('connect').firstChild.textContent=choosing?'正在选择设备… ':switching?'正在切换设备… ':connecting?'正在连接… ':retrying?'正在自动重连… ':on?'添加 / 识别设备 ':wanted?'重新连接 ':'连接 / 自动识别设备 ';
  $('disconnect').hidden=!wanted && !on && !connecting;
  $('disconnect').disabled=stopping || switching || choosing;
  $('disconnect').textContent=on?'停止并断开连接':'取消重连';
  $('stop').disabled=(!on && !wanted) || stopping;
  $('swap').disabled=on || wanted || busy;
  $('resume').hidden=!on || !savedLevels || busy;
  $('status').textContent=connecting||retrying?'连接中':on?'已连接':'未连接';
  $('status').classList.toggle('connected',on);
  $('stopHint').textContent=stopping?'正在发送停止…':on?'本机蓝牙已连接':wanted?'连接中断 · 可取消恢复':'等待设备连接';
  renderDevices(busy);
}
function readouts(){sliders.forEach((el,i)=>{
  $('value'+(i+1)).replaceChildren(document.createTextNode(el.value),Object.assign(document.createElement('small'),{textContent:'%'}));
  el.style.setProperty('--fill',el.value+'%');
});}
function showLevels(levels){sliders.forEach((el,i)=>el.value=levels[i]);readouts();}
function packet(levels){
  const values=$('swap').checked?[levels[1],levels[0]]:levels;
  return {frames:model==='plmx'?makePollyPackets(...values):[makeMotorPacket(...values)],revision:controlRevision,nonzero:values.some(Boolean)};
}
function clearRestore(){controlRevision++;lastLevels=[0,0];savedLevels=null;restoreDeadline=0;showLevels([0,0]);}
function cancelTimer(){if(timer!==null)clearTimeout(timer);timer=null;}
function clearLink(){writer?.reset();writer=null;characteristic=null;}
function releaseWakeLock(){wakeLock?.release().catch(()=>{});wakeLock=null;}
async function keepScreenAwake(){
  if(!navigator.wakeLock || document.hidden || !wanted || wakeLock)return;
  try{
    const lock=await navigator.wakeLock.request('screen');
    if(document.hidden || !wanted){await lock.release();return;}
    wakeLock=lock;lock.addEventListener('release',()=>{if(wakeLock===lock)wakeLock=null;});
  }catch{/* Optional browser feature. */}
}
async function writeTo(target,bytes){
  if(!device?.gatt?.connected || target!==characteristic)throw new Error('蓝牙连接已断开');
  if(target.properties.writeWithoutResponse && target.writeValueWithoutResponse)await target.writeValueWithoutResponse(bytes);
  else if(target.properties.write && target.writeValueWithResponse)await target.writeValueWithResponse(bytes);
  else if((target.properties.write || target.properties.writeWithoutResponse) && target.writeValue)await target.writeValue(bytes);
  else throw new Error('此浏览器或设备没有可用的蓝牙写入方法');
  if(target!==characteristic || !device.gatt.connected)throw new Error('写入期间蓝牙已断开');
  lastWriteAt=Date.now();log('TX '+Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join(' '));
}
async function sendLevels(levels){
  const activeWriter=writer, current=generation, revision=++controlRevision;
  if(!connected() || !activeWriter || stopping || switching || choosing || !canOperate())return false;
  try{
    const sent=await activeWriter.send(packet(levels));
    if(!sent || current!==generation || revision!==controlRevision || activeWriter!==writer)return false;
    lastLevels=[...levels];savedLevels=null;pendingStop=false;showLevels(levels);render();return true;
  }catch(error){
    if(current!==generation || revision!==controlRevision)return false;
    feedback('写入失败：'+error.message+'。请确认设备状态。',true);log('写入失败：'+error.message);
    if(!device.gatt.connected)disconnected();
    return false;
  }
}
async function stop(){
  // Cancel restoration synchronously, even when no Bluetooth link is available.
  clearRestore();pendingStop=true;render();
  if(!connected() || !writer){
    feedback('已取消强度恢复。重连后会发送停止；当前如仍在运行，请用设备按键停止。',true);return false;
  }
  if(stopping)return false;
  const activeWriter=writer, current=generation;
  stopping=true;render();
  try{
    const sent=await activeWriter.stop(packet([0,0]));
    if(!sent || current!==generation || writer!==activeWriter)return false;
    pendingStop=false;feedback('停止指令已写入蓝牙，请确认设备已停止。');return true;
  }catch(error){
    if(current===generation){log('停止失败：'+error.message);feedback('停止指令未送达，请使用设备实体按键停止。',true);}
    return false;
  }finally{if(current===generation){stopping=false;render();}}
}
function scheduleReconnect(){
  if(!wanted || !device || !canOperate() || choosing || connecting || attemptActive || timer!==null)return;
  if(retries>=delays.length){
    clearRestore();pendingStop=true;releaseWakeLock();
    feedback('自动重连未成功。请将设备靠近手机，点击“重新连接”。',true);
    $('connectionHint').textContent='已暂停重试，可重新连接或取消。';render();return;
  }
  const delay=delays[retries++];
  log('自动重连 '+retries+'/'+delays.length+'，'+delay/1000+' 秒后尝试');
  $('connectionHint').textContent='连接中断，正在自动重连（'+retries+'/'+delays.length+'）。';
  timer=setTimeout(()=>{timer=null;void connectGatt(true);},delay);render();
}
function disconnected(){
  const wasReady=Boolean(characteristic);
  generation++;connecting=false;stopping=false;clearLink();
  if(wasReady){
    disconnectCount++;
    log('蓝牙断开 #'+disconnectCount+'；本次连接 '+Math.round((Date.now()-connectedAt)/1000)+' 秒；距写入 '+(lastWriteAt?Math.round((Date.now()-lastWriteAt)/1000)+' 秒':'未写入')+'；页面 '+(document.hidden?'后台':'前台'));
    if(wanted && canOperate() && lastLevels.some(Boolean)){
      if(!savedLevels)restoreDeadline=Date.now()+30000;
      savedLevels=[...lastLevels];
    }
    showLevels([0,0]);
  }
  if(wanted){feedback('蓝牙已断开，正在尝试恢复连接；断开期间网页无法控制设备。',true);scheduleReconnect();}
  render();
}
async function connectGatt(recovering){
  if(!wanted || !device || attemptActive || !canOperate())return;
  const selected=device, current=++generation;
  const valid=()=>current===generation && wanted && device===selected && canOperate();
  connecting=true;attemptActive=true;render();
  try{
    const gatt=selected.gatt.connected?selected.gatt:await selected.gatt.connect();
    if(!valid()){selected.gatt.disconnect();return;}
    const service=await gatt.getPrimaryService(SERVICE);
    if(!valid())return;
    const target=await service.getCharacteristic(WRITE);
    if(!valid())return;
    if(!target.properties.write && !target.properties.writeWithoutResponse)throw new Error('特征不可写，可能是不同批次协议');
    // Serialize discovery before enabling output; never reuse disconnected GATT attributes.
    try{
      const notification=await service.getCharacteristic(NOTIFY);
      if(!valid())return;
      if(notification.properties.notify){
        notification.addEventListener('characteristicvaluechanged',event=>{
          if(!valid())return;
          const value=event.target.value;
          log('RX '+Array.from(new Uint8Array(value.buffer,value.byteOffset,value.byteLength),x=>x.toString(16).padStart(2,'0')).join(' '));
        });
        await notification.startNotifications();
      }
    }catch(error){if(valid())log('通知不可用：'+error.message);}
    if(!valid())return;
    if(!selected.gatt.connected)throw new Error('连接在发现服务时中断');
    characteristic=target;writer=new LatestWriter(async batch=>{
      for(const bytes of batch.frames){
        if(batch.nonzero && batch.revision!==controlRevision)return;
        await writeTo(target,bytes);
      }
    });
    connectedAt=Date.now();lastWriteAt=0;connecting=false;
    log((recovering?'重连成功':'连接成功')+'；write='+target.properties.write+' / writeWithoutResponse='+target.properties.writeWithoutResponse);
    $('deviceName').textContent=(selected.name||models[model].prefix)+' · 本机蓝牙直连';
    $('connectionHint').textContent='意外断线会自动重连。后台行为由下方开关控制。';
    if(recovering || pendingStop){
      const restore=savedLevels && $('autoResume').checked && Date.now()<=restoreDeadline && !pendingStop;
      if(restore){
        if(await sendLevels([...savedLevels]))feedback('已自动重连，并重新写入断线前的强度。');
      }else{
        const revision=controlRevision, saved=savedLevels;
        const sent=await writer.stop(packet([0,0]));
        if(!valid() || revision!==controlRevision)return;
        if(sent)pendingStop=false;
        lastLevels=[0,0];showLevels([0,0]);savedLevels=saved;
        feedback(saved?'蓝牙已恢复。点击“恢复刚才的强度”继续。':'蓝牙已恢复，已发送停止指令。');
      }
    }else{
      showLevels([0,0]);feedback('连接成功，尚未发送电机指令。请先调节一个通道测试。');
    }
    if(valid()){retries=0;render();void keepScreenAwake();}
  }catch(error){
    if(!valid())return;
    log('连接失败：'+error.message);disconnected();
    if(selected.gatt.connected)selected.gatt.disconnect();
  }finally{
    attemptActive=false;
    if(current===generation)connecting=false;
    if(wanted && !connected())scheduleReconnect();
    render();
  }
}
function identifyModel(selected){
  const name=selected.name||'';
  return Object.keys(models).find(key=>name.startsWith(models[key].prefix));
}
function rememberDevice(selected){
  if(!identifyModel(selected))return null;
  const key=selected.id||selected;
  if(!knownDevices.has(key)){
    knownDevices.set(key,selected);
    selected.addEventListener('gattserverdisconnected',onGattDisconnected);
  }
  return knownDevices.get(key);
}
function renderDevices(busy){
  const buttons=[...knownDevices.values()].map(selected=>{
    const button=document.createElement('button');
    const active=selected===device && connected();
    const status=active?'当前控制':selected===device && (connecting || timer!==null)?'连接中':selected.gatt?.connected?'已连接 · 点击切换':'未连接 · 点击连接';
    button.type='button';button.className='device-choice';
    button.textContent=(selected.name||models[identifyModel(selected)].title)+' · '+status;
    button.disabled=busy || active || !canOperate() || !navigator.bluetooth || !window.isSecureContext;
    button.setAttribute('aria-pressed',String(active));
    button.addEventListener('click',()=>selectDevice(selected));
    return button;
  });
  $('deviceList').replaceChildren(...buttons);
  $('devicesEmpty').hidden=buttons.length>0;
}
async function restoreDevices(){
  if(!navigator.bluetooth || !window.isSecureContext)return;
  if(typeof navigator.bluetooth.getDevices!=='function'){
    $('devicesHint').textContent='当前浏览器仅保留本次打开页面添加的设备；刷新后请重新添加。';return;
  }
  try{
    const granted=await navigator.bluetooth.getDevices();
    if(!pageActive)return;
    granted.forEach(rememberDevice);render();
    $('devicesHint').textContent='已授权设备会显示在列表中；未连接不代表关机，点击即可尝试连接。';
  }catch{
    $('devicesHint').textContent='暂时无法读取已授权设备，可点击上方按钮重新添加。';
  }
}
function updateModel(next){
  model=next;$('swap').checked=false;
  const polly=model==='plmx';
  $('deviceTitle').textContent=models[model].title;
  $('deviceName').textContent=(device?.name||models[model].prefix)+' · 低功耗蓝牙';
  $('modelHint').textContent=polly?'已识别 Polly：通道 1 为旋转，通道 2 为吮吸。':'已识别迷路·吮吸版：通道 1 为震动，通道 2 为吮吸。';
  $('label1').textContent=polly?'旋转 · 通道 1':'震动 · 通道 1';
  $('label2').textContent='吮吸 · 通道 2';
  $('swapLabel').textContent=polly?'交换旋转与吮吸通道':'交换震动与吮吸通道';
}
function onGattDisconnected(event){
  if(event.target===device && (characteristic || connecting))disconnected();
  else render();
}
async function selectDevice(selected){
  if(switching || choosing || stopping || connecting || attemptActive || !canOperate())return;
  const next=identifyModel(selected);
  if(!next){feedback('无法识别此设备，仅支持 QCSW 与 PLMX。',true);return;}
  selected=rememberDevice(selected);
  if(selected===device && connected())return;
  const previous=device, wasWanted=wanted, selection=++selectionEpoch;
  let committed=false;
  switching=true;wanted=false;cancelTimer();render();
  try{
    if(connected() && !await stop()){
      feedback('上一台设备的停止指令未送达，未切换设备。请先确认上一台已停止。',true);return;
    }
    if(selection!==selectionEpoch || !canOperate())return;
    generation++;clearRestore();clearLink();pendingStop=false;
    device=selected;updateModel(next);wanted=true;retries=0;committed=true;
    log('自动识别：'+selected.name+'；切换后从零强度开始');
    await connectGatt(false);
  }finally{
    switching=false;
    if(!committed && device===previous && pageActive){wanted=wasWanted;if(wanted && !connected())scheduleReconnect();}
    render();
  }
}
$('connect').addEventListener('click',async()=>{
  if(choosing || switching || stopping || connecting || attemptActive || timer!==null)return;
  if(!navigator.bluetooth || !window.isSecureContext){feedback('请用 Bluefy 打开受信任的 HTTPS 页面。',true);return;}
  if(wanted && device && !connected()){retries=0;await connectGatt(true);return;}
  const selection=++selectionEpoch;
  choosing=true;render();
  try{
    const selected=await navigator.bluetooth.requestDevice({filters:[{namePrefix:'QCSW'},{namePrefix:'PLMX'}],optionalServices:[SERVICE]});
    choosing=false;
    if(selection===selectionEpoch && canOperate())await selectDevice(selected);
  }catch(error){
    feedback(error.name==='NotFoundError'?'未选择设备；当前连接保持不变。':'选择设备失败：'+error.message,true);
  }finally{choosing=false;if(wanted && !connected())scheduleReconnect();render();}
});
quickButtons.forEach((buttons,i)=>buttons.forEach((button,j)=>button.addEventListener('click',async()=>{
  if(button.disabled)return;
  const levels=[...lastLevels];levels[i]=quickLevels[j];
  if(await sendLevels(levels))feedback('已写入 '+quickLevels[j]+'% 强度，请以设备实际反应为准。');
})));
sliders.forEach(el=>{
  el.addEventListener('input',readouts);
  el.addEventListener('change',async()=>{
    if(await sendLevels(sliders.map(el=>Number(el.value))))feedback('指令已写入蓝牙，请以设备实际反应为准。');
  });
});
$('stop').addEventListener('click',stop);
$('resume').addEventListener('click',async()=>{
  if(savedLevels && await sendLevels([...savedLevels]))feedback('已重新写入刚才的强度。');
});
$('disconnect').addEventListener('click',async()=>{
  selectionEpoch++;wanted=false;cancelTimer();log('用户主动停止并断开；取消自动重连');
  const selected=device, sent=await stop();
  generation++;connecting=false;stopping=false;clearLink();selected?.gatt?.disconnect();releaseWakeLock();render();
  $('connectionHint').textContent='已取消重连。再次使用请点击连接。';
  feedback(sent?'停止指令已写入，蓝牙已断开；请确认设备停止。':'已取消连接与强度恢复。设备如仍运行，请用实体按键停止。',!sent);
});
$('autoResume').addEventListener('change',()=>log('短暂断线后自动恢复强度：'+($('autoResume').checked?'开启':'关闭')));
$('backgroundMode').addEventListener('change',()=>{
  log('切到后台继续运行：'+($('backgroundMode').checked?'开启':'关闭'));
  feedback($('backgroundMode').checked?'已开启后台继续运行。请在 Bluefy 中允许设备后台连接；实际效果需手机实测。':'已关闭后台继续运行，切到后台时会尝试停止。');
  if(document.hidden)handleVisibility();
});
$('swap').addEventListener('change',()=>log('交换通道：'+($('swap').checked?'开启':'关闭')));
$('copyLog').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText('KissToy Local / 2026-10-13 / '+models[model].prefix+'\n'+navigator.userAgent+'\n'+logs.join('\n'));$('copyLog').textContent='已复制';}
  catch{feedback('无法自动复制，请长按下方诊断记录复制。',true);}
});
function pauseForBackground(){
  selectionEpoch++;log('页面进入后台；取消强度恢复');cancelTimer();void stop();releaseWakeLock();
  if(connecting){generation++;connecting=false;clearLink();device?.gatt?.disconnect();}
  render();
}
function handleVisibility(){
  if(document.hidden && canOperate()){
    log('页面进入后台；保留当前强度，继续运行已开启');releaseWakeLock();
    if(wanted && !connected())scheduleReconnect();
  }else if(document.hidden)pauseForBackground();
  else{log('页面回到前台');if(wanted && !connected())scheduleReconnect();else void keepScreenAwake();}
}
document.addEventListener('visibilitychange',handleVisibility);
window.addEventListener('pagehide',()=>{
  // Navigation/closing is distinct from switching apps; never resume an abandoned page.
  pageActive=false;log('页面离开；尝试停止并取消恢复');pauseForBackground();
  for(const selected of knownDevices.values())if(selected!==device && selected.gatt?.connected)selected.gatt.disconnect();
});
window.addEventListener('pageshow',()=>{
  pageActive=true;
  if(wanted && !connected())scheduleReconnect();
});
if(!window.isSecureContext){$('compat').hidden=false;$('compat').textContent='当前页面不是安全连接。请使用本网页的 HTTPS 地址，并在 Bluefy 中打开。';}
else if(!navigator.bluetooth){$('compat').hidden=false;$('compat').textContent='当前浏览器不支持网页蓝牙。iPhone 请用 Bluefy 打开本页，Safari / Chrome 无法直接连接。';}
log('快捷切换版 2026-10-13。后台继续运行默认关闭；控制仅在本机蓝牙完成。');render();void restoreDevices();
