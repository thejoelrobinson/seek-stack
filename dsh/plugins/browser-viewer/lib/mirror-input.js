export const selectionFunction=`function(a,b,direction){
  if(this.setSelectionRange){try{this.setSelectionRange(a,b,direction||'none');return true}catch{return false}}
  if(!this.isContentEditable)return false;const w=this.ownerDocument.createTreeWalker(this,4),points=[];let node,total=0;
  while(node=w.nextNode()){points.push({node,start:total,end:total+node.length});total+=node.length;}
  if(!points.length){const t=this.ownerDocument.createTextNode('');this.append(t);points.push({node:t,start:0,end:0});}
  const at=x=>{const p=points.find(p=>x<=p.end)||points.at(-1);return [p.node,Math.max(0,Math.min(p.node.length,x-p.start))]};
  const s=this.ownerDocument.getSelection(),range=this.ownerDocument.createRange(),start=at(a),end=at(b);range.setStart(...start);range.setEnd(...end);s.removeAllRanges();s.addRange(range);if(direction==='backward')s.setBaseAndExtent(...end,...start);return true;
}`;
export async function extendedInput(m,msg,n,client){
  const mods=Number.isInteger(msg.modifiers)?msg.modifiers&15:0;
  if(msg.type==='mkey'||msg.type==='key'){
    if(!['keyDown','keyUp'].includes(msg.event)||typeof msg.key!=='string'||msg.key.length>40)return true;
    if(n){await m.call('DOM.focus',{backendNodeId:n.backendNodeId}).catch(()=>{});if(msg.selection){if(!await m.selectNodes(n,msg.selection)&&Number.isSafeInteger(msg.selection.start)&&Number.isSafeInteger(msg.selection.end))await m.local(n,selectionFunction,[msg.selection.start,msg.selection.end,msg.selection.direction]);}}
    const key=msg.key,code=typeof msg.code==='string'?msg.code.slice(0,40):key,params={type:msg.event,key,code,modifiers:mods};
    if(Number.isInteger(msg.windowsVirtualKeyCode))params.windowsVirtualKeyCode=Math.max(0,Math.min(255,msg.windowsVirtualKeyCode));
    if(msg.event==='keyDown'&&(key==='Enter'||key.length===1&&!(mods&7)))params.text=key==='Enter'?'\r':key;
    if(msg.event==='keyDown'&&(mods&6)&&key.toLowerCase()==='z')params.commands=[mods&8?'Redo':'Undo'];
    if(msg.event==='keyDown'&&(mods&6)&&key.toLowerCase()==='y')params.commands=['Redo'];
    await m.call('Input.dispatchKeyEvent',params);if(n&&msg.event==='keyDown'&&await m.local(n,'function(){return this.isContentEditable}'))m.queueRich(n.nodeId);m.valueDue=Date.now()+80;m.schedule();return true;
  }
  if(!n)return false;
  if(msg.type==='mrich'){
    if(!['insertText','insertFromPaste','insertParagraph','insertLineBreak','deleteContentBackward','deleteContentForward','deleteByCut'].includes(msg.inputType)||typeof msg.text!=='string'||msg.text.length>50000||!Number.isSafeInteger(msg.seq)||msg.seq<=(m.sequences(client).get(n.backendNodeId)||0))return true;
    const editable=await m.local(n,'function(){return this.isContentEditable}');if(!editable)return true;m.sequences(client).set(n.backendNodeId,msg.seq);await m.call('DOM.focus',{backendNodeId:n.backendNodeId});if(msg.selection&&!await m.selectNodes(n,msg.selection))await m.local(n,selectionFunction,[Number(msg.selection.start)||0,Number(msg.selection.end)||0,msg.selection.direction]);
    if(msg.inputType==='insertText'||msg.inputType==='insertFromPaste')await m.call('Input.insertText',{text:msg.text});else {const key=msg.inputType.startsWith('delete')?(msg.inputType==='deleteContentBackward'?'Backspace':'Delete'):'Enter';for(const type of ['keyDown','keyUp'])await m.call('Input.dispatchKeyEvent',{type,key,code:key,windowsVirtualKeyCode:{Backspace:8,Delete:46,Enter:13}[key],modifiers:msg.inputType==='insertLineBreak'?8:0,...(key==='Enter'&&type==='keyDown'?{text:'\r'}:{})});}await m.syncValues();m.queueRich(msg.id);m.ack(msg,client);m.schedule();m.valueDue=Date.now()+50;return true;
  }
  if(msg.type==='mselection'){
    if(Number.isSafeInteger(msg.start)&&Number.isSafeInteger(msg.end)&&msg.start>=0&&msg.end>=msg.start&&msg.end<=100000){await m.call('DOM.focus',{backendNodeId:n.backendNodeId}).catch(()=>{});if(!await m.selectNodes(n,msg))await m.local(n,selectionFunction,[msg.start,msg.end,msg.direction]);}return true;
  }
  if(msg.type==='mcomposition'){
    if(typeof msg.text!=='string'||msg.text.length>50000)return true;
    await m.call('DOM.focus',{backendNodeId:n.backendNodeId});
    if(msg.phase==='start'){if(!await m.selectNodes(n,msg))await m.local(n,selectionFunction,[Number(msg.start)||0,Number(msg.end)||0]);m.composition=n.backendNodeId;}
    if(msg.phase==='update'&&m.composition===n.backendNodeId)await m.call('Input.imeSetComposition',{text:msg.text,selectionStart:msg.text.length,selectionEnd:msg.text.length});
    if(msg.phase==='end'&&m.composition===n.backendNodeId){await m.call('Input.insertText',{text:msg.text});m.composition=null;if(await m.local(n,'function(){return this.isContentEditable}'))m.queueRich(msg.id);}
    await m.syncValues();m.valueDue=Date.now()+80;m.schedule();return true;
  }
  if(msg.type==='mpointer'){
    if(!['down','move','up','cancel'].includes(msg.event))return true;
    const p=await m.point(n,msg.rx,msg.ry,true),button=['left','middle','right'].includes(msg.button)?msg.button:'left',buttons=Number(msg.buttons)&7;
    if(mods&6)(m.parent||m).controller.backgroundOpenUntil=Date.now()+1000;
    // A drag or click may change the page selection or hover; refresh transient state soon rather than on the 500 ms cycle.
    const root=m.parent||m;root.lastStateAt=Math.min(root.lastStateAt||0,Date.now()-400);
    if(msg.touch&&root.controller.viewportMode==='mobile'){const type={down:'touchStart',move:'touchMove',up:'touchEnd',cancel:'touchCancel'}[msg.event];await m.call('Input.dispatchTouchEvent',{type,touchPoints:type==='touchEnd'||type==='touchCancel'?[]:[{...p,radiusX:1,radiusY:1,force:1}],modifiers:mods});m.valueDue=Date.now()+80;m.schedule();return true;}
    await m.call('Input.dispatchMouseEvent',{type:msg.event==='down'?'mousePressed':msg.event==='move'?'mouseMoved':'mouseReleased',...p,button:msg.event==='move'&&!buttons?'none':button,buttons,clickCount:Math.max(1,Math.min(3,Number(msg.clickCount)||1)),modifiers:mods});m.valueDue=Date.now()+80;m.schedule();return true;
  }
  if(msg.type==='mwheel'){
    // Only wheels Native could not scroll itself arrive here (pictures, canvas/maps, scroll-locked pages, ctrl-zoom).
    const p=await m.point(n,msg.rx,msg.ry,true),delta=v=>Math.max(-5000,Math.min(5000,Number(v)||0));
    await m.call('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:delta(msg.dx),deltaY:delta(msg.dy),modifiers:mods});m.valueDue=Date.now()+80;m.schedule();return true;
  }
  return false;
}
