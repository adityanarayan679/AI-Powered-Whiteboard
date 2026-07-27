const SETTINGS_KEY = "board-settings";
const STORAGE_KEY = "board-elements";
const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

const COLORS = {
    stroke: ["#0f172a","#2563eb","#16a34a","#db2777","#ea580c","#7c3aed","#787775"],
    fill: ["transparent","#eff6ff","#f0fdf4","#fdf2f8","#fff7ed","#f5f3ff","#ffffff","#fffbeb"],
    sticky: ["#fef08a","#bfdbfe","#bbf7d0","#fbcfe8","#fed7aa","#ddd6fe","#fde68a","#d1d5db"]
};

const DEFAULTS = {
    rect: { w: 160, h: 100 }, ellipse: { w: 140, h: 140 },
    triangle: { w: 150, h: 130 }, diamond: { w: 140, h: 140 },
    sticky: { w: 160, h: 160 }, text: { w: 160, h: 40 }
};

const state = {
    elements: [], selectedIds: [], tool: "select",
    panX: 0, panY: 0, zoom: 1,
    drag: null, resize: null, rotate: null,
    drawing: null, laserPath: null, selectionBox: null,
    undoStack: [], redoStack: [],
    penOptions: { stroke: "#0f172a", strokeWidth: 4, strokeStyle: "solid" },
    pages: [], currentPageIndex: 0,
    settings: {
        theme: "light", gridStyle: "dots", snapGrid: true,
        smartDraw: true,
        aiProvider: "builtin", aiKey: ""
    }
};



// DOM refs
const board = document.getElementById("board");
const viewport = document.getElementById("viewport");
const edgesLayer = document.getElementById("edges-layer");
const drawingsLayer = document.getElementById("drawings-layer");
const highlighterLayer = document.getElementById("highlighter-layer");
const nodesLayer = document.getElementById("nodes-layer");
const selectionLayer = document.getElementById("selection-layer");
const properties = document.getElementById("properties");
const zoomText = document.getElementById("zoom-text");
const exportMenu = document.getElementById("export-menu");
const aiActions = document.getElementById("ai-actions");
const aiModal = document.getElementById("ai-modal");
const explainModal = document.getElementById("explain-modal");
const settingsModal = document.getElementById("settings-modal");
const suggestionPanel = document.getElementById("suggestion");
const toast = document.getElementById("toast");

