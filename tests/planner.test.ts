import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlan, planMinutes, fitsWindow, sortByUrgency, splitIntoBlocks, schedule, locate,
  replan, remainingFor, blockEndMs, formatClock, formatDuration,
} from '../lib/planner.ts';
import type { PlanTask } from '../lib/planner.ts';

const mk = (id: string, remaining: number, priority: PlanTask['priority'], deadline: string | null = null, createdAt = '2026-10-01'): PlanTask =>
  ({ id, remaining, priority, deadline, createdAt });

const A = mk('A', 120, 'high');
const B = mk('B', 45, 'medium');
const C = mk('C', 20, 'low');

test('split: last block is shorter when not multiple of 30', () => {
  assert.deepEqual(splitIntoBlocks(120), [30, 30, 30, 30]);
  assert.deepEqual(splitIntoBlocks(45), [30, 15]);
  assert.deepEqual(splitIntoBlocks(20), [20]);
  assert.deepEqual(splitIntoBlocks(5), [5]);
});

test('spec example: order A1 B1 C1 A2 B2 A3 A4, 215 minutes', () => {
  const plan = buildPlan([C, B, A]);
  const work = plan.filter((b) => b.kind === 'work');
  assert.deepEqual(work.map((b) => b.taskId), ['A', 'B', 'C', 'A', 'B', 'A', 'A']);
  assert.deepEqual(work.map((b) => b.minutes), [30, 30, 20, 30, 15, 30, 30]);
  assert.equal(plan.filter((b) => b.kind === 'break').length, 6);
  assert.equal(planMinutes(plan), 215);
  assert.equal(fitsWindow(plan, 180), false);
  assert.equal(fitsWindow(plan, 240), true);
});

test('spec example: without B plan takes 160 minutes', () => {
  const plan = buildPlan([A, C]);
  assert.equal(plan.filter((b) => b.kind === 'work').length, 5);
  assert.equal(plan.filter((b) => b.kind === 'break').length, 4);
  assert.equal(planMinutes(plan), 160);
  assert.equal(fitsWindow(plan, 180), true);
});

test('no break after the last block and none before the first', () => {
  const plan = buildPlan([A, B, C]);
  assert.equal(plan[0].kind, 'work');
  assert.equal(plan[plan.length - 1].kind, 'work');
  assert.deepEqual(buildPlan([mk('X', 20, 'low')]).map((b) => b.kind), ['work']);
  assert.deepEqual(buildPlan([]), []);
});

test('urgency: priority, then deadline (none last), then created date', () => {
  const sorted = sortByUrgency([
    mk('low', 10, 'low', '2026-10-01'),
    mk('med-late', 10, 'medium', '2026-11-05'),
    mk('med-none', 10, 'medium', null),
    mk('high-new', 10, 'high', null, '2026-10-05'),
    mk('high-old', 10, 'high', null, '2026-10-02'),
    mk('med-soon', 10, 'medium', '2026-10-30'),
  ]);
  assert.deepEqual(sorted.map((t) => t.id), ['high-old', 'high-new', 'med-soon', 'med-late', 'med-none', 'low']);
});

test('finished tasks drop out of the circle', () => {
  const plan = buildPlan([mk('A', 60, 'high'), mk('B', 30, 'medium')]);
  assert.deepEqual(plan.filter((b) => b.kind === 'work').map((b) => b.taskId), ['A', 'B', 'A']);
});

test('tasks with zero remaining are ignored', () => {
  assert.deepEqual(buildPlan([mk('A', 0, 'high')]), []);
});

test('schedule and locate', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high')]), t0);
  assert.equal(blocks.length, 3);
  assert.deepEqual(locate(blocks, t0 - 1), { state: 'before' });
  assert.deepEqual(locate(blocks, t0), { state: 'running', index: 0 });
  assert.deepEqual(locate(blocks, t0 + 30 * 60000), { state: 'running', index: 1 });
  assert.deepEqual(locate(blocks, t0 + 35 * 60000), { state: 'running', index: 2 });
  assert.deepEqual(locate(blocks, blockEndMs(blocks[2])), { state: 'finished' });
});

