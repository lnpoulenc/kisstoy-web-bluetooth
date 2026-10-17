import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SERVICE, WRITE, makeMotorPacket } from '../protocol.mjs';

let importVersion=0;
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};

function eventTarget(extra={}) {
  const listeners=new Map();
  return Object.assign({
    addEventListener(type,listener){
      if(!listeners.has(type))listeners.set(type,new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type,listener){listeners.get(type)?.delete(listener);},
    async emit(type,extra={},wait=true){
      const event={type,target:this,...extra};
      const pending=[...listeners.get(type)||[]].map(listener=>listener(event));
      if(wait)await Promise.all(pending);
      await flush();
    },
  },extra);
}

test('automatic chooser offers QCSW and PLMX without a manual model selector',async t=>{
  const app=await harness(t);
  await app.click('connect');
  assert.deepEqual(app.chooserOptions.at(-1),{
    filters:[{namePrefix:'QCSW'},{namePrefix:'PLMX'}],optionalServices:[SERVICE],
  });
  assert.equal(app.element('modelSelect'),null);
  assert.deepEqual(app.writes,[],'choosing a model must not start output');
});

test('quick levels require a connection and preserve the other last confirmed channel',async t=>{
  const app=await harness(t);
  for(const channel of [1,2])for(const level of [0,25,50,75,100]){
    const button=app.element(`quick${channel}-${level}`);
    assert.ok(button,'quick level controls must exist in the real page');
    assert.equal(button.disabled,true,'quick levels must be disabled before connection');
  }
  await app.click('connect');await app.levels(20,40);
  app.element('motor2').value='95';await app.element('motor2').emit('input');
  await app.click('quick1-75');
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(75,40)]);
  app.element('motor1').value='90';await app.element('motor1').emit('input');
  await app.click('quick2-25');
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(75,25)]);
  await app.click('quick1-0');await app.click('quick2-100');
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(0,100)]);
  assert.equal(app.writes.at(-1).target,app.device.id);
});

test('authorized devices populate selectable disconnected rows without connecting or writing',async t=>{
  const app=await harness(t,{granted:[
    {id:'granted-q',name:'QCSW saved'},
    {id:'unrelated',name:'Other peripheral'},
    {id:'granted-p',name:'PLMX saved'},
  ]});
  assert.equal(app.getDevicesCalls,1,'initialization must read the previously granted device list');
  const rows=app.deviceButtons();
  assert.equal(rows.length,2,'only QCSW and PLMX belong in the control list');
  assert.match(rows[0].textContent,/QCSW saved/);assert.match(rows[1].textContent,/PLMX saved/);
  for(const row of rows){assert.match(row.textContent,/未连接/);assert.equal(row.disabled,false);}
  assert.equal(app.connectCalls,0);assert.equal(app.chooserCalls,0);assert.deepEqual(app.writes,[]);
  await app.clickDevice(1);
  assert.equal(app.grantedDevices[2].gatt.connected,true);
  assert.equal(app.chooserCalls,0,'selecting an authorized row must reuse its device object');
  assert.deepEqual(app.writes,[],'the initial authorized-device connection starts at zero without motor writes');
  assert.match(app.deviceButtons()[1].textContent,/当前控制/);
});

test('adding and switching devices waits for old stop and retains both live connections',async t=>{
  const app=await harness(t),second=app.createDevice('PLMX second','second-device');
  await app.click('connect');await app.levels(20,40);
  app.choose(second);
  assert.equal(app.element('connect').disabled,false,'the connected state must still permit adding another device');
  const release=app.holdNextWrite(),before=app.writes.length;
  const switching=app.click('connect');
  await release.started;
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(0,0)]);
  assert.equal(app.writes.at(-1).target,app.device.id);
  assert.equal(second.gatt.connected,false,'new control cannot connect before the old stop resolves');
  await release();await switching;
  assert.equal(app.device.gatt.connected,true,'switching keeps the stopped old device connected');
  assert.equal(second.gatt.connected,true);
  assert.equal(app.writes.length,before+1,'the new connection must not send startup control packets');
  assert.equal(Number(app.element('motor1').value),0);assert.equal(Number(app.element('motor2').value),0);
  let rows=app.deviceButtons();
  assert.equal(rows.length,2);
  assert.match(rows[0].textContent,/QCSW-test/);assert.match(rows[0].textContent,/已连接/);
  assert.doesNotMatch(rows[0].textContent,/当前控制/);
  assert.match(rows[1].textContent,/PLMX second/);assert.match(rows[1].textContent,/当前控制/);
  await app.levels(25,50);
  assert.ok(app.writes.slice(-3).every(write=>write.target===second.id));
  const beforeReturn=app.writes.length;
  await app.clickDevice(0);
  assert.equal(app.writes.length,beforeReturn+4,'switching away from PLMX sends its complete stop batch');
  assert.ok(app.writes.slice(beforeReturn).every(write=>write.target===second.id));
  assert.equal(app.connectionCount(app.device),1,'a live previous connection must be reused');
  rows=app.deviceButtons();assert.match(rows[0].textContent,/当前控制/);assert.match(rows[1].textContent,/已连接/);
  await app.levels(10,15);
  assert.equal(app.writes.at(-1).target,app.device.id);
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(10,15)]);
});