// Helpers
function id(prefix="el") { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`; }
function bp(e) { const r=board.getBoundingClientRect(); return {x:(e.clientX-r.left-state.panX)/state.zoom, y:(e.clientY-r.top-state.panY)/state.zoom}; }
function gel(id) { return state.elements.find(e=>e.id===id); }
function snap(v,s=20) { return state.settings.snapGrid?Math.round(v/s)*s:v; }
function msg(m) { toast.textContent=m; toast.classList.remove("hidden"); setTimeout(()=>toast.classList.add("hidden"),4000); }
function svg(t,a={}) { const e=document.createElementNS(SVG_NS,t); Object.entries(a).forEach(([k,v])=>e.setAttribute(k,v)); return e; }
function html(t,a={},s="") { const e=document.createElementNS(XHTML_NS,t); Object.entries(a).forEach(([k,v])=>e.setAttribute(k,v)); e.textContent=s; return e; }

function normalize(el) {
    const t=el.type||"rect", isSticky=t==="sticky", isText=t==="text";
    const def=DEFAULTS[t]||{w:120,h:80};
    return {
        id: el.id||id(t), type: t,
        x: Number(el.x)||0, y: Number(el.y)||0,
        width: Math.max(20,Number(el.width)||def.w),
        height: Math.max(20,Number(el.height)||def.h),
        rotation: Number(el.rotation)||0,
        text: el.text!==undefined?String(el.text):(isSticky?"Note...":isText?"Text...":""),
        color: el.color||(isSticky?COLORS.sticky[0]:"transparent"),
        stroke: el.stroke||COLORS.stroke[0],
        strokeWidth: Number(el.strokeWidth)||(isSticky?2:4),
        strokeStyle: el.strokeStyle||"solid",
        fontFamily: el.fontFamily||(isSticky?"mono":isText?"sans":"sans"),
        fromId: el.fromId||null, toId: el.toId||null,
        points: Array.isArray(el.points)?el.points.map(p=>({x:Number(p.x),y:Number(p.y)})):[],
        opacity: Number(el.opacity)||1,
        fromSocket: el.fromSocket||null, toSocket: el.toSocket||null
    };
}

function getPathBounds(pts) {
    if(!pts||!pts.length) return {x:0,y:0,w:0,h:0};
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    pts.forEach(p=>{minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);});
    return {x:minX,y:minY,w:maxX-minX,h:maxY-minY};
}

// Command pattern
function exec(cmd) { cmd.exec(); state.undoStack.push(cmd); state.redoStack=[]; persist(); render(); }

class CmdCreate {
    constructor(els) { this.els=Array.isArray(els)?els:[els]; }
    exec() { this.els.forEach(e=>state.elements.push(e)); }
    undo() { const ids=this.els.map(e=>e.id); state.elements=state.elements.filter(e=>!ids.includes(e.id)); state.selectedIds=state.selectedIds.filter(id=>!ids.includes(id)); }
}

class CmdDelete {
    constructor(els) {
        this.els=Array.isArray(els)?els:[els];
        const ids=this.els.map(e=>e.id);
        this.arrows=state.elements.filter(e=>e.type==="arrow"&&(ids.includes(e.fromId)||ids.includes(e.toId)));
    }
    exec() { const ids=[...this.els.map(e=>e.id),...this.arrows.map(e=>e.id)]; state.elements=state.elements.filter(e=>!ids.includes(e.id)); state.selectedIds=state.selectedIds.filter(id=>!ids.includes(id)); }
    undo() { this.els.forEach(e=>state.elements.push(e)); this.arrows.forEach(e=>state.elements.push(e)); }
}

class CmdUpdate {
    constructor(ids, patches) {
        this.ids=Array.isArray(ids)?ids:[ids];
        this.patches=Array.isArray(patches)?patches:Array(this.ids.length).fill(patches);
        this.prev=this.ids.map(id=>({...gel(id)}));
    }
    exec() { this.ids.forEach((id,i)=>{const e=gel(id);if(e)Object.assign(e,this.patches[i]);}); }
    undo() { this.prev.forEach(p=>{const e=gel(p.id);if(e)Object.assign(e,p);}); }
}

class CmdReorder {
    constructor(ids,dir) { this.ids=ids; this.dir=dir; this.orig=[...state.elements]; }
    exec() {
        const move=state.elements.filter(e=>this.ids.includes(e.id));
        const rest=state.elements.filter(e=>!this.ids.includes(e.id));
        state.elements=this.dir==='front'?[...rest,...move]:[...move,...rest];
    }
    undo() { state.elements=[...this.orig]; }
}

// Render
function render() {
    renderGrid();
    highlighterLayer.replaceChildren();
    state.elements.filter(e=>e.type==="path"&&e.opacity<0.8).forEach(e=>highlighterLayer.appendChild(renderPath(e)));
    drawingsLayer.replaceChildren();
    state.elements.filter(e=>e.type==="path"&&e.opacity>=0.8).forEach(e=>drawingsLayer.appendChild(renderPath(e)));
    renderEdges();
    nodesLayer.replaceChildren();
    state.elements.filter(e=>e.type!=="path"&&e.type!=="arrow"&&e.type!=="line").forEach(e=>nodesLayer.appendChild(renderNode(e)));
    renderSelection();
    updateProps();
}

function renderGrid() {
    const bg=document.getElementById("grid-bg");
    if(state.settings.gridStyle==='none'){bg.setAttribute("fill","transparent");return;}
    const style=state.settings.gridStyle;
    bg.setAttribute("fill",`url(#grid-${style})`);
    const pat=document.getElementById(`grid-${style}`);
    const bw=style==='dots'?30:40, pw=bw*state.zoom;
    pat.setAttribute("width",pw); pat.setAttribute("height",pw);
    pat.setAttribute("x",state.panX%pw); pat.setAttribute("y",state.panY%pw);
    if(style==='dots'){
        const c=pat.querySelector("circle");
        c.setAttribute("r",Math.max(0.6,1*state.zoom));
        c.setAttribute("cx",pw/2); c.setAttribute("cy",pw/2);
    } else {
        const l=pat.querySelectorAll("line");
        l[0].setAttribute("x2",pw); l[1].setAttribute("y2",pw);
    }
}

function pts2path(pts) {
    if(!pts.length) return "";
    let d=`M ${pts[0].x} ${pts[0].y}`;
    for(let i=1;i<pts.length-1;i++){const xc=(pts[i].x+pts[i+1].x)/2,yc=(pts[i].y+pts[i+1].y)/2;d+=` Q ${pts[i].x} ${pts[i].y},${xc} ${yc}`;}
    d+=` L ${pts[pts.length-1].x} ${pts[pts.length-1].y}`;
    return d;
}

function renderPath(el) {
    if(!el.points||!el.points.length) return svg("path");
    const sa={};
    if(el.strokeStyle==="dashed") sa["stroke-dasharray"]=`${el.strokeWidth*2} ${el.strokeWidth}`;
    else if(el.strokeStyle==="dotted") sa["stroke-dasharray"]=`0 ${el.strokeWidth*2}`;
    const p=svg("path",Object.assign({d:pts2path(el.points),fill:"none",stroke:el.stroke,"stroke-width":el.strokeWidth,"stroke-linecap":"round","stroke-linejoin":"round",opacity:el.opacity,class:"freehand-path","data-id":el.id},sa));
    if(el.rotation){
        const b=getPathBounds(el.points);
        const cx=b.x+b.w/2,cy=b.y+b.h/2;
        const g=svg("g",{transform:`rotate(${el.rotation},${cx},${cy})`,"data-id":el.id});
        g.appendChild(p);
        return g;
    }
    return p;
}

function renderEdges() {
    edgesLayer.replaceChildren();
    state.elements.filter(e=>e.type==="arrow"||e.type==="line").forEach(a=>{
        let fp,tp;
        if(a.fromId&&a.toId){
            const fe=gel(a.fromId),te=gel(a.toId);
            if(!fe||!te) return;
            const ep=getAnchors(fe,te,a.fromSocket,a.toSocket);
            fp=ep.s; tp=ep.e;
        } else { fp=a.points[0]; tp=a.points[1]; }
        if(!fp||!tp) return;
        const att={x1:fp.x,y1:fp.y,x2:tp.x,y2:tp.y,stroke:a.stroke,"stroke-width":a.strokeWidth,class:"arrow-line","data-id":a.id};
        if(a.type==="arrow") att["marker-end"]="url(#arrowhead)";
        if(a.strokeStyle==="dashed") att["stroke-dasharray"]=`${a.strokeWidth*2} ${a.strokeWidth}`;
        else if(a.strokeStyle==="dotted") att["stroke-dasharray"]=`0 ${a.strokeWidth*2}`;
        edgesLayer.appendChild(svg("line",att));
        if(a.text){
            const mx=(fp.x+tp.x)/2, my=(fp.y+tp.y)/2-8;
            const t=svg("text",{x:mx,y:my,class:"arrow-label"}); t.textContent=a.text; edgesLayer.appendChild(t);
        }
    });
}

function getAnchors(from,to,fs,ts) {
    const fb={x:from.x,y:from.y,w:from.width,h:from.height}, tb={x:to.x,y:to.y,w:to.width,h:to.height};
    const sc=(b,s)=>{if(s==='top')return{x:b.x+b.w/2,y:b.y};if(s==='bottom')return{x:b.x+b.w/2,y:b.y+b.h};if(s==='left')return{x:b.x,y:b.y+b.h/2};if(s==='right')return{x:b.x+b.w,y:b.y+b.h/2};return{x:b.x+b.w/2,y:b.y+b.h/2};};
    let af=fs, at=ts;
    if(!af||!at){
        const fc={x:fb.x+fb.w/2,y:fb.y+fb.h/2}, tc={x:tb.x+tb.w/2,y:tb.y+tb.h/2};
        const dx=tc.x-fc.x, dy=tc.y-fc.y;
        if(Math.abs(dx)>Math.abs(dy)){af=dx>0?'right':'left';at=dx>0?'left':'right';}
        else{af=dy>0?'bottom':'top';at=dy>0?'top':'bottom';}
    }
    return {s:sc(fb,af),e:sc(tb,at)};
}

function renderNode(el) {
    const g=svg("g",{class:`node ${el.type}`,transform:`translate(${el.x},${el.y})${el.rotation?` rotate(${el.rotation},${el.width/2},${el.height/2})`:""}`,"data-id":el.id});
    let shape;
    const ca={width:el.width,height:el.height,fill:el.color,stroke:el.stroke,"stroke-width":el.strokeWidth,class:"node-shape"};
    if(el.strokeStyle==="dashed") ca["stroke-dasharray"]=`${el.strokeWidth*2} ${el.strokeWidth}`;
    else if(el.strokeStyle==="dotted") ca["stroke-dasharray"]=`0 ${el.strokeWidth*2}`;
    if(el.type==="rect"||el.type==="sticky"){shape=svg("rect",ca);}
    else if(el.type==="ellipse"){shape=svg("ellipse",{cx:el.width/2,cy:el.height/2,rx:el.width/2,ry:el.height/2,fill:el.color,stroke:el.stroke,"stroke-width":el.strokeWidth,class:"node-shape"});if(ca["stroke-dasharray"])shape.setAttribute("stroke-dasharray",ca["stroke-dasharray"]);}
    else if(el.type==="triangle"){shape=svg("polygon",{points:`0,${el.height} ${el.width/2},0 ${el.width},${el.height}`,fill:el.color,stroke:el.stroke,"stroke-width":el.strokeWidth,class:"node-shape","stroke-dasharray":ca["stroke-dasharray"]||null});}
    else if(el.type==="diamond"){shape=svg("polygon",{points:`${el.width/2},0 ${el.width},${el.height/2} ${el.width/2},${el.height} 0,${el.height/2}`,fill:el.color,stroke:el.stroke,"stroke-width":el.strokeWidth,class:"node-shape","stroke-dasharray":ca["stroke-dasharray"]||null});}
    else if(el.type==="text"){shape=svg("rect",{width:el.width,height:el.height,fill:"transparent",stroke:state.selectedIds.includes(el.id)?"transparent":"rgba(100,100,100,0.15)","stroke-width":1,"stroke-dasharray":"3 3"});}
    g.appendChild(shape);
    const fw=el.type==="ellipse"?el.width*0.7:el.type==="diamond"?el.width*0.6:el.width;
    const fh=el.type==="ellipse"?el.height*0.7:el.type==="diamond"?el.height*0.6:el.height;
    const ox=(el.width-fw)/2, oy=(el.height-fh)/2;
    const fr=svg("foreignObject",{x:ox,y:oy,width:fw,height:fh});
    const tb=html("div",{class:`node-text font-${el.fontFamily||"sans"}`,contenteditable:"false","data-id":el.id,spellcheck:"true"},el.text);
    fr.appendChild(tb); g.appendChild(fr);
    return g;
}

function renderSelection() {
    selectionLayer.replaceChildren();
    if(!state.selectedIds.length) return;
    if(state.selectedIds.length===1){
        const el=gel(state.selectedIds[0]); if(!el||el.type==="arrow") return;
        if(el.type==="path"){
            const p=el.points; if(!p||!p.length) return;
            const b=getPathBounds(p); const pad=6;
            selectionLayer.appendChild(svg("rect",{x:b.x-pad,y:b.y-pad,width:b.w+pad*2,height:b.h+pad*2,class:"selection-outline"}));
            const rot=svg("circle",{cx:b.x+b.w/2,cy:b.y-16,r:6,class:"rotate-handle","data-id":el.id,"data-handle":"rotate"});
            selectionLayer.appendChild(rot);
            const rod=svg("line",{x1:b.x+b.w/2,y1:b.y-pad,x2:b.x+b.w/2,y2:b.y-10,stroke:"var(--accent)","stroke-width":1.5,class:"rotate-handle","data-id":el.id});
            selectionLayer.appendChild(rod);
            return;
        }
        const p=6;
        const r=svg("rect",{x:el.x-p,y:el.y-p,width:el.width+p*2,height:el.height+p*2,class:"selection-outline"});
        selectionLayer.appendChild(r);
        const rh=svg("rect",{x:el.x+el.width+p-7,y:el.y+el.height+p-7,width:14,height:14,rx:7,class:"resize-handle","data-id":el.id,"data-handle":"se"});
        selectionLayer.appendChild(rh);
        const rot=svg("circle",{cx:el.x+el.width/2,cy:el.y-16,r:6,class:"rotate-handle","data-id":el.id,"data-handle":"rotate"});
        selectionLayer.appendChild(rot);
        const rod=svg("line",{x1:el.x+el.width/2,y1:el.y-p,x2:el.x+el.width/2,y2:el.y-10,stroke:"var(--accent)","stroke-width":1.5,class:"rotate-handle","data-id":el.id});
        selectionLayer.appendChild(rod);
    } else {
        const b=selBounds(); if(!b) return;
        const p=6;
        selectionLayer.appendChild(svg("rect",{x:b.minX-p,y:b.minY-p,width:(b.maxX-b.minX)+p*2,height:(b.maxY-b.minY)+p*2,class:"selection-outline"}));
    }
}

function selBounds() {
    if(!state.selectedIds.length) return null;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    state.selectedIds.forEach(id=>{const e=gel(id);if(!e)return;if(e.type==="path"){if(e.points)e.points.forEach(pt=>{minX=Math.min(minX,pt.x);minY=Math.min(minY,pt.y);maxX=Math.max(maxX,pt.x);maxY=Math.max(maxY,pt.y);});}else if(e.type!=="arrow"&&e.type!=="line"){minX=Math.min(minX,e.x);minY=Math.min(minY,e.y);maxX=Math.max(maxX,e.x+e.width);maxY=Math.max(maxY,e.y+e.height);}});
    return minX===Infinity?null:{minX,minY,maxX,maxY};
}

function updateProps() {
    if(!state.selectedIds.length){properties.classList.add("hidden");return;}
    properties.classList.remove("hidden");
    const el=gel(state.selectedIds[0]); if(!el) return;
    const hasText=state.selectedIds.some(id=>{const i=gel(id);return i&&(i.type==='text'||i.type==='sticky'||i.text);});
    document.querySelector(".text-prop").classList.toggle("hidden",!hasText);
    const isPath=el.type==="path";
    document.getElementById("stroke-color-input").value=el.stroke;
    document.getElementById("fill-color-input").value=el.color==="transparent"?"#ffffff":el.color;
    document.getElementById("font-select").value=el.fontFamily||"sans";
    document.getElementById("rotation-slider").value=el.rotation||0;
    document.getElementById("rotation-label").textContent=(el.rotation||0)+"°";
    renderPresets("stroke-presets",COLORS.stroke,el.stroke,'stroke');
    renderPresets("fill-presets",COLORS.fill,el.color,'color');
    document.querySelectorAll(".stroke-chip").forEach(b=>b.classList.toggle("active",Number(b.dataset.value)===el.strokeWidth));
    document.querySelectorAll(".style-chip").forEach(b=>b.classList.toggle("active",b.dataset.value===el.strokeStyle));
    // Show/hide width/style for paths (pen/marker) vs shapes
    document.querySelectorAll(".stroke-chip, .style-chip").forEach(b=>b.style.display=isPath?"inline-flex":"inline-flex");
}

function renderPresets(containerId,colors,selected,key) {
    const p=document.getElementById(containerId); p.replaceChildren();
    colors.forEach(c=>{
        const ch=document.createElement("div"); ch.className="color-chip";
        if(c==="transparent"){ch.style.background="repeating-linear-gradient(45deg,#ccc,#ccc 2px,#fff 2px,#fff 4px)";ch.title="No Fill";}
        else ch.style.background=c;
        if(c===selected) ch.classList.add("active");
        ch.addEventListener("click",()=>{
            if(key==='color'&&c==='transparent'&&state.selectedIds.every(id=>gel(id)?.type==='sticky')) return;
            exec(new CmdUpdate(state.selectedIds,{[key]:c}));
        });
        p.appendChild(ch);
    });
}

// Pointer events
function pd(e) {
    if(e.pointerType==="touch"&&!e.isPrimary) return;
    exportMenu.classList.add("hidden"); aiActions.classList.add("hidden");
    if(document.activeElement?.classList.contains("node-text")){const a=document.activeElement;if(e.target!==a) commitText(a);}
    const pt=bp(e), tgt=e.target;
    if(state.tool==="hand"||e.button===1||e.button===2){e.preventDefault();state.drag={type:"pan",sx:e.clientX,sy:e.clientY};board.setPointerCapture(e.pointerId);return;}
    if(state.tool==="pencil"||state.tool==="marker"){e.preventDefault();beginDraw(e,pt);return;}
    if(state.tool==="laser"){e.preventDefault();beginLaser(e,pt);return;}
    if(state.tool==="eraser"){e.preventDefault();state.erasedEls=[];eraseAtPoint(e.clientX,e.clientY);state.eraserDrag=true;board.setPointerCapture(e.pointerId);return;}
    if(["rect","ellipse","triangle","diamond","text","sticky"].includes(state.tool)){createShape(state.tool,pt);return;}
    if(state.tool==="line"||state.tool==="arrow"){e.preventDefault();beginConnector(e,pt);return;}
    if(state.tool==="select"){
        const rh=tgt.closest(".resize-handle");
        const rth=tgt.closest(".rotate-handle");
        const node=tgt.closest(".node");
        const path=tgt.closest(".freehand-path");
        if(rh){e.preventDefault();const id=rh.dataset.id,el=gel(id);state.resize={id,sx:pt.x,sy:pt.y,w:el.width,h:el.height};board.setPointerCapture(e.pointerId);return;}
        if(rth){e.preventDefault();const id=rth.dataset.id,el=gel(id);let ox,oy;if(el.type==="path"&&el.points?.length){const b=getPathBounds(el.points);ox=b.x+b.w/2;oy=b.y+b.h/2;}else{ox=el.x+el.width/2;oy=el.y+el.height/2;}state.rotate={id,sx:pt.x,sy:pt.y,ox,oy,start:el.rotation||0};board.setPointerCapture(e.pointerId);return;}
        if(node){e.preventDefault();const id=node.dataset.id;
            if(e.ctrlKey||e.shiftKey){if(state.selectedIds.includes(id))state.selectedIds=state.selectedIds.filter(x=>x!==id);else state.selectedIds.push(id);}
            else if(!state.selectedIds.includes(id)) state.selectedIds=[id];
            const orig=state.selectedIds.map(sid=>{const e=gel(sid);return{id:sid,sx:e.x,sy:e.y};});
            state.drag={type:"move",sx:pt.x,sy:pt.y,orig};board.setPointerCapture(e.pointerId);render();return;}
        if(path){e.preventDefault();const id=path.dataset.id;
            if(e.ctrlKey||e.shiftKey){if(state.selectedIds.includes(id))state.selectedIds=state.selectedIds.filter(x=>x!==id);else state.selectedIds.push(id);}
            else if(!state.selectedIds.includes(id)) state.selectedIds=[id];
            render();return;}
        state.selectionBox={sx:pt.x,sy:pt.y,cx:pt.x,cy:pt.y};
        if(!e.ctrlKey&&!e.shiftKey) state.selectedIds=[];
        render();
    }
}

function pm(e) {
    const pt=bp(e);
    if(state.drag?.type==="pan"){state.panX+=e.clientX-state.drag.sx;state.panY+=e.clientY-state.drag.sy;state.drag.sx=e.clientX;state.drag.sy=e.clientY;viewport.setAttribute("transform",`translate(${state.panX},${state.panY}) scale(${state.zoom})`);renderGrid();return;}
    if(state.drag?.type==="move"){const dx=pt.x-state.drag.sx,dy=pt.y-state.drag.sy;state.drag.orig.forEach(o=>{const e=gel(o.id);if(e){e.x=snap(o.sx+dx);e.y=snap(o.sy+dy);}});render();return;}
    if(state.resize){const dx=pt.x-state.resize.sx,dy=pt.y-state.resize.sy;const e=gel(state.resize.id);if(e){e.width=snap(Math.max(30,state.resize.w+dx));e.height=snap(Math.max(30,state.resize.h+dy));render();}return;}
    if(state.rotate){const e=gel(state.rotate.id);if(e){const a=Math.atan2(pt.y-state.rotate.oy,pt.x-state.rotate.ox)*180/Math.PI;e.rotation=((a+90)%360+360)%360;document.getElementById("rotation-slider").value=e.rotation;document.getElementById("rotation-label").textContent=Math.round(e.rotation)+"°";render();}return;}
    if(state.drawing){const e=gel(state.drawing);if(e){const l=e.points[e.points.length-1];if(Math.hypot(pt.x-l.x,pt.y-l.y)>3){e.points.push(pt);const el=drawingsLayer.querySelector(`[data-id="${e.id}"]`)||highlighterLayer.querySelector(`[data-id="${e.id}"]`);if(el){const p=el.tagName==="g"?el.querySelector("path"):el;if(p)p.setAttribute("d",pts2path(e.points));}}}return;}
    if(state.laserPath){state.laserPath.push(pt);renderLaser();return;}
    if(state.drag?.type==="connector"){const l=edgesLayer.querySelector(`.arrow-line[data-id="${state.drag.aid}"]`);if(l){const sn=state.drag.isConnected?findNode(pt):null;let tx=pt.x,ty=pt.y;if(sn&&sn.id!==state.drag.fid){tx=sn.x+sn.width/2;ty=sn.y+sn.height/2;}l.setAttribute("x2",tx);l.setAttribute("y2",ty);}return;}
    if(state.eraserDrag){e.preventDefault();eraseAtPoint(e.clientX,e.clientY);return;}
    if(state.selectionBox){state.selectionBox.cx=pt.x;state.selectionBox.cy=pt.y;
        const mnx=Math.min(state.selectionBox.sx,state.selectionBox.cx),mny=Math.min(state.selectionBox.sy,state.selectionBox.cy);
        const mxx=Math.max(state.selectionBox.sx,state.selectionBox.cx),mxy=Math.max(state.selectionBox.sy,state.selectionBox.cy);
        let box=selectionLayer.querySelector(".drag-select-box");
        if(!box){box=svg("rect",{class:"drag-select-box"});selectionLayer.appendChild(box);}
        box.setAttribute("x",mnx);box.setAttribute("y",mny);box.setAttribute("width",mxx-mnx);box.setAttribute("height",mxy-mny);
        state.elements.forEach(el=>{if(el.type==="path"||el.type==="arrow")return;const i=!(el.x>mxx||el.x+el.width<mnx||el.y>mxy||el.y+el.height<mny);if(i){if(!state.selectedIds.includes(el.id))state.selectedIds.push(el.id);}else{if(!e.ctrlKey&&!e.shiftKey)state.selectedIds=state.selectedIds.filter(x=>x!==el.id);}});
        updateProps();return;}
}

function pu(e) {
    if(state.drag?.type==="pan"){state.drag=null;return;}
    if(state.drag?.type==="move"){const ids=[],patches=[];let moved=false;state.drag.orig.forEach(o=>{const e=gel(o.id);if(e&&(e.x!==o.sx||e.y!==o.sy)){ids.push(e.id);patches.push({x:e.x,y:e.y});moved=true;}});if(moved){state.drag.orig.forEach(o=>{const e=gel(o.id);if(e){e.x=o.sx;e.y=o.sy;}});exec(new CmdUpdate(ids,patches));}state.drag=null;return;}
    if(state.resize){const e=gel(state.resize.id);if(e&&(e.width!==state.resize.w||e.height!==state.resize.h)){const fw=e.width,fh=e.height;e.width=state.resize.w;e.height=state.resize.h;exec(new CmdUpdate(state.resize.id,{width:fw,height:fh}));}state.resize=null;return;}
    if(state.rotate){const e=gel(state.rotate.id);if(e){const fr=e.rotation;e.rotation=state.rotate.start;exec(new CmdUpdate(state.rotate.id,{rotation:fr}));}state.rotate=null;return;}
    if(state.drawing){const e=gel(state.drawing);state.drawing=null;if(e){if(e.points.length<2){state.elements=state.elements.filter(x=>x.id!==e.id);render();return;}if(state.settings.smartDraw){const d=recognize(e.points);if(d){state.elements=state.elements.filter(x=>x.id!==e.id);createShapeBB(d.type,d.bounds);return;}}state.elements=state.elements.filter(x=>x.id!==e.id);exec(new CmdCreate(e));}return;}
    if(state.laserPath){state.laserPath=null;return;}
    if(state.drag?.type==="connector"){const pt=bp(e);const dist=Math.hypot(pt.x-state.drag.startPt.x,pt.y-state.drag.startPt.y);if(dist<5){if(state.drag.isConnected){state.elements=state.elements.filter(x=>x.id!==state.drag.aid);}state.drag=null;render();return;}const sn=findNode(pt);const opts=state.penOptions;if(state.drag.isConnected&&sn&&sn.id!==state.drag.fid){state.elements=state.elements.filter(x=>x.id!==state.drag.aid);const fa=normalize({id:state.drag.aid,type:state.tool,fromId:state.drag.fid,toId:sn.id,stroke:opts.stroke,strokeWidth:opts.strokeWidth,strokeStyle:opts.strokeStyle});exec(new CmdCreate(fa));}else{if(state.drag.isConnected)state.elements=state.elements.filter(x=>x.id!==state.drag.aid);const fa=normalize({id:state.drag.aid,type:state.tool,points:[state.drag.startPt,pt],stroke:opts.stroke,strokeWidth:opts.strokeWidth,strokeStyle:opts.strokeStyle});exec(new CmdCreate(fa));}state.drag=null;render();return;}
    if(state.eraserDrag){
        if(state.erasedEls?.length){
            const batch=state.erasedEls;
            state.undoStack.push({exec(){const s=new Set();batch.forEach(r=>{s.add(r.element.id);r.connectedArrows.forEach(a=>s.add(a.id));});state.elements=state.elements.filter(e=>!s.has(e.id));state.selectedIds=state.selectedIds.filter(id=>!s.has(id));},undo(){batch.forEach(r=>{state.elements.push({...r.element});r.connectedArrows.forEach(a=>state.elements.push({...a}));});render();}});
            state.redoStack=[];persist();
        }
        state.eraserDrag=false;state.erasedEls=null;render();return;
    }
    if(state.selectionBox){state.selectionBox=null;const box=selectionLayer.querySelector(".drag-select-box");if(box)box.remove();render();return;}
}

// Drawing
function beginDraw(e,pt) {
    const isMarker=state.tool==="marker";
    const opts=state.penOptions;
    const el=normalize({id:id("path"),type:"path",points:[pt],stroke:opts.stroke,strokeWidth:isMarker?Math.max(opts.strokeWidth,8):opts.strokeWidth,strokeStyle:opts.strokeStyle,opacity:isMarker?0.35:1});
    state.drawing=el.id; state.elements.push(el); state.selectedIds=[];
    (isMarker?highlighterLayer:drawingsLayer).appendChild(renderPath(el));
    board.setPointerCapture(e.pointerId);
}

function beginLaser(e,pt){state.laserPath=[pt];board.setPointerCapture(e.pointerId);}

function renderLaser() {
    const laserLayer=document.getElementById("laser-layer");
    laserLayer.replaceChildren();
    if(!state.laserPath||state.laserPath.length<2) return;
    const p=svg("path",{d:pts2path(state.laserPath),class:"laser-path","stroke-width":6});
    laserLayer.appendChild(p);
    const active=state.laserPath; let op=1;
    function fade(){if(!state.laserPath||state.laserPath!==active){op-=0.08;if(op<=0)p.remove();else{p.setAttribute("opacity",op);requestAnimationFrame(fade);}}else requestAnimationFrame(fade);}
    requestAnimationFrame(fade);
}

// Shapes
function createShape(type,pt) {
    const isSticky=type==="sticky", isText=type==="text";
    const def=DEFAULTS[type]||{w:120,h:80};
    const el=normalize({type,x:snap(pt.x-def.w/2),y:snap(pt.y-def.h/2),width:def.w,height:def.h,
        color:isSticky?COLORS.sticky[Math.floor(Math.random()*COLORS.sticky.length)]:(isText?"transparent":COLORS.fill[6]),
        stroke:isText?"transparent":COLORS.stroke[0]});
    exec(new CmdCreate(el));
    state.selectedIds=[el.id]; setTool("select");
    setTimeout(()=>{const tb=nodesLayer.querySelector(`.node-text[data-id="${el.id}"]`);if(tb)beginEdit(tb);},100);
}

function createShapeBB(type,bounds) {
    exec(new CmdCreate(normalize({type,x:snap(bounds.x),y:snap(bounds.y),width:snap(bounds.w),height:snap(bounds.h),color:COLORS.fill[6],stroke:state.settings.theme==='dark'?"#f8fafc":"#0f172a"})));
}

function beginConnector(e,pt){
    const aid=id("arrow");
    const sn=findNode(pt);
    const opts=state.penOptions;
    state.drag={type:"connector",aid,fid:sn?.id||null,startPt:pt,isConnected:!!sn};
    if(sn){
        const a=normalize({id:aid,type:state.tool,points:[pt,pt],fromId:sn.id,stroke:opts.stroke,strokeWidth:opts.strokeWidth,strokeStyle:opts.strokeStyle});
        state.elements.push(a);
    }
    const tmp=svg("line",{x1:pt.x,y1:pt.y,x2:pt.x,y2:pt.y,class:"arrow-line","data-id":aid,stroke:opts.stroke,"stroke-width":opts.strokeWidth,"stroke-dasharray":"6 4"});
    edgesLayer.appendChild(tmp);
    board.setPointerCapture(e.pointerId);
}

function findNode(pt) {
    for(let i=state.elements.length-1;i>=0;i--){const e=state.elements[i];if(e.type==="path"||e.type==="arrow"||e.type==="line")continue;if(pt.x>=e.x&&pt.x<=e.x+e.width&&pt.y>=e.y&&pt.y<=e.y+e.height)return e;}
    return null;
}

function getElBounds(e){
    if(e.type==="path"&&e.points) return getPathBounds(e.points);
    if(e.type==="arrow"||e.type==="line"){
        if(e.fromId&&e.toId){const fe=gel(e.fromId),te=gel(e.toId);if(!fe||!te)return null;const ep=getAnchors(fe,te,e.fromSocket,e.toSocket);return{x:Math.min(ep.s.x,ep.e.x),y:Math.min(ep.s.y,ep.e.y),w:Math.max(Math.abs(ep.e.x-ep.s.x),20),h:Math.max(Math.abs(ep.e.y-ep.s.y),20)};}
        if(e.points&&e.points.length>=2){const p=e.points;return{x:Math.min(p[0].x,p[1].x),y:Math.min(p[0].y,p[1].y),w:Math.max(Math.abs(p[1].x-p[0].x),20),h:Math.max(Math.abs(p[1].y-p[0].y),20)};}
        return null;
    }
    if(e.x!==undefined) return {x:e.x,y:e.y,w:e.width||40,h:e.height||40};
    return null;
}

function eraseAtPoint(cx,cy){
    const vp=bp({clientX:cx,clientY:cy});
    const margin=12/state.zoom;
    for(let i=state.elements.length-1;i>=0;i--){
        const e=state.elements[i];if(!e)continue;
        const b=getElBounds(e);if(!b)continue;
        if(vp.x<b.x-margin||vp.x>b.x+b.w+margin||vp.y<b.y-margin||vp.y>b.y+b.h+margin)continue;
        if(state.erasedEls?.some(x=>x.id===e.id))continue;
        const arrows=state.elements.filter(a=>a.type==="arrow"&&(a.fromId===e.id||a.toId===e.id));
        state.erasedEls?.push({element:{...e},connectedArrows:arrows.map(a=>({...a}))});
        const allIds=new Set([e.id]);
        arrows.forEach(a=>allIds.add(a.id));
        state.elements=state.elements.filter(el=>!allIds.has(el.id));
        state.selectedIds=state.selectedIds.filter(sid=>!allIds.has(sid));
        render();
        return;
    }
}

// Text editing
function beginEdit(t){t.setAttribute("contenteditable","true");t.focus();const r=document.createRange();r.selectNodeContents(t);r.collapse(false);const s=window.getSelection();s.removeAllRanges();s.addRange(r);}
function commitText(t){const id=t.dataset.id,el=gel(id);if(!el)return;t.setAttribute("contenteditable","false");const ct=t.textContent.trim();if(ct!==el.text)exec(new CmdUpdate(id,{text:ct}));else render();}

// Smart shape recognition
function recognize(pts) {
    if(pts.length<15)return null;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    pts.forEach(p=>{minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);});
    const w=maxX-minX,h=maxY-minY; if(w<20||h<20)return null;
    const cx=minX+w/2,cy=minY+h/2,s=pts[0],e=pts[pts.length-1];
    const dSE=Math.hypot(s.x-e.x,s.y-e.y),diag=Math.hypot(w,h);
    if(dSE>diag*0.7){let maxDev=0;const dy=e.y-s.y,dx=e.x-s.x,len=Math.hypot(dx,dy);pts.forEach(p=>{const dev=Math.abs(dy*p.x-dx*p.y+e.x*s.y-e.y*s.x)/len;maxDev=Math.max(maxDev,dev);});if(maxDev<diag*0.08)return{type:"line",bounds:{x:s.x,y:s.y,w:e.x-s.x,h:e.y-s.y}};}
    const closed=dSE<diag*0.35;if(!closed)return null;
    let totalR=0;pts.forEach(p=>totalR+=Math.hypot(p.x-cx,p.y-cy));const avgR=totalR/pts.length;
    let varR=0;pts.forEach(p=>varR+=Math.pow(Math.hypot(p.x-cx,p.y-cy)-avgR,2));const std=Math.sqrt(varR/pts.length);
    if(std/avgR<0.14)return{type:"ellipse",bounds:{x:minX,y:minY,w,h}};
    const per=2*(w+h);let len=0;for(let i=0;i<pts.length-1;i++)len+=Math.hypot(pts[i+1].x-pts[i].x,pts[i+1].y-pts[i].y);
    const rPer=len/per;
    if(rPer>=0.8&&rPer<=1.3){let nM=0;pts.forEach(p=>{const rx=p.x-cx,ry=p.y-cy;if(Math.abs(Math.abs(rx)-w/2)+Math.abs(ry)<diag*0.18||Math.abs(rx)+Math.abs(Math.abs(ry)-h/2)<diag*0.18)nM++;});if(nM>pts.length*0.4)return{type:"diamond",bounds:{x:minX,y:minY,w,h}};return{type:"rect",bounds:{x:minX,y:minY,w,h}};}
    const top=pts.filter(p=>p.y<minY+h*0.3).length,bl=pts.filter(p=>p.x<minX+w*0.3&&p.y>maxY-h*0.3).length,br=pts.filter(p=>p.x>maxX-w*0.3&&p.y>maxY-h*0.3).length;
    if(top>0&&bl>0&&br>0)return{type:"triangle",bounds:{x:minX,y:minY,w,h}};
    return null;
}

