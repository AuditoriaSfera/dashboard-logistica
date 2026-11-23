import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeBacklog, validateBacklog } from '../server/backlog.mjs';

const row = (id,channel,delivery='No endereço de entrega') => ({id,channel,delivery,status:'Aprovado',fiscal:'Não faturado',date:'2026-11-23'});
const base = {name:'teste.xlsx',version:'v1',importedAt:'2026-11-23T12:00:00Z',rows:[row('1','20740 - Madureira'),row('2','20740 - Madureira','Retirada na Central'),row('3','19826 - Partage'),row('4','23433 - Caratinga'),row('5','99999 - Madureira')],history:[{importedAt:'2026-11-22T12:00:00Z',byStore:{20740:3,19826:10}},{importedAt:'2026-11-23T12:00:00Z',byStore:{20740:2,19826:1,23433:1,99999:1}}]};
test('backlog scopes delivery, pickup and historical counts to account stores on the server',()=>{
  const scoped=scopeBacklog(base,{accountType:'unit',stores:['MADUREIRA']});
  assert.deepEqual(scoped.rows.map(row=>row.id),['1','2']);
  assert.deepEqual(scoped.countHistory.map(item=>item.total),[3,2]);
  assert.deepEqual(Object.keys(scoped.stores),['20740']);
  assert.equal(scoped.canImport,false);
  assert.equal(JSON.stringify(scoped).includes('Partage'),false);
});
test('a channel name cannot grant access through an unknown code and no assigned store fails closed',()=>{
  assert.deepEqual(scopeBacklog(base,{accountType:'unit',stores:[]}).rows,[]);
  assert.deepEqual(scopeBacklog(base,{accountType:'unit',stores:['Unknown']}).rows,[]);
  assert.equal(scopeBacklog(base,{accountType:'unit',stores:['Madureira']}).rows.some(row=>row.id==='5'),false);
});
test('multiple account stores and historical Caratinga codes remain scoped correctly',()=>{
  const scoped=scopeBacklog(base,{accountType:'unit',stores:['Partage','Caratinga']});
  assert.deepEqual(scoped.rows.map(row=>row.id),['3','4']);
  assert.equal(scoped.countHistory.at(-1).total,2);
});
test('administrators can view the complete last import and all store totals',()=>{
  const scoped=scopeBacklog(base,{accountType:'admin',stores:[]});
  assert.equal(scoped.rows.length,5);assert.equal(scoped.canImport,true);assert.equal(scoped.countHistory.at(-1).total,5);
});
test('backlog validation rejects invalid imports and strips extra fields from persisted rows',()=>{
  assert.throws(()=>validateBacklog({rows:[]}));
  assert.throws(()=>validateBacklog({rows:[row('1','20740 - Madureira'),row('1','19826 - Partage')]}));
  assert.throws(()=>validateBacklog({rows:[row('1','Madureira')]}));
  const validated=validateBacklog({name:'test.xlsx',rows:[{...row('1','20740 - Madureira'),privateField:'discard'}]});
  assert.equal(Object.hasOwn(validated.rows[0],'privateField'),false);
});