test('pagehide cancels a pending device switch even if pageshow happens before the old stop resolves',async t=>{
  const app=await harness(t),second=app.createDevice('PLMX second','second-device');
  await app.click('connect');await app.levels(20,40);
  app.choose(second);
  const release=app.holdNextWrite();
  const switching=app.click('connect');
  await release.started;
  assert.equal(app.writes.at(-1).target,app.device.id);
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(0,0)]);
  await app.pagehide();await app.pageshow();
  await release();await switching;await app.drain();
  assert.equal(app.connectionCount(second),0,'returning to the page must not revive the cancelled switch');
  assert.equal(second.gatt.connected,false);
  assert.ok(app.writes.every(write=>write.target===app.device.id));
  assert.ok(app.deviceButtons().every(row=>!row.textContent.includes(second.name)||!row.textContent.includes('当前控制')));
});

test('an inactive disconnect updates only that row and never steals current control',async t=>{
  const app=await harness(t),second=app.createDevice('PLMX current','second-device');
  await app.click('connect');app.choose(second);await app.click('connect');
  const calls=app.connectCalls,writes=app.writes.length;
  await app.drop(app.device);await app.drain();
  assert.equal(app.connectCalls,calls,'inactive devices must not automatically reclaim control');
  assert.equal(app.writes.length,writes);
  assert.match(app.deviceButtons()[0].textContent,/未连接/);
  assert.match(app.deviceButtons()[1].textContent,/当前控制/);
  await app.levels(0,25);
  assert.ok(app.writes.slice(-3).every(write=>write.target===second.id));
});

test('a failed device switch cannot expose the failed target as current or misdirect writes',async t=>{
  const app=await harness(t),second=app.createDevice('PLMX unavailable','failed-device');
  await app.click('connect');await app.levels(20,40);
  app.failConnections(true,second);app.choose(second);await app.click('connect');await app.drain();
  assert.equal(second.gatt.connected,false);
  assert.ok(app.writes.every(write=>write.target===app.device.id));
  const current=app.deviceButtons().filter(row=>row.textContent.includes('当前控制'));
  assert.ok(current.length<=1);
  assert.ok(current.every(row=>row.textContent.includes(app.device.name)),
    'a failed target must not be advertised as the current controllable device');
  if(!app.element('motor1').disabled){
    assert.equal(current.length,1,'enabled controls need an identified current device');
    await app.levels(10,15);
    assert.equal(app.writes.at(-1).target,app.device.id);
  }
});

test('a failed stop on the old device aborts switching before the new GATT connection',async t=>{
  const app=await harness(t),second=app.createDevice('PLMX second','second-device');
  await app.click('connect');await app.levels(20,40);
  app.failWrites(true,app.device);app.choose(second);await app.click('connect');await app.drain();
  assert.equal(app.connectionCount(second),0,'a failed old-device stop must abort the switch');
  assert.equal(second.gatt.connected,false);
  assert.equal(app.device.gatt.connected,true);
  assert.ok(app.writes.every(write=>write.target===app.device.id));
  assert.ok(app.deviceButtons().every(row=>!row.textContent.includes(second.name)||!row.textContent.includes('当前控制')));
});

test('opening the chooser pauses old-device recovery so a new selection is not lost',async t=>{
  const app=await harness(t),second=app.createDevice('PLMX new','chooser-device');
  await app.click('connect');
  let select;
  navigator.bluetooth.requestDevice=()=>new Promise(resolve=>select=resolve);
  const choosing=app.click('connect');
  await app.drop();await app.drain();
  assert.equal(app.connectionCount(app.device),1,'do not reconnect the old device while selecting its replacement');
  select(second);await choosing;
  assert.equal(app.connectionCount(second),1);
  assert.match(app.deviceButtons().find(row=>row.textContent.includes(second.name)).textContent,/当前控制/);
  assert.equal(app.element('motor1').disabled,false);
});

