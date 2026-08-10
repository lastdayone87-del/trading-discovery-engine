import assert from 'node:assert/strict'; import test from 'node:test';
import { authenticate, routePolicyInventory, validateOperatorConfiguration } from './operatorAuth';

test('maps admin, operator, and transitional reviewer credentials without exposing tokens',()=>{
 const env={ADMIN_API_TOKEN:'a',ADMIN_IDENTITY:'root',OPERATOR_API_TOKEN:'o',OPERATOR_IDENTITY:'ops',REVIEW_API_TOKEN:'r',DEFAULT_REVIEWER_IDENTITY:'review'};
 assert.deepEqual(authenticate('a',env),{actorId:'root',actorHash:authenticate('a',env)?.actorHash,role:'admin'});
 assert.equal(authenticate('o',env)?.role,'operator'); assert.equal(authenticate('r',env)?.actorId,'review'); assert.equal(authenticate('bad',env),undefined);
 assert.ok(!JSON.stringify(authenticate('a',env)).includes('"a"'));
});
test('production fails closed and can never enable the development bypass',()=>{
 assert.throws(()=>validateOperatorConfiguration({NODE_ENV:'production'}),/required/);
 assert.throws(()=>validateOperatorConfiguration({NODE_ENV:'production',OPERATOR_AUTH_BYPASS:'true',OPERATOR_API_TOKEN:'o',ADMIN_API_TOKEN:'a'}),/forbidden/);
 assert.doesNotThrow(()=>validateOperatorConfiguration({NODE_ENV:'production',OPERATOR_API_TOKEN:'o',ADMIN_API_TOKEN:'a'}));
});
test('route inventory is explicit and public surface contains only health',()=>{
 assert.deepEqual(routePolicyInventory.filter(x=>x.policy==='public').map(x=>x.pattern),['^\\/api\\/health$']);
});
test('governed review reason catalog is authorized for authenticated operators',()=>{
 const matchingRoutes=routePolicyInventory.filter(item=>item.method==='GET'&&new RegExp(item.pattern).test('/api/review-reasons'));
 assert.equal(matchingRoutes.length,1,'/api/review-reasons must resolve to exactly one explicit route policy');
 const route=matchingRoutes[0];
 assert.equal(route.policy,'operator');
 assert.equal(route.action,'administration.read');
});
