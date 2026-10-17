// Galaku wire encoding adapted from Buttplug (BSD-3-Clause).
// Copyright (c) 2016-2026 Nonpolynomial Labs LLC (upstream Galaku implementation).
// See THIRD-PARTY-LICENSE.txt and SOURCES.md for provenance and license notices.
const KEYS = [
  [0,24,152,247,165,61,13,41,37,80,68,70],
  [0,69,110,106,111,120,32,83,45,49,46,55],
  [0,101,120,32,84,111,121,115,10,142,157,163],
  [0,197,214,231,248,10,50,32,111,98,13,10]
];
export const SERVICE = '00001000-0000-1000-8000-00805f9b34fb';
export const WRITE = '00001001-0000-1000-8000-00805f9b34fb';
export const NOTIFY = '00001002-0000-1000-8000-00805f9b34fb';

export function encryptFrame(frame) {
  if (frame.length !== 12) throw new Error('Expected 12-byte frame');
  const result = new Uint8Array(12);
  result[0] = frame[0];
  for (let i=1; i<12; i++) {
    const key = KEYS[result[i-1] & 3][i];
    result[i] = (key ^ frame[0] ^ frame[i]) + key;
  }
  return result;
}
function validateLevels(channel1,channel2){
  for (const n of [channel1, channel2]) {
    if (!Number.isInteger(n) || n<0 || n>100) throw new Error('强度必须是 0–100 的整数');
  }
}
export function makeMotorPacket(channel1, channel2) {
  validateLevels(channel1,channel2);
  const frame = [35,90,0,0,1,64,3,channel1,channel2,0,0];
  frame.push(frame.reduce((a,b)=>a+b,0)&255);
  return encryptFrame(frame);
}
function commandPacket(command,intensity){
  const frame=[35,90,0,0,1,command,intensity,0,0,0,0];
  frame.push(frame.reduce((a,b)=>a+b,0)&255);
  return encryptFrame(frame);
}
// PLMX historical 1000 profile: command layout/order from public protocol references.
// Channel labels were confirmed by one user; firmware/batch compatibility is not guaranteed.
export function makePollyPackets(channel1,channel2){
  validateLevels(channel1,channel2);
  if(channel1===0 && channel2===0){
    return [makeMotorPacket(0,0),commandPacket(0x31,0),commandPacket(0x32,0),commandPacket(0x71,0)];
  }
  return [commandPacket(0x71,0),commandPacket(0x32,channel2),commandPacket(0x31,channel1)];
}

// Coalesce unsent slider values. A stop supersedes them and blocks new values
// until its write completes. Reset invalidates work from a disconnected session.
export class LatestWriter {
  constructor(write) { this.write=write; this.tail=Promise.resolve(); this.revision=0; this.stopping=false; }
  send(value) {
    if(this.stopping) return Promise.resolve(false);
    return this.enqueue(value);
  }
  enqueue(value) {
    const revision=++this.revision;
    const task=this.tail.catch(()=>{}).then(async()=>{
      if(revision!==this.revision) return false;
      await this.write(value);
      return true;
    });
    this.tail=task;
    return task;
  }
  async stop(value) {
    this.stopping=true;
    try { return await this.enqueue(value); }
    finally { this.stopping=false; }
  }
  reset() { this.revision++; }
}
