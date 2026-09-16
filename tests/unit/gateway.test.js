import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateUsageCharge, extractOpenAICompatibleOutput, extractOpenAICompatibleUsage, validateConnectorBaseUrl } from '../../src/services/gateway.js';

test('usage charge uses exact integer microE and rounds each priced component up',()=>{
  assert.equal(calculateUsageCharge({inputTokens:10,outputTokens:5,inputRateMicroEPerMillion:'1000000',outputRateMicroEPerMillion:'2000000'}),20n);
  assert.equal(calculateUsageCharge({inputTokens:1,outputTokens:1,inputRateMicroEPerMillion:'1',outputRateMicroEPerMillion:'1'}),2n);
  assert.equal(calculateUsageCharge({inputTokens:0,outputTokens:0,inputRateMicroEPerMillion:'999',outputRateMicroEPerMillion:'999'}),0n);
});

test('connector URLs enforce transport boundary without embedding credentials',()=>{
  assert.equal(validateConnectorBaseUrl('http://127.0.0.1:11434','LOCAL_SELF_HOSTED'),'http://127.0.0.1:11434/');
  assert.equal(validateConnectorBaseUrl('https://models.example.test/api','CLOUD'),'https://models.example.test/api/');
  assert.throws(()=>validateConnectorBaseUrl('http://models.example.test','CLOUD'),e=>e.code==='INVALID_CONNECTOR_URL');
  assert.throws(()=>validateConnectorBaseUrl('https://user:secret@models.example.test','CLOUD'),e=>e.code==='INVALID_CONNECTOR_URL');
});

test('OpenAI-compatible response parsing accepts both prompt/completion and input/output usage names',()=>{
  assert.deepEqual(extractOpenAICompatibleUsage({usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}),{inputTokens:4,outputTokens:3,totalTokens:7,rawUsage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}});
  assert.deepEqual(extractOpenAICompatibleUsage({usage:{input_tokens:2,output_tokens:5}}),{inputTokens:2,outputTokens:5,totalTokens:7,rawUsage:{input_tokens:2,output_tokens:5}});
  assert.equal(extractOpenAICompatibleOutput({choices:[{message:{content:'hello'}}]}),'hello');
  assert.throws(()=>extractOpenAICompatibleUsage({usage:{}}),e=>e.code==='USAGE_UNAVAILABLE');
});
