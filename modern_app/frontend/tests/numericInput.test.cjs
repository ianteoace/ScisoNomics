const assert=require('node:assert/strict'),fs=require('node:fs'),ts=require('typescript'),{test}=require('node:test');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,file);
const {formatNumericInput:format,parseLocalizedNumber:parse,numericCaret}=require('../lib/numericInput.ts');
test('numeric display groups thousands and preserves decimal drafts without rounding',()=>{
  for(const [raw,expected] of [['1','1'],['10','10'],['100','100'],['1000','1.000'],['10000','10.000'],['1000000','1.000.000'],['1234,5','1.234,5'],['1234,56','1.234,56'],['0,','0,'],['1234,567890','1.234,567890'],['',''],['-50,00','-50,00']])assert.equal(format(raw),expected);
  assert.equal(format(1234.567),'1.234,567');
  assert.equal(format(1e-7),'0,0000001');assert.equal(format(1e21),'1.000.000.000.000.000.000.000');
  assert.equal(format('1e-7'),'0,0000001');assert.equal(parse('1e-7'),1e-7);
});
test('paste accepts Spanish and unambiguous international decimals; models receive numbers only',()=>{
  for(const raw of ['1234.56','1.234,56','1,234.56']){assert.equal(format(raw),'1.234,56');assert.equal(parse(raw),1234.56);}
  assert.equal(parse('1.000.000'),1000000);assert.equal(parse('0,'),0);
  for(const raw of ['', '-', '.', 'abc','10oops'])assert(Number.isNaN(parse(raw)));
});
test('editing grouping grows and deletes without treating grouping as decimal',()=>{
  assert.equal(format('1.0000',true),'10.000');assert.equal(format('1.00',true),'100');
  assert.equal(format('1.',true),'1');assert.equal(format('',true),'');
  assert.equal(format('1.0200,50',true),'10.200,50');
  assert.equal(numericCaret('1.0200,50','10.200,50',4),4);
});
