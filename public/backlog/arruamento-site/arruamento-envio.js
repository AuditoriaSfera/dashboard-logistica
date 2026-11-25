(function(){
'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=v=>Number(v)||0, fmt=v=>Number(v).toLocaleString('pt-BR'), pct=v=>v==null?'—':(v*100).toLocaleString('pt-BR',{maximumFractionDigits:1})+'%';
const stamp=v=>v?new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'—';
function makeModel(o){
 const [year,cycle]=String(o.cycle).split('-').map(Number), period=o.getCycle(year,cycle), snapshot=o.snapshots.get(`${year}-${cycle}|${o.store}`);
 const fail=message=>({ok:false,message});
 if(!o.store||!period)return fail('Selecione a loja e o ciclo.');
 if(o.issues.has(`${year}-${cycle}|${o.store}`))return fail('Erro no cruzamento. Reimporte as planilhas desta loja e ciclo.');
 if(!snapshot||!o.validSnapshot(snapshot))return fail('Aguardando importação das planilhas de Arruamento e Curva ABC desta loja e ciclo.');
 if(String(snapshot.code)!==String(o.store)||Number(snapshot.year)!==year||Number(snapshot.cycle)!==cycle)return fail('Erro no cruzamento: loja ou ciclo incompatível.');
 const seen=new Set();for(const r of snapshot.rows){const key=o.skuKey(r.sku);if(!key||seen.has(key))return fail('Erro no cruzamento: SKUs repetidos ou inválidos. Reimporte as planilhas.');seen.add(key)}
 const base=snapshot.rows, rows=base.filter(r=>!r.arruado&&(!o.onlyStock||num(r.stock)>0)).sort((a,b)=>('ABC'.indexOf(a.curve)-'ABC'.indexOf(b.curve))||num(b.stock)-num(a.stock)||String(a.sku).localeCompare(String(b.sku)));
 const stats=o.stats(base), curves=['A','B','C'].map(curve=>{const all=base.filter(r=>r.curve===curve);return {curve,...o.stats(all),pending:rows.filter(r=>r.curve===curve).length}});
 return {ok:true,snapshot,rows,stats,curves,onlyStock:!!o.onlyStock,stock:rows.reduce((s,r)=>s+Math.max(0,num(r.stock)),0),withStock:rows.filter(r=>num(r.stock)>0).length,incomplete:rows.filter(r=>r.partial).length};
}
function buildWorkbook(X,m){
 if(!m.ok)throw Error(m.message);const s=m.snapshot, scope=m.onlyStock?'Somente pendências com estoque positivo':'Todas as pendências', wb=X.utils.book_new();
 const summary=[['Portal de Pedidos Sfera — Arruamento'],['Loja',`${s.code} - ${s.store}`],['Ciclo',`${s.cycle}/${s.year}`],['Período',`${s.periodStart} a ${s.periodEnd}`],['Importado em',stamp(s.importedAt)],['Seleção',scope],[],['Indicador','Valor'],['SKUs da Curva ABC',m.stats.total],['SKUs arruados',m.stats.arr],['Cobertura de arruamento',m.stats.coverage],['SKUs não arruados na base',m.stats.missing],['Pendências exportadas',m.rows.length],['Pendências com estoque positivo',m.withStock],['Unidades de estoque positivo pendente',m.stock],['Endereços incompletos na seleção',m.incomplete],[],['Curva','SKUs na base','Arruados','Cobertura','Pendências na seleção'],...m.curves.map(c=>[c.curve,c.total,c.arr,c.coverage,c.pending]),[],['Arquivo de arruamento',s.sources?.route||''],['Arquivo de Curva ABC',s.sources?.abc||'']];
 const ws=X.utils.aoa_to_sheet(summary);ws['!cols']=[{wch:43},{wch:56},{wch:18},{wch:18},{wch:28}];if(ws.B11)ws.B11.z='0.0%';for(let i=19;i<=21;i++){if(ws['D'+i])ws['D'+i].z='0.0%'}X.utils.book_append_sheet(wb,ws,'Resumo');
 const header=['PDV','Loja','Ano','Ciclo','SKU','Produto','Categoria','Curva ABC','Estoque','Quantidade vendida','Situação','Endereços cadastrados','Encontrado no arruamento'];
 const data=[header,...m.rows.map(r=>[String(s.code),s.store,Number(s.year),Number(s.cycle),String(r.sku),r.desc||'',r.category||'',r.curve||'',num(r.stock),num(r.qty),r.partial?'Endereço incompleto':'Não arruado',(r.locations||[]).join(' | '),r.matched?'Sim':'Não'])];
 const detail=X.utils.aoa_to_sheet(data);detail['!cols']=[10,25,8,8,20,58,25,12,16,21,24,60,28].map(wch=>({wch}));detail['!autofilter']={ref:X.utils.encode_range({r:0,c:0},{r:data.length-1,c:header.length-1})};for(let i=2;i<=data.length;i++){detail['A'+i].z='@';detail['E'+i].z='@'}X.utils.book_append_sheet(wb,detail,'Não arruados');return wb;
}
function drawCanvas(canvas,m){
 const s=m.snapshot, ctx=canvas.getContext('2d');canvas.width=1600;canvas.height=1080;const text=(v,x,y,size=22,color='#233c51')=>{ctx.fillStyle=color;ctx.font=`${size}px Arial`;ctx.fillText(String(v),x,y)};const rect=(x,y,w,h,color)=>{ctx.fillStyle=color;ctx.fillRect(x,y,w,h)};
 rect(0,0,1600,1080,'#f4f7fb');rect(0,0,1600,160,'#152e42');text('Sfera | Arruamento',48,54,32,'#fff');text(`${s.code} - ${s.store}`,48,100,30,'#fff');text(`Ciclo ${s.cycle}/${s.year}  |  ${s.periodStart} a ${s.periodEnd}`,48,137,21,'#c8dae9');
 const cards=[['SKUs analisados',fmt(m.stats.total)],['Cobertura de arruamento',pct(m.stats.coverage)],['Pendências na seleção',fmt(m.rows.length)],['Pendências com estoque',fmt(m.withStock)],['Estoque positivo pendente',fmt(m.stock)],['Endereços incompletos',fmt(m.incomplete)]];
 cards.forEach(([label,value],i)=>{const x=48+(i%3)*508,y=188+Math.floor(i/3)*125;rect(x,y,488,108,'#fff');text(label,x+20,y+31,21);text(value,x+20,y+82,37,'#148dcc')});
 text(m.onlyStock?'Seleção: pendências com estoque positivo':'Seleção: todas as pendências',48,469,21);
 m.curves.forEach((c,i)=>{const x=48+i*508;text(`Curva ${c.curve} — cobertura ${pct(c.coverage)}`,x,515,24);rect(x,534,460,12,'#dae4ee');rect(x,534,460*(c.coverage||0),12,'#148dcc');text(`${fmt(c.pending)} pendências na seleção`,x,575,20)});
 text('Prioridades para arruar',48,629,28);rect(48,650,1504,40,'#e6eef6');['SKU','Produto','Curva','Estoque','Situação'].forEach((v,i)=>text(v,[62,260,1030,1150,1280][i],678,19));
 m.rows.slice(0,7).forEach((r,i)=>{const y=721+i*39;rect(48,y-24,1504,38,i%2?'#edf3f8':'#fff');text(r.sku,62,y,19);let description=String(r.desc||'');while(ctx.measureText(description).width>730)description=description.slice(0,-2);text(description,260,y,19);text(r.curve,1030,y,19);text(fmt(num(r.stock)),1150,y,19);text(r.partial?'Incompleto':'Não arruado',1280,y,19)});
 if(!m.rows.length)text('Nenhuma pendência nesta seleção.',62,730,24);
 text(`Planilha: ${fmt(m.rows.length)} itens completos. Imagem: até 7 prioridades.`,48,1034,19);text(`Importado em ${stamp(s.importedAt)}`,48,1066,18);return canvas;
}
function create(o){
 const $=o.$;let activeModel;
 const model=()=>makeModel({...o,store:$('shareStore').value,cycle:$('shareCycle').value,onlyStock:$('shareOnlyStock').checked,snapshots:o.getSnapshots(),issues:o.getIssues()});
 const filename=m=>`Pendencias_Arruamento_${m.snapshot.code}_C${m.snapshot.cycle}_${m.snapshot.year}${m.onlyStock?'_com_saldo':''}`;
 function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000)}
 function excel(m){try{if(!m.ok||!m.rows.length)return;const X=o.getReader();download(new Blob([X.write(buildWorkbook(X,m),{bookType:'xlsx',type:'array',compression:true})],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),filename(m)+'.xlsx')}catch(e){$('shareStatus').textContent='Não foi possível gerar a planilha: '+e.message}}
 function render(){
  const previousStore=$('shareStore').value,previousCycle=$('shareCycle').value,selected=o.getSelected();const directory=o.getDirectory();$('shareStore').innerHTML='<option value="">Selecione a loja</option>'+directory.map(s=>`<option value="${esc(s.code)}">${esc(s.code)} - ${esc(s.store)}</option>`).join('');$('shareStore').value=previousStore||selected.store||'';
  const cycles=new Map();for(let year=2026;year<=2026;year++)for(let cycle=1;cycle<=17;cycle++)if(o.getCycle(year,cycle))cycles.set(`${year}-${cycle}`,`Ciclo ${cycle}/${year}`);for(const s of o.getSnapshots().values())cycles.set(`${s.year}-${s.cycle}`,`Ciclo ${s.cycle}/${s.year}`);$('shareCycle').innerHTML='<option value="">Selecione o ciclo</option>'+[...cycles].map(([v,l])=>`<option value="${v}">${l}</option>`).join('');$('shareCycle').value=previousCycle||selected.cycle||'';
  const m=model();$('shareExcel').disabled=!m.ok||!m.rows.length;$('sharePresent').disabled=!m.ok;$('shareDashboard').hidden=!m.ok;$('shareStatus').textContent=m.ok?`${m.snapshot.code} - ${m.snapshot.store} · Ciclo ${m.snapshot.cycle}/${m.snapshot.year} · Importado em ${stamp(m.snapshot.importedAt)}`:m.message;if(!m.ok)return;
  const cards=[['SKUs analisados',fmt(m.stats.total)],['Cobertura',pct(m.stats.coverage)],['Pendências na seleção',fmt(m.rows.length)],['Pendências com estoque',fmt(m.withStock)],['Estoque positivo pendente',fmt(m.stock)],['Endereços incompletos',fmt(m.incomplete)]];$('shareKpis').innerHTML=cards.map(([l,v])=>`<div class="kpi"><div class="kpi-label">${l}</div><strong class="kpi-number">${v}</strong></div>`).join('');
  $('shareCurves').innerHTML=m.curves.map(c=>`<div class="small-card"><span>Curva ${c.curve}</span><strong>${pct(c.coverage)}</strong><span>${fmt(c.arr)} de ${fmt(c.total)} arruados · ${fmt(c.pending)} pendências na seleção</span></div>`).join('');
  $('shareRows').innerHTML=m.rows.slice(0,20).map(r=>`<tr><td>${esc(r.sku)}</td><td>${esc(r.desc)}</td><td>${esc(r.curve)}</td><td class="right">${fmt(num(r.stock))}</td><td>${r.partial?'Endereço incompleto':'Não arruado'}</td><td>${esc((r.locations||[]).join(' | '))}</td></tr>`).join('')||'<tr><td colspan="6">Nenhuma pendência nesta seleção.</td></tr>';$('shareCount').textContent=`${fmt(m.rows.length)} itens na planilha · Prévia de até 20 itens`;
 }
 for(const id of ['shareStore','shareCycle','shareOnlyStock'])$(id).addEventListener('change',render);
 $('shareExcel').addEventListener('click',()=>excel(model()));$('sharePresent').addEventListener('click',()=>{activeModel=model();if(!activeModel.ok)return;drawCanvas($('shareCanvas'),activeModel);$('shareDialog').showModal()});$('shareClose').addEventListener('click',()=>$('shareDialog').close());$('sharePng').addEventListener('click',()=>$('shareCanvas').toBlob(blob=>{if(blob)download(blob,filename(activeModel)+'.png')},'image/png'));
 return {render,model};
}
window.SferaArruamentoShare={create,makeModel,buildWorkbook,drawCanvas};
})();