// Camera
function applyVp(){viewport.setAttribute("transform",`translate(${state.panX},${state.panY}) scale(${state.zoom})`);renderGrid();}
function zoom(factor,e){
    let mx,my;
    if(e){const r=board.getBoundingClientRect();mx=e.clientX-r.left;my=e.clientY-r.top;}
    else{mx=board.clientWidth/2;my=board.clientHeight/2;}
    const cx=(mx-state.panX)/state.zoom,cy=(my-state.panY)/state.zoom;
    state.zoom=Math.min(Math.max(0.08,state.zoom*factor),20);
    state.panX=mx-cx*state.zoom;state.panY=my-cy*state.zoom;
    applyVp();zoomText.textContent=`${Math.round(state.zoom*100)}%`;render();
}
function resetZ(){state.zoom=1;state.panX=0;state.panY=0;applyVp();zoomText.textContent="100%";render();}
function zoomFit(){
    if(!state.elements.length){resetZ();return;}
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    state.elements.forEach(el=>{if(el.type==="path"){el.points.forEach(p=>{minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);});}else{minX=Math.min(minX,el.x);minY=Math.min(minY,el.y);maxX=Math.max(maxX,el.x+el.width);maxY=Math.max(maxY,el.y+el.height);}});
    const w=maxX-minX,h=maxY-minY,scX=(board.clientWidth-100)/w,scY=(board.clientHeight-100)/h;
    state.zoom=Math.min(Math.max(0.1,Math.min(scX,scY)),2);
    state.panX=board.clientWidth/2-(minX+w/2)*state.zoom;state.panY=board.clientHeight/2-(minY+h/2)*state.zoom;
    applyVp();zoomText.textContent=`${Math.round(state.zoom*100)}%`;render();
}