function domElement(tagName='div') {
  const classes=new Set();
  const node=eventTarget({
    tagName:tagName.toUpperCase(),children:[],attributes:new Map(),dataset:{},
    value:'',checked:false,disabled:false,hidden:false,className:'',
    firstChild:{textContent:''},style:{setProperty(){}},
    classList:{
      add(...names){names.forEach(name=>classes.add(name));},
      remove(...names){names.forEach(name=>classes.delete(name));},
      contains(name){return classes.has(name);},
      toggle(name,force){
        const enabled=force===undefined?!classes.has(name):force;
        if(enabled)classes.add(name);else classes.delete(name);
        return enabled;
      },
    },
    setAttribute(name,value){this.attributes.set(name,String(value));},
    getAttribute(name){return this.attributes.get(name)??null;},
    append(...items){this.children.push(...items);this.firstChild=this.children[0]||{textContent:''};},
    appendChild(item){this.append(item);return item;},
    replaceChildren(...items){this.children=[];this.append(...items);},
  });
  Object.defineProperty(node,'textContent',{
    get(){return this.children.length?this.children.map(child=>child.textContent).join(''):this.firstChild.textContent;},
    set(value){this.children=[];this.firstChild={textContent:String(value)};},
  });
  return node;
}

async function harness(t,{granted=[]}={}) {
  const globals=['document','window','navigator','setTimeout','clearTimeout'];
  const originals=new Map(globals.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{
    for(const [name,descriptor]of originals){
      if(descriptor)Object.defineProperty(globalThis,name,descriptor);
      else delete globalThis[name];
    }
  });
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const elements=new Map();
  for(const [tag,,id]of html.matchAll(/<[a-z][^>]*\sid=(["'])(.*?)\1[^>]*>/gi)){
    const node=domElement(tag.match(/^<([a-z]+)/i)[1]);
    Object.assign(node,{
      value:tag.match(/\bvalue=(["'])(.*?)\1/)?.[2]||'',
      checked:/\schecked(?:\s|=|>)/i.test(tag),
      disabled:/\sdisabled(?:\s|=|>)/i.test(tag),
      hidden:/\shidden(?:\s|=|>)/i.test(tag),
    });
    elements.set(id,node);
  }
  const element=id=>elements.get(id)||null;
  const document=eventTarget({
    hidden:false,visibilityState:'visible',getElementById:element,
    createTextNode:text=>({textContent:String(text)}),createElement:domElement,
  });
  const window=eventTarget({isSecureContext:true});
  let nextTimer=0,now=0;
  const timers=new Map();
  const setTimeout=(callback,delay=0,...args)=>{
    const id=++nextTimer;timers.set(id,{at:now+Number(delay),callback:()=>callback(...args)});return id;
  };
  const clearTimeout=id=>timers.delete(id);
  Object.assign(window,{setTimeout,clearTimeout});
  const writes=[],characteristics=[],chooserOptions=[],deviceStates=new Map();
  let chooserCalls=0,connectCalls=0,getDevicesCalls=0,heldWrite=null;
  function createDevice(name,id){
    const selected=eventTarget({name,id});
    const state={connectCalls:0,failConnections:false,failWrites:false,heldConnection:null};
    deviceStates.set(selected,state);
    const gatt={
      connected:false,
      async connect(){
        connectCalls++;state.connectCalls++;
        if(state.failConnections)throw new Error('Device temporarily out of range');
        if(state.heldConnection)await state.heldConnection.promise;
        this.connected=true;return this;
      },
      disconnect(){
        if(!this.connected)return;
        this.connected=false;
        void selected.emit('gattserverdisconnected',{},false);
      },
      async getPrimaryService(uuid){
        assert.equal(uuid,SERVICE);
        const session=connectCalls;
        return {
          uuid,
          async getCharacteristic(uuid){
            if(uuid!==WRITE)throw new Error('Notifications unavailable');
            const characteristic={
              uuid:WRITE,properties:{write:true,writeWithoutResponse:false},
              async writeValueWithResponse(bytes){
                assert.equal(gatt.connected,true,'writes require a live GATT connection');
                writes.push({target:selected.id,session,bytes:[...bytes]});
                if(state.failWrites)throw new Error('Bluetooth write failed');
                const gate=heldWrite;heldWrite=null;
                if(gate){gate.started();await gate.promise;}
              },
            };
            characteristics.push(characteristic);return characteristic;
          },
        };
      },
    };
    selected.gatt=gatt;return selected;
  }
  const device=createDevice('QCSW-test','selected-device');
  const grantedDevices=granted.map(({name,id})=>createDevice(name,id));
  let chosenDevice=device;
  const navigator={bluetooth:{
    async requestDevice(options){chooserCalls++;chooserOptions.push(options);return chosenDevice;},
    async getDevices(){getDevicesCalls++;return grantedDevices;},
  }};
  for(const [name,value]of Object.entries({document,window,navigator,setTimeout,clearTimeout})){
    Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  }
  await import(`../app.mjs?test=${++importVersion}`);await flush();
  async function next(){
    await flush();
    const entry=[...timers].sort((a,b)=>a[1].at-b[1].at)[0];
    if(!entry)return false;
    const [id,timer]=entry;timers.delete(id);now=timer.at;
    timer.callback();await flush();return true;
  }
  async function clickNode(node,label){
    assert.ok(node,`${label} must exist in the real page`);
    assert.equal(node.disabled,false,`${label} must be usable`);
    assert.equal(node.hidden,false,`${label} must be visible`);
    await node.emit('click');
  }
  function deviceButtons(){
    const list=element('deviceList');assert.ok(list,'deviceList must exist in the real page');
    const buttons=[];
    function visit(node){if(node.tagName==='BUTTON')buttons.push(node);for(const child of node.children||[])visit(child);}
    visit(list);return buttons;
  }
  return {
    element,device,writes,characteristics,chooserOptions,grantedDevices,createDevice,deviceButtons,
    choose(selected){chosenDevice=selected;},
    get chooserCalls(){return chooserCalls;},get connectCalls(){return connectCalls;},
    get getDevicesCalls(){return getDevicesCalls;},get timerCount(){return timers.size;},
    connectionCount(selected){return deviceStates.get(selected).connectCalls;},
    async click(id){await clickNode(element(id),id);},
    async clickDevice(index){await clickNode(deviceButtons()[index],`device row ${index}`);},
    async levels(first,second){
      element('motor1').value=String(first);element('motor2').value=String(second);
      await element('motor1').emit('input');await element('motor1').emit('change');
    },
    async drop(selected=device){selected.gatt.connected=false;await selected.emit('gattserverdisconnected',{},false);},
    failConnections(value=true,selected=device){deviceStates.get(selected).failConnections=value;},
    failWrites(value=true,selected=device){deviceStates.get(selected).failWrites=value;},
    holdNextWrite(){
      let resolve,started;
      const began=new Promise(done=>started=done);
      heldWrite={promise:new Promise(done=>resolve=done),started};
      const release=async()=>{resolve();await flush();};
      release.started=began;return release;
    },
    holdConnection(selected=device){
      let resolve;const state=deviceStates.get(selected);
      state.heldConnection={promise:new Promise(done=>resolve=done)};
      return async()=>{state.heldConnection=null;resolve();await flush();};
    },
    async visibility(hidden){
      document.hidden=hidden;document.visibilityState=hidden?'hidden':'visible';
      await document.emit('visibilitychange');
    },
    async pagehide(){await window.emit('pagehide');},
    async pageshow(){await window.emit('pageshow');},
    async check(id,checked){element(id).checked=checked;await element(id).emit('change');},
    next,
    async drain(limit=20){
      for(let i=0;i<limit;i++)if(!await next())return;
      assert.equal(timers.size,0,'reconnect retries must have a finite budget');
    },
  };
}

test('foreground disconnect reconnects the selected device and uses a new characteristic',async t=>{
  const app=await harness(t);
  app.element('autoResume').checked=true;
  await app.click('connect');
  await app.levels(20,40);
  assert.equal(app.writes.length,1);
  const previous=app.characteristics[0];
  await app.drop();await app.drain();
  assert.equal(app.device.gatt.connected,true,'unexpected disconnect should reconnect automatically');
  assert.equal(app.chooserCalls,1,'automatic recovery must not reopen the device chooser');
  assert.ok(app.characteristics.length>=2,'recovery must rediscover the write characteristic');
  assert.notEqual(app.characteristics.at(-1),previous);
  assert.deepEqual(app.writes.at(-1),{target:app.device.id,session:2,bytes:[...makeMotorPacket(20,40)]});
});

test('unreachable device receives a bounded number of reconnect attempts',async t=>{
  const app=await harness(t);
  await app.click('connect');app.failConnections();
  await app.drop();await app.drain();
  assert.ok(app.connectCalls>1,'a foreground interruption should attempt recovery');
  assert.equal(app.timerCount,0);
  assert.equal(app.chooserCalls,1);
  assert.equal(app.element('connect').disabled,false,'manual connection should be available after exhaustion');
});

test('Disconnect cancels scheduled recovery while the device is unavailable',async t=>{
  const app=await harness(t);
  await app.click('connect');app.failConnections();
  await app.drop();await app.next();
  assert.ok(app.connectCalls>1,'the test must reach automatic recovery');
  await app.click('disconnect');
  const attempts=app.connectCalls;
  app.failConnections(false);await app.drain();
  assert.equal(app.connectCalls,attempts,'cancelled recovery must not try again');
  assert.equal(app.device.gatt.connected,false);
  assert.equal(app.chooserCalls,1);
});

test('Stop during an outage prevents restoring the previous intensity',async t=>{
  const app=await harness(t);
  app.element('autoResume').checked=true;
  await app.click('connect');await app.levels(30,50);
  const release=app.holdConnection();
  await app.drop();await app.next();
  assert.ok(app.connectCalls>1,'the test must reach an in-flight reconnect');
  await app.click('stop');await release();await app.drain();
  assert.equal(app.device.gatt.connected,true);
  const resumed=app.writes.filter(write=>write.session>1);
  assert.ok(resumed.every(write=>JSON.stringify(write.bytes)===JSON.stringify([...makeMotorPacket(0,0)])),
    'only a stop packet may be sent after Stop clears saved intensity');
  assert.equal(Number(app.element('motor1').value),0);
  assert.equal(Number(app.element('motor2').value),0);
});

test('manual disconnect sends stop and never retries',async t=>{
  const app=await harness(t);
  await app.click('connect');await app.levels(20,40);
  await app.click('disconnect');await app.drain();
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(0,0)]);
  assert.equal(app.device.gatt.connected,false);
  assert.equal(app.connectCalls,1);
  assert.equal(app.chooserCalls,1);
});

test('backgrounding during reconnect clears intensity restoration',async t=>{
  const app=await harness(t);
  app.element('autoResume').checked=true;
  await app.click('connect');await app.levels(25,45);
  const release=app.holdConnection();
  await app.drop();await app.next();
  assert.ok(app.connectCalls>1,'the test must reach an in-flight reconnect');
  await app.visibility(true);await release();await app.drain();
  await app.visibility(false);await app.drain();
  const resumed=app.writes.filter(write=>write.session>1);
  assert.ok(resumed.every(write=>JSON.stringify(write.bytes)===JSON.stringify([...makeMotorPacket(0,0)])),
    'backgrounding must discard the previous intensity, including an in-flight reconnect');
  assert.equal(Number(app.element('motor1').value),0);
  assert.equal(Number(app.element('motor2').value),0);
});

test('background mode preserves the active output while explicit Stop still sends zero',async t=>{
  const app=await harness(t);
  assert.equal(app.element('backgroundMode').checked,false);
  await app.check('backgroundMode',true);
  await app.click('connect');await app.levels(20,40);
  const previousWrites=[...app.writes];
  await app.visibility(true);await app.drain();
  assert.equal(app.device.gatt.connected,true,'background mode should keep the current connection');
  assert.deepEqual(app.writes,previousWrites,'switching apps must not send a stop packet when opted in');
  assert.equal(Number(app.element('motor1').value),20);
  assert.equal(Number(app.element('motor2').value),40);
  await app.visibility(false);await app.click('stop');
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(0,0)]);
  assert.equal(Number(app.element('motor1').value),0);
  assert.equal(Number(app.element('motor2').value),0);
});

for(const autoResume of [false,true]){
  test(`background mode reconnects after a drop with intensity restoration ${autoResume?'enabled':'disabled'}`,async t=>{
    const app=await harness(t);
    await app.check('backgroundMode',true);await app.check('autoResume',autoResume);
    await app.click('connect');await app.levels(25,45);
    await app.visibility(true);await app.drop();await app.drain();
    assert.equal(app.device.gatt.connected,true,'background recovery should run when browser JavaScript remains active');
    assert.equal(app.chooserCalls,1,'background recovery must reuse the selected device');
    assert.equal(app.characteristics.length,2,'background recovery must fetch a new characteristic');
    assert.deepEqual(app.writes.filter(write=>write.session>1),[
      {target:app.device.id,session:2,bytes:[...makeMotorPacket(...(autoResume?[25,45]:[0,0]))]},
    ],'the separate auto-resume choice controls whether previous intensity is written');
  });
}

test('pagehide still attempts to stop with background mode enabled',async t=>{
  const app=await harness(t);
  await app.check('backgroundMode',true);await app.check('autoResume',true);
  await app.click('connect');await app.levels(30,50);
  const before=app.writes.length;
  await app.pagehide();
  assert.equal(app.writes.length,before+1,'leaving the page must attempt a stop write');
  assert.deepEqual(app.writes.at(-1).bytes,[...makeMotorPacket(0,0)]);
  assert.equal(Number(app.element('motor1').value),0);
  assert.equal(Number(app.element('motor2').value),0);
});

test('PLMX name selects sequential historical commands and the complete stop sequence',async t=>{
  const app=await harness(t);app.device.name='PLMX';
  await app.click('connect');
  assert.deepEqual(app.chooserOptions.at(-1),{filters:[{namePrefix:'QCSW'},{namePrefix:'PLMX'}],optionalServices:[SERVICE]});
  assert.equal(app.writes.length,0,'initial connection must not start a motor');
  await app.levels(20,40);
  assert.equal(app.writes.length,3);
  assert.deepEqual(app.writes[1].bytes,[0x23,0x81,0xbb,0xab,0xd2,0xed,0x4b,0x23,0xbb,0xa3,0x3b,0xfb]);
  assert.deepEqual(app.writes[2].bytes,[0x23,0x81,0xbb,0xab,0xd2,0xec,0x47,0x23,0xbb,0xa3,0x3b,0xf4]);
  await app.click('stop');
  assert.equal(app.writes.length,7,'PLMX stop must write the four documented zero commands');
  assert.deepEqual(app.writes[3].bytes,[...makeMotorPacket(0,0)]);
  assert.equal(Number(app.element('motor1').value),0);
  assert.equal(Number(app.element('motor2').value),0);
});

for(const cancellation of ['Stop','default background','manual disconnect']){
  test(`PLMX ${cancellation} skips unsent nonzero frames after the first physical write starts`,async t=>{
    const app=await harness(t);app.device.name='PLMX';
    await app.click('connect');
    const release=app.holdNextWrite();
    const pendingLevels=app.levels(20,40);
    await release.started;
    assert.equal(app.writes.length,1,'cancellation must occur while the first PLMX frame is in flight');
    assert.deepEqual(app.writes[0].bytes,[0x23,0x81,0xbb,0xab,0xd2,0xac,0x3b,0x23,0xbb,0xa3,0x3b,0xd0]);
    let pendingCancellation;
    if(cancellation==='default background'){
      assert.equal(app.element('backgroundMode').checked,false);
      await app.visibility(true);
    }else{
      pendingCancellation=app.click(cancellation==='Stop'?'stop':'disconnect');
      await flush();
    }
    await release();await pendingLevels;await pendingCancellation;await app.drain();
    assert.deepEqual(app.writes.slice(1).map(write=>write.bytes),[
      [0x23,0x81,0xbb,0xab,0xd2,0x7b,0x44,0x33,0xbb,0xa3,0x3b,0xf2],
      [0x23,0x81,0xbb,0xab,0xd2,0xec,0x3b,0x23,0xbb,0xa3,0x3b,0x90],
      [0x23,0x81,0xbb,0xab,0xd2,0xed,0x23,0x23,0xbb,0xa3,0x3b,0xa3],
      [0x23,0x81,0xbb,0xab,0xd2,0xac,0x3b,0x23,0xbb,0xa3,0x3b,0xd0],
    ],'after cancellation only the four zero-intensity stop frames may begin; old 0x31/0x32 frames must be skipped');
    assert.equal(Number(app.element('motor1').value),0);
    assert.equal(Number(app.element('motor2').value),0);
    assert.equal(app.element('resume').hidden,true);
    if(cancellation==='manual disconnect'){
      assert.equal(app.device.gatt.connected,false);
      assert.equal(app.connectCalls,1,'manual disconnect must not schedule recovery');
    }
  });
}
