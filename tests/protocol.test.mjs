import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptFrame, makeMotorPacket, makePollyPackets, LatestWriter } from '../protocol.mjs';

test('encryption matches independent upstream 0% and 100% reference packets', () => {
  assert.deepEqual([...encryptFrame([35,90,0,0,1,49,0,0,0,0,0,175])], [35,129,187,171,210,236,59,35,187,163,59,144]);
  assert.deepEqual([...encryptFrame([35,90,0,0,1,49,100,0,0,0,0,19])], [35,129,187,171,210,236,87,35,187,163,59,68]);
});
test('invalid intensities cannot wrap into arbitrary device bytes', () => {
  for (const n of [-1,101,NaN,Infinity,1.5,'50']) assert.throws(() => makeMotorPacket(n,0));
});
test('dual-channel packet has correct checksum and includes both channel values', () => {
  assert.deepEqual([...makeMotorPacket(20,40)], [35,129,187,171,210,123,68,71,211,163,59,222]);
});
test('PLMX packets disable the third mode then match independent channel 2 and channel 1 vectors',()=>{
  const packets=makePollyPackets(20,40);
  assert.ok(packets.every(packet=>packet instanceof Uint8Array));
  assert.deepEqual(packets.map(packet=>[...packet]),[
    [35,129,187,171,210,172,59,35,187,163,59,208],
    [35,129,187,171,210,237,75,35,187,163,59,251],
    [35,129,187,171,210,236,71,35,187,163,59,244],
  ]);
});
test('PLMX stop sends combined zero then channel 1, channel 2, and third-mode zero in order',()=>{
  assert.deepEqual(makePollyPackets(0,0).map(packet=>[...packet]),[
    [35,129,187,171,210,123,68,51,187,163,59,242],
    [35,129,187,171,210,236,59,35,187,163,59,144],
    [35,129,187,171,210,237,35,35,187,163,59,163],
    [35,129,187,171,210,172,59,35,187,163,59,208],
  ]);
});
test('PLMX preserves zero and low intensity without a startup floor and wraps the checksum at 100',()=>{
  assert.deepEqual(makePollyPackets(1,0).map(packet=>[...packet]),[
    [35,129,187,171,210,172,59,35,187,163,59,208],
    [35,129,187,171,210,237,35,35,187,163,59,163],
    [35,129,187,171,210,236,60,51,187,163,59,163],
  ]);
  assert.deepEqual(makePollyPackets(0,100).map(packet=>[...packet]),[
    [35,129,187,171,210,172,59,35,187,163,59,208],
    [35,129,187,171,210,237,135,35,187,163,59,71],
    [35,129,187,171,210,236,59,35,187,163,59,144],
  ]);
  assert.deepEqual([...makePollyPackets(100,0)[2]],[35,129,187,171,210,236,87,35,187,163,59,68]);
});
test('PLMX rejects invalid intensities in either channel before generating packets',()=>{
  for(const value of [-1,101,NaN,Infinity,1.5,'50',null,undefined]){
    assert.throws(()=>makePollyPackets(value,0));
    assert.throws(()=>makePollyPackets(0,value));
  }
});
test('stop discards unsent levels and is the last command after an in-flight write', async () => {
  const writes=[]; let release, started;
  const inFlight=new Promise(r=>started=r);
  const writer = new LatestWriter(async value => { writes.push(value); if(writes.length===1) await new Promise(r=>{release=r;started();}); });
  const a=writer.send('first'); await inFlight;
  const b=writer.send('stale');
  const stop=writer.stop('zero');
  assert.equal(await writer.send('blocked'),false);
  release(); await Promise.all([a,b,stop]);
  assert.deepEqual(writes,['first','zero']);
});
test('disconnect invalidates queued control; write failures are propagated', async () => {
  const writes=[];
  const writer=new LatestWriter(async value=>writes.push(value));
  const p=writer.send('queued'); writer.reset();
  assert.equal(await p,false); assert.deepEqual(writes,[]);
  const broken=new LatestWriter(async()=>{throw new Error('BLE failed')});
  await assert.rejects(broken.send('command'),/BLE failed/);
});