// Copy/Paste/Undo/Redo
let copied=null;
function copySel(){if(!state.selectedIds.length)return;copied=JSON.stringify(state.selectedIds.map(id=>gel(id)).filter(Boolean));}
function pasteSel(){if(!copied)return;try{const parsed=JSON.parse(copied);const map=new Map;const els=parsed.map(o=>{const c=normalize({...o,id:id(o.type),x:o.x+40,y:o.y+40});map.set(o.id,c.id);return c;});els.forEach(el=>{if(el.type==='arrow'){if(el.fromId&&map.has(el.fromId))el.fromId=map.get(el.fromId);if(el.toId&&map.has(el.toId))el.toId=map.get(el.toId);}});exec(new CmdCreate(els));state.selectedIds=els.map(el=>el.id);render();}catch(e){console.error(e);}}
function undo(){if(!state.undoStack.length)return;const c=state.undoStack.pop();c.undo();state.redoStack.push(c);persist();render();}
function redo(){if(!state.redoStack.length)return;const c=state.redoStack.pop();c.exec();state.undoStack.push(c);persist();render();}

// Persistence
let persistTimer=null;
function saveLocal(){
    savePageState();
    localStorage.setItem("board-pages",JSON.stringify(state.pages));
    localStorage.setItem("board-current-page",state.currentPageIndex);
    document.getElementById("sync-status").textContent="Saved";
}
function loadLocal(){
    try {
        const pagesData=localStorage.getItem("board-pages");
        if(pagesData){
            state.pages=JSON.parse(pagesData);
            state.currentPageIndex=Number(localStorage.getItem("board-current-page"))||0;
        } else {
            const old=JSON.parse(localStorage.getItem(STORAGE_KEY)||"[]");
            state.pages=[{id:id("page"),name:"Page 1",elements:Array.isArray(old)?old:[]}];
            state.currentPageIndex=0;
        }
    } catch(e){state.pages=[{id:id("page"),name:"Page 1",elements:[]}];state.currentPageIndex=0;}
    loadPageElements(state.currentPageIndex);
    render();
}
function persist(){clearTimeout(persistTimer);persistTimer=setTimeout(saveLocal,200);}

