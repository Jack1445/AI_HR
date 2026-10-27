import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFile, writeFile, mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { inspectResumePng } from '../dist/common/resume_png_quality.js';
import { C_RESUME_CONTENT_STATE_SCRIPT, C_RESUME_RESET_SCROLL_SCRIPT, waitForVisibleCResumeIframeReady, prepareResumeCaptureWindow, captureCResumeIframeToFile } from '../dist/common/c_resume_capture.js';
function png(light=255,filter=0,alpha=255) {
 const width=160,height=160,channels=4, rows=[]; let previous=Buffer.alloc(width*channels);
 for(let y=0;y<height;y++){
  const row=Buffer.alloc(width*channels);for(let x=0;x<width;x++){const color=y>10&&y<100&&x>10&&x<100?light:255;row.set([color,color,color,alpha],x*4);}
  const encoded=Buffer.alloc(row.length+1);encoded[0]=filter;
  for(let x=0;x<row.length;x++){const a=x>=channels?row[x-channels]:0,b=previous[x],c=x>=channels?previous[x-channels]:0;let pred=0;if(filter===1)pred=a;if(filter===2)pred=b;if(filter===3)pred=Math.floor((a+b)/2);if(filter===4){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);pred=pa<=pb&&pa<=pc?a:pb<=pc?b:c;}encoded[x+1]=(row[x]-pred)&255;}rows.push(encoded);previous=row;
 }
 const chunk=(type,data)=>{const buf=Buffer.alloc(data.length+12);buf.writeUInt32BE(data.length);buf.write(type,4);data.copy(buf,8);let crc=0xffffffff;for(const b of buf.subarray(4,-4)){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}buf.writeUInt32BE((crc^0xffffffff)>>>0,buf.length-4);return buf;};
 const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.concat(rows))),chunk('IEND',Buffer.alloc(0))]);
}
for(let filter=0;filter<5;filter++) assert.equal(inspectResumePng(png(50,filter)).readable,true);
assert.equal(inspectResumePng(png()).readable,false);
assert.equal(inspectResumePng(png(245)).readable,false,'watermark alone is not a resume');
assert.equal(inspectResumePng(png(0,0,0)).readable,false,'transparent dark pixels are blank on white');
assert.throws(()=>inspectResumePng(Buffer.from('invalid')));
const resumeText='测试候选人 教育经历 工作经历 '+ '可见正文 '.repeat(40);
function contentState(visible=true,text=resumeText,canvas=false){let done=false;return vm.runInNewContext(C_RESUME_CONTENT_STATE_SCRIPT,{NodeFilter:{SHOW_TEXT:4},document:{visibilityState:'visible',readyState:'complete',body:{innerText:text,scrollHeight:800},documentElement:{scrollHeight:800},fonts:{status:'loaded'},querySelectorAll:()=>canvas?[{width:1200,height:1600,checkVisibility:()=>visible,getBoundingClientRect:()=>({top:0,width:600,height:800})}]:[],createTreeWalker:()=>({nextNode:()=>{if(done)return null;done=true;return {textContent:text,parentElement:{checkVisibility:()=>visible}};}}),createRange:()=>({selectNodeContents(){},getBoundingClientRect:()=>({width:600})})}});}
assert.equal(contentState(false).ready,false);
assert.equal(contentState(true,'正在加载').ready,false);
assert.equal(contentState().ready,true);
assert.equal(contentState(true,'',true).mode,'canvas','real BOSS canvas has zero DOM text');
assert.equal(contentState(false,'',true).ready,false,'hidden canvas is not ready');
function mockPage(bytes=png(50),state=contentState()){
 const events=[];let shot=0,viewport={width:1000,height:900};
 const getState=()=>typeof state==='function'?state(viewport):state;
 const handle={dispose:async()=>{},boundingBox:async()=>({x:30,y:20,width:600,height:getState().height}),contentFrame:async()=>({parentFrame:()=>frame,evaluate:async script=>script===C_RESUME_RESET_SCROLL_SCRIPT?0:getState()}),evaluate:async()=>0,screenshot:async()=>{throw new Error('Nested iframe screenshots must not add owner-document scroll offsets');}};
 const frame={parentFrame:()=>null,evaluate:async script=>script===C_RESUME_RESET_SCROLL_SCRIPT?0:script.includes('hasCResumeIframe')?false:true,$:async()=>handle};
 const page={evaluate:async()=>({x:0,y:0}),screenshot:async options=>{assert.deepEqual([options.clip.x,options.clip.y],[30,20]);shot++;return typeof bytes==='function'?bytes(shot,viewport):bytes;},frames:()=>[frame],viewport:()=>viewport,bringToFront:async()=>events.push('front'),setViewport:async v=>{viewport=v;events.push(['viewport',v.height]);},createCDPSession:async()=>({send:async(method,args)=>{events.push([method,args]);return {windowId:1,bounds:{windowState:'minimized'}};},detach:async()=>events.push('detach')})};
 return {page,events,shots:()=>shot};
}
const hidden=mockPage(png(),contentState(false));
assert.equal(await waitForVisibleCResumeIframeReady(hidden.page,20,'测试候选人'),false);
const wrong=mockPage();assert.equal(await waitForVisibleCResumeIframeReady(wrong.page,20,'其他候选人'),false);
const unverifiedCanvas=mockPage(png(50),contentState(true,'',true));
assert.equal(await waitForVisibleCResumeIframeReady(unverifiedCanvas.page,30,'测试候选人'),false,'canvas requires verified recommendation identity');
assert.equal(unverifiedCanvas.shots(),0);
const delayedCanvas=mockPage(shot=>shot===1?png():png(50),contentState(true,'',true));
assert.equal(await waitForVisibleCResumeIframeReady(delayedCanvas.page,3000,'测试候选人',true),true);
assert.ok(delayedCanvas.shots()>=2,'a blank canvas must wait for actual painted pixels');
const blankCanvas=mockPage(png(245),contentState(true,'',true));
assert.equal(await waitForVisibleCResumeIframeReady(blankCanvas.page,1100,'测试候选人',true),false,'watermark-only canvas must time out');
const restored=mockPage();await prepareResumeCaptureWindow(restored.page);assert.equal(restored.events[1][0],'Browser.setWindowBounds');assert.equal(restored.events[1][1].bounds.windowState,'normal');
const directory=await mkdtemp(join(tmpdir(),'resume-quality-'));
try{
 const blank=mockPage(png(245));const file=join(directory,'blank.png');
 await assert.rejects(captureCResumeIframeToFile(blank.page,{width:1000,height:900},file,'测试候选人'),/空白或仅有水印/);
 await assert.rejects(access(file));assert.deepEqual(blank.events.at(-1),['viewport',900]);
 const good=mockPage();const valid=join(directory,'valid.png');assert.equal(await captureCResumeIframeToFile(good.page,{width:1000,height:900},valid,'测试候选人'),true);assert.equal(inspectResumePng(await readFile(valid)).readable,true);
 const longState=viewport=>({...contentState(true,'',true),height:9263,canvas:{width:1200,height:(viewport.height-200)*2,cssTop:0,cssHeight:viewport.height-200}});
 const long=mockPage((shot,viewport)=>{assert.ok(viewport.height>=9463,'must expand before screenshotting virtual canvas');return png(50);},longState);
 const longFile=join(directory,'long.png');
 assert.equal(await captureCResumeIframeToFile(long.page,{width:1000,height:900},longFile,'测试候选人',true),true);
 assert.ok(long.events.some(e=>Array.isArray(e)&&e[0]==='viewport'&&e[1]===9463));
 assert.deepEqual(long.events.at(-1),['viewport',900]);
 const stillPartial=mockPage(png(50),{...contentState(true,'',true),height:9263});
 assert.equal(await waitForVisibleCResumeIframeReady(stillPartial.page,1100,'测试候选人',true,{width:1000,height:900}),false,'partial canvas coverage must not count as a complete resume');
 assert.equal(stillPartial.shots(),0);
}finally{await rm(directory,{recursive:true,force:true});}
console.log('Resume quality passed: all PNG filters, watermark/transparent rejection, visible content, expected name, minimized window restore, blank file prevention and viewport cleanup.');