test('replan after adding a task during a work block inserts a break first', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high')]), t0);
  const now = t0 + 10 * 60000;
  const { keep, added } = replan(blocks, now, [mk('A', 30, 'high'), mk('B', 20, 'medium')]);
  assert.equal(keep.length, 1);
  assert.deepEqual(added.map((b) => [b.kind, b.taskId, b.minutes]), [
    ['break', null, 5], ['work', 'A', 30], ['break', null, 5], ['work', 'B', 20],
  ]);
  assert.equal(added[0].startMs, t0 + 30 * 60000);
});

test('replan during a break does not add an extra break', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high')]), t0);
  const now = t0 + 32 * 60000;
  const { keep, added } = replan(blocks, now, [mk('A', 30, 'high')]);
  assert.equal(keep.length, 2);
  assert.deepEqual(added.map((b) => [b.kind, b.minutes]), [['work', 30]]);
  assert.equal(added[0].startMs, t0 + 35 * 60000);
});

test('replan with cut shortens the current block', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high'), mk('B', 30, 'medium')]), t0);
  const now = t0 + 12 * 60000;
  const { keep, added } = replan(blocks, now, [mk('B', 30, 'medium')], 'cut');
  assert.equal(keep[0].minutes, 12);
  assert.deepEqual(added.map((b) => [b.kind, b.taskId, b.minutes]), [['break', null, 5], ['work', 'B', 30]]);
  assert.equal(added[0].startMs, t0 + 12 * 60000);
});

test('handover: pause mid-block keeps full minutes and starts the next task at once', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high'), mk('B', 30, 'medium')]), t0);
  const now = t0 + 12 * 60000 + 30000;
  const { keep, added } = replan(blocks, now, [mk('B', 30, 'medium')], 'handover');
  assert.equal(keep.length, 1);
  assert.equal(keep[0].minutes, 12);
  assert.deepEqual(added.map((b) => [b.kind, b.taskId, b.minutes]), [['work', 'B', 30]]);
  assert.equal(added[0].startMs, now);
});

test('handover: pause within the first minute drops the block, nothing is lost', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high'), mk('B', 30, 'medium')]), t0);
  const now = t0 + 40000;
  const { keep, added } = replan(blocks, now, [mk('B', 30, 'medium')], 'handover');
  assert.equal(keep.length, 0);
  assert.deepEqual(added.map((b) => [b.kind, b.taskId, b.minutes]), [['work', 'B', 30]]);
  assert.equal(added[0].startMs, now);
});

test('handover with no other tasks leaves no future blocks', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high')]), t0);
  const { keep, added } = replan(blocks, t0 + 5 * 60000, [], 'handover');
  assert.equal(keep[0].minutes, 5);
  assert.deepEqual(added, []);
});

test('handover during a break behaves like a normal replan', () => {
  const t0 = Date.UTC(2026, 9, 28, 10, 0, 0);
  const blocks = schedule(buildPlan([mk('A', 60, 'high')]), t0);
  const now = t0 + 32 * 60000;
  const { keep, added } = replan(blocks, now, [mk('B', 20, 'medium')], 'handover');
  assert.equal(keep.length, 2);
  assert.deepEqual(added.map((b) => [b.kind, b.taskId, b.minutes]), [['work', 'B', 20]]);
  assert.equal(added[0].startMs, t0 + 35 * 60000);
});

test('remainingFor subtracts the block in flight', () => {
  const t0 = 0;
  const blocks = schedule(buildPlan([mk('A', 60, 'high')]), t0);
  const task = { id: 'A', estimate_min: 60, spent_min: 0 };
  assert.equal(remainingFor(task, blocks[0]), 30);
  assert.equal(remainingFor(task, blocks[1]), 60);
  assert.equal(remainingFor(task, undefined), 60);
});

test('formatting', () => {
  assert.equal(formatClock(1122), '18:42');
  assert.equal(formatClock(0), '00:00');
  assert.equal(formatClock(0.2), '00:01');
  assert.equal(formatDuration(229), '3 ч 49 мин');
  assert.equal(formatDuration(120), '2 ч');
  assert.equal(formatDuration(45), '45 мин');
});