// Export
function getSVG(){
    const c=board.cloneNode(true);const bg=c.querySelector("#grid-bg");if(bg)bg.remove();
    const sl=c.querySelector("#selection-layer");if(sl)sl.remove();
    const vg=c.querySelector("#viewport");vg.removeAttribute("transform");
    const st=document.createElementNS(SVG_NS,"style");
    st.textContent=".node-shape{stroke:#000;stroke-width:2px}.freehand-path{fill:none;stroke-linecap:round}.arrow-line{fill:none;stroke-linecap:round}.arrowhead{fill:#000}.node-text{font-family:sans-serif;font-size:14px;text-align:center}.sticky .node-text{font-family:monospace;text-align:left}";
    c.insertBefore(st,c.firstChild);
    return new XMLSerializer().serializeToString(c);
}
function download(content,fn,mime){const b=new Blob([content],{type:mime});const u=URL.createObjectURL(b);const a=document.createElement("a");a.href=u;a.download=fn;a.click();URL.revokeObjectURL(u);}
function exportPNG(){
    const svgData=getSVG();
    const c=document.createElement("canvas");const w=board.clientWidth*2,h=board.clientHeight*2;
    c.width=w;c.height=h;const ctx=c.getContext("2d");
    ctx.fillStyle=state.settings.theme==='dark'?'#0c0a09':'#f5f5f4';ctx.fillRect(0,0,w,h);
    const img=new Image();
    const blob=new Blob([svgData],{type:"image/svg+xml;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    img.onload=()=>{ctx.drawImage(img,0,0,w,h);URL.revokeObjectURL(url);c.toBlob(b=>download(b,"whiteboard.png","image/png"));};
    img.src=url;
}

// Settings
function saveSettings(){
    state.settings.theme=document.getElementById("theme-select").value;
    state.settings.gridStyle=document.getElementById("grid-select").value;
    state.settings.snapGrid=document.getElementById("settings-snap").checked;
    state.settings.smartDraw=document.getElementById("settings-smart").checked;
    state.settings.aiProvider=document.getElementById("ai-provider-select").value;
    state.settings.aiKey=document.getElementById("input-ai-key").value;
    state.settings.penOptions={...state.penOptions};
    localStorage.setItem(SETTINGS_KEY,JSON.stringify(state.settings));
    document.documentElement.setAttribute("data-theme",state.settings.theme);
    updateAIHint();
    render();
}
function updateAIHint(){
    const p=state.settings.aiProvider;
    const labels={builtin:"",gemini:"Gemini API Key",openrouter:"OpenRouter API Key",groq:"Groq API Key"};
    const hints={builtin:"No API key or internet needed — generates diagrams locally",gemini:"Get a free key at aistudio.google.com",openrouter:"Get a free key at openrouter.ai/keys",groq:"Get a free key at console.groq.com/keys"};
    const needsKey=p!=="builtin";
    document.getElementById("ai-key-row").classList.toggle("hidden",!needsKey);
    document.getElementById("ai-key-label").textContent=labels[p]||"";
    document.getElementById("ai-key-hint").textContent=hints[p]||"";
}

function loadSettings(){
    try{const s=JSON.parse(localStorage.getItem(SETTINGS_KEY));if(s)Object.assign(state.settings,s);}catch(e){}
    if(state.settings.penOptions) Object.assign(state.penOptions,state.settings.penOptions);
    document.getElementById("theme-select").value=state.settings.theme;
    document.getElementById("grid-select").value=state.settings.gridStyle;
    document.getElementById("settings-snap").checked=state.settings.snapGrid;
    document.getElementById("settings-smart").checked=state.settings.smartDraw;
    document.getElementById("ai-provider-select").value=state.settings.aiProvider;
    document.getElementById("input-ai-key").value=state.settings.aiKey;
    document.documentElement.setAttribute("data-theme",state.settings.theme);
    updateAIHint();
}

// AI
const AI_PROMPTS={
    diagram(desc){return`Generate a flowchart JSON for: ${desc}. Output ONLY valid JSON in this exact format without any extra text: {"boxes":[{"id":"b1","text":"Step 1","x":200,"y":100,"width":160,"height":80,"type":"rect"}],"arrows":[{"fromId":"b1","toId":"b2","label":""}]}. Use rect or diamond types. Place boxes at different x,y positions so they don't overlap. Generate 3-6 boxes.`;},
    mindmap(topic){return`Create a mindmap JSON for: ${topic}. Output ONLY valid JSON: {"nodes":[{"id":"m1","text":"Topic","x":500,"y":300,"width":180,"height":80,"type":"rect","color":"#ddd6fe"}],"edges":[{"fromId":"m1","toId":"m2"}]}. Place central topic at 500,300. Use 3-6 nodes spread across the canvas. Use different pastel colors.`;},
    organize(notes){return`Group these sticky notes by topic and output JSON: {"clusters":[{"name":"Topic","color":"#eff6ff","x":100,"y":100,"width":400,"height":400,"noteIds":["id1"]}]}. Notes: ${notes}. Only output valid JSON.`;},
    suggest(summary){return`Review this whiteboard: ${summary}. Suggest the next logical element to add in 10 words or less.`;},
    explain(summary){return`Review this whiteboard: ${summary}. Describe what this diagram does in 3-5 sentences with markdown formatting.`;}
};

const AI_PROVIDERS={
    builtin:{
        label:"Built-in (Free)",needsKey:false,localOnly:true
    },
    gemini:{
        label:"Gemini (Google)",needsKey:true,
        url:(k)=>`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${encodeURIComponent(k)}`,
        headers:()=>({"Content-Type":"application/json"}),
        body:(p)=>({contents:[{role:"user",parts:[{text:p}]}],generationConfig:{temperature:0.2}}),
        parse:async(d)=>{const t=d?.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("").trim();if(!t)throw new Error("Empty");return t;}
    },
    openrouter:{
        label:"OpenRouter",needsKey:true,
        url:"https://openrouter.ai/api/v1/chat/completions",
        headers:(k)=>({"Content-Type":"application/json","Authorization":`Bearer ${k}`}),
        body:(p)=>({model:"google/gemini-3-flash-preview:free",messages:[{role:"user",content:p}],temperature:0.2}),
        parse:async(d)=>{const t=d?.choices?.[0]?.message?.content;if(!t)throw new Error("Empty");return t;}
    },
    groq:{
        label:"Groq",needsKey:true,
        url:"https://api.groq.com/openai/v1/chat/completions",
        headers:(k)=>({"Content-Type":"application/json","Authorization":`Bearer ${k}`}),
        body:(p)=>({model:"llama-3.3-70b-versatile",messages:[{role:"user",content:p}],temperature:0.2}),
        parse:async(d)=>{const t=d?.choices?.[0]?.message?.content;if(!t)throw new Error("Empty");return t;}
    }
};

async function callAI(prompt,fallbackFn){
    const prov=AI_PROVIDERS[state.settings.aiProvider];
    if(!prov) throw new Error("Unknown AI provider.");
    if(prov.needsKey&&!state.settings.aiKey) throw new Error("This provider needs an API key. Switch to Built-in or add a key in Settings.");
    if(prov.localOnly){
        if(fallbackFn) return fallbackFn();
        throw new Error("Built-in mode uses offline generation.");
    }
    const r=await fetch(typeof prov.url==="function"?prov.url(state.settings.aiKey):prov.url,{method:"POST",headers:prov.headers(state.settings.aiKey),body:JSON.stringify(prov.body(prompt))});
    if(!r.ok){const e=await r.text();throw new Error(`AI error (${r.status}): ${e.slice(0,200)}`);}
    const d=await r.json();
    const t=await prov.parse(d);if(!t)throw new Error("Empty AI response.");
    return t;
}

function parseJSON(raw){const clean=raw.replace(/```json/gi,"").replace(/```/g,"").trim();const s=clean.search(/[\[{]/);const e=Math.max(clean.lastIndexOf("}"),clean.lastIndexOf("]"));if(s===-1||e===-1) throw new Error("No JSON in AI response");return JSON.parse(clean.slice(s,e+1));}

function boardSummary(){
    const nodes=state.elements.filter(e=>e.type!=="path"&&e.type!=="arrow").map(e=>`[${e.id}] ${e.type}: "${e.text}"`).join("\n");
    const edges=state.elements.filter(e=>e.type==="arrow").map(e=>{const f=gel(e.fromId),t=gel(e.toId);return`${f?`"${f.text}"`:"?"} -> ${t?`"${t.text}"`:"?"}${e.text?` [${e.text}]`:""}`;}).join("\n");
    return nodes||edges?`BOARD:\n${nodes}\n\nCONNECTIONS:\n${edges}`:"";
}

const TOPIC_FLOWS={
    mitosis:["Interphase","Prophase","Metaphase","Anaphase","Telophase"],
    "cell cycle":["G1 Phase","S Phase","G2 Phase","Mitosis","Cytokinesis"],
    photosynthesis:["Light Absorption","Water Splitting","ATP Synthesis","Calvin Cycle","Glucose"],
    "cell division":["Interphase","Prophase","Metaphase","Anaphase","Telophase"],
    respiration:["Glycolysis","Pyruvate Oxidation","Krebs Cycle","Electron Transport","ATP"],
    workflow:["Request","Review","Approve","Implement","Verify"],
    pipeline:["Source","Build","Test","Deploy","Monitor"],
    network:["Client","Firewall","Load Balancer","Web Server","Database"],
    login:["Enter Credentials","Validate","Authorize","Session","Dashboard"],
    api:["Request","Auth","Route","Process","Response"],
    "machine learning":["Data Collection","Preprocessing","Training","Evaluation","Deployment"],
    algorithm:["Input","Process","Decision","Loop","Output"]
};
function fallbackDiagram(desc){
    const lower=desc.toLowerCase();
    let steps=null;
    for(const[key,vals]of Object.entries(TOPIC_FLOWS)){if(lower.includes(key)){steps=vals;break;}}
    if(!steps){
        const words=desc.split(/[,.\s]+/).filter(w=>w.length>2).slice(0,5);
        steps=words.length>=2?words:["Start","Process","Review","Done"];
    }
    const created=[];const map=new Map;
    steps.forEach((w,i)=>{const eid=id("rect");const el=normalize({id:eid,type:"rect",x:100+(i%2)*260,y:80+Math.floor(i/2)*180,width:200,height:80,text:w});map.set(i,el.id);created.push(el);});
    for(let i=0;i<steps.length-1;i++){created.push(normalize({type:"arrow",fromId:map.get(i),toId:map.get(i+1)}));}
    return created;
}

async function aiDiagram(desc){
    let raw,data;
    try{raw=await callAI(AI_PROMPTS.diagram(desc),()=>null);if(raw)data=parseJSON(raw);}catch(e){msg(`AI call failed: ${e.message}. Using offline fallback.`);}
    if(data?.boxes?.length){
        const boxes=data.boxes,arrows=data.arrows||[];
        const map=new Map,created=[];
        boxes.forEach((b,i)=>{const el=normalize({id:id(b.type||"rect"),type:b.type||"rect",x:Number(b.x)||200+i*200,y:Number(b.y)||200,width:Number(b.width)||160,height:Number(b.height)||80,text:b.text||`Step ${i+1}`});map.set(b.id,el.id);created.push(el);});
        arrows.forEach(a=>{const fi=map.get(a.fromId),ti=map.get(a.toId);if(fi&&ti)created.push(normalize({type:"arrow",fromId:fi,toId:ti,text:a.label||""}));});
        exec(new CmdCreate(created));zoomFit();
    } else {
        const created=fallbackDiagram(desc);
        exec(new CmdCreate(created));zoomFit();
    }
}

function fallbackMindmap(topic){
    const words=topic.split(/[,.\s]+/).filter(w=>w.length>2).slice(0,5);
    if(words.length<3){words.length=0;words.push("Concept 1","Concept 2","Concept 3","Concept 4");}
    const colors=["#fef08a","#bfdbfe","#bbf7d0","#fbcfe8","#fed7aa"];
    const created=[];const map=new Map;
    const center=normalize({id:id("rect"),type:"rect",x:400,y:250,width:180,height:80,text:topic||"Topic",color:"#ddd6fe"});
    map.set("center",center.id);created.push(center);
    const positions=[[200,100],[600,100],[150,400],[550,400],[700,250]];
    words.forEach((w,i)=>{const pos=positions[i]||[150+i*130,350];const el=normalize({id:id("ellipse"),type:"ellipse",x:pos[0],y:pos[1],width:140,height:70,text:w.charAt(0).toUpperCase()+w.slice(1),color:colors[i%colors.length]});map.set(i,el.id);created.push(el);created.push(normalize({type:"arrow",fromId:map.get("center"),toId:map.get(i)}));});
    return created;
}

async function aiMindmap(topic){
    let raw,data;
    try{raw=await callAI(AI_PROMPTS.mindmap(topic),()=>null);if(raw)data=parseJSON(raw);}catch(e){msg(`AI call failed: ${e.message}. Using offline fallback.`);}
    if(data?.nodes?.length){
        const nodes=data.nodes,edges=data.edges||[];
        const map=new Map,created=[];
        nodes.forEach((n,i)=>{const el=normalize({id:id(n.type||"rect"),type:n.type||"rect",x:Number(n.x)||300+i*160,y:Number(n.y)||200+(i%2)*150,width:Number(n.width)||160,height:Number(n.height)||80,text:n.text||"Idea",color:n.color||COLORS.fill[6]});map.set(n.id,el.id);created.push(el);});
        edges.forEach(e=>{const fi=map.get(e.fromId),ti=map.get(e.toId);if(fi&&ti)created.push(normalize({type:"arrow",fromId:fi,toId:ti}));});
        exec(new CmdCreate(created));zoomFit();
    } else {
        const created=fallbackMindmap(topic);
        exec(new CmdCreate(created));zoomFit();
    }
}

async function aiCluster(){
    const stickies=state.elements.filter(e=>e.type==="sticky");
    if(stickies.length<2){msg("Need at least 2 sticky notes");return;}
    const summary=stickies.map(s=>({id:s.id,text:s.text,x:s.x,y:s.y}));
    let raw,data;
    try{raw=await callAI(AI_PROMPTS.organize(JSON.stringify(summary,null,2)),()=>null);if(raw)data=parseJSON(raw);}catch(e){msg(`AI call failed: ${e.message}`);}
    const clusters=(data?.clusters||[]).length?data.clusters:[{name:"Notes",color:"#eff6ff",x:80,y:80,width:500,height:400,noteIds:stickies.map(s=>s.id)}];
    const created=[],ids=[],patches=[];
    clusters.forEach(c=>{
        created.push(normalize({type:"rect",x:snap(c.x),y:snap(c.y),width:snap(c.width),height:snap(c.height),text:c.name.toUpperCase(),color:c.color||COLORS.fill[1],strokeStyle:"dashed",fontFamily:"serif",stroke:"#7c3aed"}));
        if(Array.isArray(c.noteIds)){let idx=0;c.noteIds.forEach(nid=>{const n=gel(nid);if(n){const r=Math.floor(idx/2),col=idx%2;ids.push(nid);patches.push({x:snap(c.x+40+col*(n.width+30)),y:snap(c.y+60+r*(n.height+30))});idx++;}});}
    });
    if(created.length) exec(new CmdCreate(created));
    if(ids.length) exec(new CmdUpdate(ids,patches));
    zoomFit();
}

function fallbackSuggest(summary){const items=summary.match(/"([^"]+)"/g);if(items&&items.length>2)return `Try adding a connection between "${items[0]?.replace(/"/g,'')}" and "${items[1]?.replace(/"/g,'')}" with a labeled arrow.`;return "Add a sticky note with next steps or a decision diamond to expand the flow.";}

async function aiSuggest(){
    const s=boardSummary();if(!s){msg("Board is empty");return;}
    let t;
    try{t=await callAI(AI_PROMPTS.suggest(s),()=>fallbackSuggest(s));}catch(e){t=fallbackSuggest(s);}
    document.getElementById("suggestion-text").textContent=t;
    suggestionPanel.classList.remove("hidden");
}

async function aiExplain(){
    const s=boardSummary();if(!s){msg("Board is empty");return;}
    let md;
    try{md=await callAI(AI_PROMPTS.explain(s),()=>{const c=state.elements.filter(e=>e.type!=="path"&&e.type!=="arrow").length;const a=state.elements.filter(e=>e.type==="arrow").length;return`**Board Overview**\n\nThis whiteboard contains **${c} elements** connected by **${a} arrows**. The diagram visually represents a structured workflow or concept map. Each shape captures an idea or step, and the arrows show relationships and flow between them.`;});}catch(e){md="*Board explanation unavailable offline.*";}
    document.getElementById("explain-text").innerHTML=md.replace(/### (.*)/g,'<h3>$1</h3>').replace(/## (.*)/g,'<h2>$1</h2>').replace(/# (.*)/g,'<h1>$1</h1>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>').replace(/\*(.*?)\*/g,'<em>$1</em>').replace(/- (.*)/g,'<li>$1</li>').replace(/\n\n/g,'<p>').replace(/\n/g,'<br>');
    explainModal.classList.remove("hidden");
}

// Pages
function savePageState(){
    if(state.currentPageIndex<0||state.currentPageIndex>=state.pages.length) return;
    state.pages[state.currentPageIndex].elements=JSON.parse(JSON.stringify(state.elements));
}
function loadPageElements(idx){
    const p=state.pages[idx];
    state.elements=p?p.elements.map(normalize):[];
}
function switchPage(idx){
    if(idx<0||idx>=state.pages.length||idx===state.currentPageIndex) return;
    savePageState();
    state.currentPageIndex=idx;
    loadPageElements(idx);
    state.undoStack=[];state.redoStack=[];state.selectedIds=[];
    resetZ();persist();renderPageNav();render();
}
function addPage(){
    const p={id:id("page"),name:`Page ${state.pages.length+1}`,elements:[]};
    state.pages.push(p);
    switchPage(state.pages.length-1);
}
function renderPageNav(){
    document.getElementById("page-indicator").textContent=`${state.currentPageIndex+1}/${state.pages.length}`;
    document.getElementById("btn-page-prev").disabled=state.currentPageIndex===0;
    document.getElementById("btn-page-next").disabled=state.currentPageIndex===state.pages.length-1;
}
function prevPage(){switchPage(state.currentPageIndex-1);}
function nextPage(){switchPage(state.currentPageIndex+1);}

// Tool setter
function setTool(tool){
    state.tool=tool;
    document.querySelectorAll(".tool-btn").forEach(b=>b.classList.toggle("active",b.dataset.tool===tool));
    board.dataset.tool=tool;
    const showOpts=tool==="pencil"||tool==="marker";
    document.getElementById("tool-options").classList.toggle("hidden",!showOpts);
    if(tool!=="select"){state.selectedIds=[];render();}
}

// Events
function setup(){
    board.addEventListener("pointerdown",pd);
    board.addEventListener("pointermove",pm);
    window.addEventListener("pointerup",pu);

    board.addEventListener("wheel",e=>{e.preventDefault();zoom(e.deltaY<0?1.08:0.92,e);},{passive:false});

    document.getElementById("btn-zoom-in").addEventListener("click",()=>zoom(1.15));
    document.getElementById("btn-zoom-out").addEventListener("click",()=>zoom(0.85));
    document.getElementById("btn-zoom-reset").addEventListener("click",resetZ);
    document.getElementById("btn-zoom-fit").addEventListener("click",zoomFit);
    document.getElementById("btn-undo").addEventListener("click",undo);
    document.getElementById("btn-redo").addEventListener("click",redo);
    document.getElementById("btn-export").addEventListener("click",e=>{e.stopPropagation();exportMenu.classList.toggle("hidden");});

    document.querySelectorAll(".menu-item").forEach(item=>{
        item.addEventListener("click",()=>{
            const a=item.dataset.action;exportMenu.classList.add("hidden");
            if(a==="json-export")download(JSON.stringify(state.elements,null,2),"board.json","application/json");
            if(a==="json-import")document.getElementById("import-input").click();
            if(a==="svg-export")download(getSVG(),"board.svg","image/svg+xml");
            if(a==="png-export")exportPNG();
        });
    });
    document.getElementById("import-input").addEventListener("change",e=>{
        const f=e.target.files[0];if(!f)return;
        const r=new FileReader();
        r.onload=ev=>{try{const p=JSON.parse(ev.target.result);if(Array.isArray(p)){exec(new CmdCreate(p.map(normalize)));zoomFit();}else throw new Error("Invalid format");}catch(err){msg(`Import failed: ${err.message}`);}};
        r.readAsText(f);
    });

    document.querySelectorAll(".tool-btn").forEach(b=>{if(b.dataset.tool)b.addEventListener("click",()=>setTool(b.dataset.tool));});

    // Tool options panel (pen/marker)
    const toolOpts=document.getElementById("tool-options");
    const toolColorInput=document.getElementById("tool-stroke-color");
    const toolPresets=document.getElementById("tool-stroke-presets");
    function renderToolPresets(){
        toolPresets.replaceChildren();
        COLORS.stroke.forEach(c=>{
            const ch=document.createElement("div");ch.className="color-chip";
            ch.style.background=c;
            if(c===state.penOptions.stroke)ch.classList.add("active");
            ch.addEventListener("click",()=>{
                state.penOptions.stroke=c;
                toolColorInput.value=c;
                document.querySelectorAll("#tool-stroke-presets .color-chip").forEach(x=>x.classList.remove("active"));
                ch.classList.add("active");
            });
            toolPresets.appendChild(ch);
        });
    }
    renderToolPresets();
    toolColorInput.value=state.penOptions.stroke;
    toolColorInput.addEventListener("input",e=>{state.penOptions.stroke=e.target.value;});
    const widthSlider=document.getElementById("tool-stroke-width");
    const widthLabel=document.getElementById("tool-stroke-width-label");
    widthSlider.value=state.penOptions.strokeWidth;
    widthLabel.textContent=state.penOptions.strokeWidth+"px";
    widthSlider.addEventListener("input",e=>{
        state.penOptions.strokeWidth=Number(e.target.value);
        widthLabel.textContent=e.target.value+"px";
    });
    document.querySelectorAll(".style-opt").forEach(b=>{
        b.classList.toggle("active",b.dataset.value===state.penOptions.strokeStyle);
        b.addEventListener("click",()=>{
            state.penOptions.strokeStyle=b.dataset.value;
            document.querySelectorAll(".style-opt").forEach(x=>x.classList.remove("active"));
            b.classList.add("active");
        });
    });

    // Page nav
    document.getElementById("btn-page-prev").addEventListener("click",prevPage);
    document.getElementById("btn-page-next").addEventListener("click",nextPage);
    document.getElementById("btn-new-page").addEventListener("click",addPage);

    // Text editing
    nodesLayer.addEventListener("dblclick",e=>{const t=e.target.closest(".node-text");if(t){e.stopPropagation();beginEdit(t);}});
    nodesLayer.addEventListener("input",e=>{const t=e.target.closest(".node-text");if(t){const el=gel(t.dataset.id);if(el)el.text=t.textContent;}});
    nodesLayer.addEventListener("blur",e=>{const t=e.target.closest(".node-text");if(t)commitText(t);},true);

    // Properties
    document.getElementById("stroke-color-input").addEventListener("input",e=>{if(state.selectedIds.length)exec(new CmdUpdate(state.selectedIds,{stroke:e.target.value}));});
    document.getElementById("fill-color-input").addEventListener("input",e=>{if(state.selectedIds.length)exec(new CmdUpdate(state.selectedIds,{color:e.target.value}));});
    document.getElementById("fill-none").addEventListener("click",()=>{if(state.selectedIds.length)exec(new CmdUpdate(state.selectedIds,{color:"transparent"}));});
    document.getElementById("font-select").addEventListener("change",e=>{if(state.selectedIds.length)exec(new CmdUpdate(state.selectedIds,{fontFamily:e.target.value}));});
    document.getElementById("rotation-slider").addEventListener("input",e=>{const v=Number(e.target.value);document.getElementById("rotation-label").textContent=v+"°";if(state.selectedIds.length===1)exec(new CmdUpdate(state.selectedIds,{rotation:v}));});
    document.querySelectorAll(".stroke-chip").forEach(b=>b.addEventListener("click",()=>{if(state.selectedIds.length)exec(new CmdUpdate(state.selectedIds,{strokeWidth:Number(b.dataset.value)}));}));
    document.querySelectorAll(".style-chip").forEach(b=>b.addEventListener("click",()=>{if(state.selectedIds.length)exec(new CmdUpdate(state.selectedIds,{strokeStyle:b.dataset.value}));}));
    document.getElementById("btn-front").addEventListener("click",()=>{if(state.selectedIds.length)exec(new CmdReorder(state.selectedIds,'front'));});
    document.getElementById("btn-back").addEventListener("click",()=>{if(state.selectedIds.length)exec(new CmdReorder(state.selectedIds,'back'));});
    document.getElementById("btn-duplicate").addEventListener("click",()=>{copySel();pasteSel();});
    document.getElementById("btn-delete").addEventListener("click",()=>{if(state.selectedIds.length){const ts=state.selectedIds.map(id=>gel(id)).filter(Boolean);exec(new CmdDelete(ts));}});

    // Settings
    document.getElementById("btn-settings").addEventListener("click",()=>settingsModal.classList.remove("hidden"));
    document.getElementById("btn-close-settings").addEventListener("click",()=>settingsModal.classList.add("hidden"));
    document.getElementById("btn-settings-save").addEventListener("click",()=>{saveSettings();settingsModal.classList.add("hidden");});
    document.getElementById("ai-provider-select").addEventListener("change",()=>{state.settings.aiProvider=document.getElementById("ai-provider-select").value;updateAIHint();});

    // AI
    const aiToggle=document.getElementById("btn-ai-toggle");
    aiToggle.addEventListener("click",e=>{e.stopPropagation();aiActions.classList.toggle("hidden");});
    document.addEventListener("click",()=>aiActions.classList.add("hidden"));

    let aiAction=null;
    document.querySelectorAll(".ai-btn").forEach(b=>{
        b.addEventListener("click",()=>{
            const a=b.dataset.action;aiActions.classList.add("hidden");
            if(a==="cluster"){aiCluster().catch(e=>msg(e.message));return;}
            if(a==="explain"){aiExplain().catch(e=>msg(e.message));return;}
            if(a==="suggest"){aiSuggest().catch(e=>msg(e.message));return;}
            aiAction=a;
            document.getElementById("modal-title").textContent=a==="diagram"?"Flowchart Generator":"Mindmap Generator";
            document.getElementById("ai-input").placeholder=a==="diagram"?"Describe the process...":"Enter a topic...";
            aiModal.classList.remove("hidden");
        });
    });
    document.querySelectorAll("#ai-modal .modal-close, #btn-ai-cancel").forEach(b=>b.addEventListener("click",()=>aiModal.classList.add("hidden")));
    document.getElementById("btn-ai-submit").addEventListener("click",async()=>{
        const prompt=document.getElementById("ai-input").value.trim();if(!prompt)return;
        const loading=document.getElementById("ai-loading"),submit=document.getElementById("btn-ai-submit");
        loading.classList.remove("hidden");submit.disabled=true;
        if(state.settings.aiProvider!=="builtin"&&location.protocol==="file:"){msg("API calls blocked from file:// protocol — open via a local server (e.g. 'npx serve .' or VSCode Live Server) or switch AI to Built-in mode in Settings");loading.classList.add("hidden");submit.disabled=false;return;}
        try{if(aiAction==="diagram")await aiDiagram(prompt);else await aiMindmap(prompt);}catch(e){msg(e.message);}
        loading.classList.add("hidden");submit.disabled=false;aiModal.classList.add("hidden");document.getElementById("ai-input").value="";
    });
    document.querySelectorAll("#explain-modal .modal-close, #btn-close-explain, #btn-close-explain-ok").forEach(b=>b.addEventListener("click",()=>explainModal.classList.add("hidden")));
    document.getElementById("btn-close-suggestion").addEventListener("click",()=>suggestionPanel.classList.add("hidden"));

    // Keyboard
    window.addEventListener("keydown",e=>{
        if(document.activeElement?.getAttribute("contenteditable")==="true"||["TEXTAREA","INPUT"].includes(document.activeElement?.tagName))return;
        const k=e.key.toLowerCase();
        if(k==="v")setTool("select");if(k==="h")setTool("hand");if(k==="p")setTool("pencil");if(k==="m")setTool("marker");if(k==="l")setTool("laser");if(k==="e")setTool("eraser");if(k==="r")setTool("rect");if(k==="o")setTool("ellipse");if(k==="t")setTool("text");if(k==="s")setTool("sticky");if(k==="d")setTool("diamond");if(k==="a")setTool("arrow");
        if(e.key==="Delete"||e.key==="Backspace"){if(state.selectedIds.length){const ts=state.selectedIds.map(id=>gel(id)).filter(Boolean);exec(new CmdDelete(ts));}}
        if(e.ctrlKey||e.metaKey){
            if(k==="z"){e.preventDefault();undo();}
            if(k==="y"){e.preventDefault();redo();}
            if(k==="c"){e.preventDefault();copySel();}
            if(k==="v"){e.preventDefault();pasteSel();}
            if(k==="d"){e.preventDefault();copySel();pasteSel();}
            if(e.key==="="||e.key==="+"){e.preventDefault();zoom(1.15);}
            if(e.key==="-"){e.preventDefault();zoom(0.85);}
        }
        if(e.shiftKey&&e.key==="1"){e.preventDefault();zoomFit();}
        if((e.ctrlKey||e.metaKey)&&e.key==="n"){e.preventDefault();addPage();}
        if(e.key==="Escape"){state.selectedIds=[];setTool("select");settingsModal.classList.add("hidden");aiModal.classList.add("hidden");explainModal.classList.add("hidden");exportMenu.classList.add("hidden");suggestionPanel.classList.add("hidden");render();}
    });

    // Touch pinch zoom
    let ts=null;
    board.addEventListener("touchstart",e=>{
        if(e.touches.length===2){e.preventDefault();const t1=e.touches[0],t2=e.touches[1];ts={d:Math.hypot(t2.clientX-t1.clientX,t2.clientY-t1.clientY),mx:(t1.clientX+t2.clientX)/2,my:(t1.clientY+t2.clientY)/2,px:state.panX,py:state.panY,zoom:state.zoom};}
        else if(e.touches.length===1&&state.tool==="hand"){e.preventDefault();const t=e.touches[0];ts={single:true,sx:t.clientX,sy:t.clientY,px:state.panX,py:state.panY};}
    },{passive:false});
    board.addEventListener("touchmove",e=>{
        if(!ts)return;
        if(e.touches.length===2&&ts.d!==undefined){e.preventDefault();const t1=e.touches[0],t2=e.touches[1];const nd=Math.hypot(t2.clientX-t1.clientX,t2.clientY-t1.clientY);const r=board.getBoundingClientRect();const cx=ts.mx-r.left,cy=ts.my-r.top;const nz=Math.min(5,Math.max(0.05,ts.zoom*nd/ts.d));const zf=nz/ts.zoom;state.panX=cx-zf*(cx-ts.px)+(t1.clientX+t2.clientX)/2-ts.mx;state.panY=cy-zf*(cy-ts.py)+(t1.clientY+t2.clientY)/2-ts.my;state.zoom=nz;applyVp();zoomText.textContent=`${Math.round(nz*100)}%`;}
        else if(e.touches.length===1&&ts.single){e.preventDefault();const t=e.touches[0];state.panX=ts.px+(t.clientX-ts.sx);state.panY=ts.py+(t.clientY-ts.sy);applyVp();}
    },{passive:false});
    board.addEventListener("touchend",()=>{ts=null;});
}

function init(){
    loadSettings();
    setup();
    loadLocal();
    renderPageNav();
    setTool("select");
}

if(document.readyState==="loading")window.addEventListener("DOMContentLoaded",init);else init();
