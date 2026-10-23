import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../server/workspace.mjs';

const settings = { roles: [{ name: 'Implement', count: 1 }] };
const valid = () => ({
  summary: 'deterministic validation',
  successCriteria: ['scripts pass'],
  verificationCommands: ['node --test'],
  tasks: [{ id: 'job', title: 'Job', role: 'Implement', instructions: 'change source',
    dependsOn: [], ownedPaths: ['src/job.mjs'], acceptance: ['check source'] }]
});

function invalid(mutator) {
  const plan = valid();
  mutator(plan);
  assert.throws(() => validatePlan(plan, settings), err => err?.code === 'INVALID_PLAN_SHAPE');
}

test('valid structured plan remains accepted', () => {
  assert.equal(validatePlan(valid(), settings).tasks.length, 1);
});
test('success criteria string is not an array', () => {
  invalid(plan => { plan.successCriteria = 'checks pass'; });
});
test('verification command string must not be spread into individual characters', () => {
  invalid(plan => { plan.verificationCommands = 'node --test'; });
});
test('task acceptance string cannot stand in for an array', () => {
  invalid(plan => { plan.tasks[0].acceptance = 'looks good'; });
});
test('dependency string cannot stand in for a list of task IDs', () => {
  invalid(plan => { plan.tasks[0].dependsOn = ''; });
});
test('original empty criteria guard still rejects missing acceptance', () => {
  const plan = valid();
  plan.tasks[0].acceptance = [];
  assert.throws(() => validatePlan(plan, settings), err => err?.code === 'MISSING_ACCEPTANCE');
});
