/* 合并引擎冒烟测试：node --import tsx scripts/sync-smoke.mjs 不便，故用编译后或 ts 源码直接跑。
   这里以纯 JS 复刻测试夹具并动态加载编译产物不现实；改为通过 tsx 运行 TypeScript。 */
import { assert } from 'node:console';
import {
  buildTextDiff,
  migrate,
  mutateCaption,
  mutateEnqueue,
  mutateHandoffComplete,
  mutateHandoffStart,
  mutateSpeechStatus,
  mutateTimeAdjust,
  nextHandoffBatch,
  nextSeq,
  pushAudit,
  syncRoom
} from '../src/lib/sync.ts';

let passed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exitCode = 1;
  } else {
    passed += 1;
    console.log(`✓ ${msg}`);
  }
};
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

let clock = 0;
const tick = () => new Date(Date.UTC(2026, 9, 4, 0, 0, ++clock)).toISOString();
let counter = 0;
const newId = (prefix) => `${prefix}-${++counter}`;

function makeState() {
  const state = migrate(
    {
      rooms: [{ id: 'hall-a', name: 'A厅' }, { id: 'hall-b', name: 'B厅' }],
      speechQueue: [
        { id: 's1', roomId: 'hall-a', seq: 1, speaker: '甲', delegation: 'D', language: '中文', topic: '议题', plannedSeconds: 300, remainingSeconds: 300, status: 'speaking', statusVersion: 1 },
        { id: 's2', roomId: 'hall-a', seq: 2, speaker: '乙', delegation: 'D', language: '中文', topic: '议题', plannedSeconds: 300, remainingSeconds: 300, status: 'queued', statusVersion: 1 }
      ],
      channels: [{ id: 'c1', roomId: 'hall-a', language: '中文', interpreter: '老译员', status: 'active', health: 90, handoffVersion: 0, openHandoffBatch: null }],
      captions: [
        { id: 'cap1', speechId: 's1', roomId: 'hall-a', language: '中文', interpreter: '老译员', handoffBatch: null, text: '旧字幕', revision: 1, baseRevision: 0, forked: false, forkWinner: false }
      ],
      audits: []
    },
    []
  );
  return state;
}
const op = (consoleId, roomId, extra) => ({ id: newId('op'), console: consoleId, roomId, at: tick(), ...extra });

/* 场景1：发言状态更新后，基于旧版的合并操作失效，已完成发言不会被改回排队 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  // 本台先把发言结束（v1 -> v2，done）
  const doneOp = op('console-1', 'hall-a', { type: 'speech-status', speechId: 's1', speechSeq: 1, baseStatusVersion: 1, status: 'done' });
  mutateSpeechStatus(state, doneOp);
  state.outboxes['console-1'].push(doneOp);
  // 对端基于断线前 v1，要求退回排队
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', { type: 'speech-status', speechId: 's1', speechSeq: 1, baseStatusVersion: 1, status: 'queued' })
  );
  syncRoom(state, 'hall-a');
  const s1 = state.speechQueue.find((s) => s.id === 's1');
  eq(s1.status, 'done', '旧版「退回排队」操作失效，发言保持完成');
  eq(state.conflicts.length, 0, '失效不等于冲突，不进冲突清单');
  ok(state.audits.some((a) => a.message.includes('旧版合并操作失效') || a.message.includes('旧版状态操作失效')), '时间线记录失效原因');
}

/* 场景2：同基版本分叉 —— 两边状态都保留并列差异，待人工裁定 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  state.outboxes['console-1'].push(
    op('console-1', 'hall-a', { type: 'speech-status', speechId: 's2', speechSeq: 2, baseStatusVersion: 1, status: 'done' })
  );
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', { type: 'speech-status', speechId: 's2', speechSeq: 2, baseStatusVersion: 1, status: 'skipped' })
  );
  // 本台操作未乐观执行（模拟只记录），同步后数据以裁定前为准：本台乐观语义下应已执行；这里验证冲突登记
  syncRoom(state, 'hall-a');
  eq(state.conflicts.filter((c) => c.kind === 'speech-status' && !c.resolved).length, 1, '同基分叉产生 1 条状态冲突');
  const c = state.conflicts[0];
  eq(c.localStatus, 'done', '冲突保留本台取值');
  eq(c.peerStatus, 'skipped', '冲突保留对端取值');
  eq(c.baseStatusVersion, 1, '冲突记录共同基版本');
  eq(state.outboxes['console-1'].length, 0, '冲突的本台操作已从待同步队列收口（保留在冲突清单）');
  eq(state.peerOutboxes['console-1'].length, 0, '冲突的对端操作同样收口');
}

/* 场景3：字幕按发言序号+语言+修订号对应；旧译员字幕不会挂到新发言 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  // 对端发了一条指向不存在发言（第 9 条）的字幕
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', {
      type: 'caption-revise',
      speechId: 'ghost',
      speechSeq: 9,
      language: '中文',
      handoffBatch: null,
      interpreter: '老译员',
      baseRevision: 0,
      revision: 1,
      text: '游离字幕'
    })
  );
  syncRoom(state, 'hall-a');
  const orphans = state.conflicts.filter((c) => c.kind === 'caption-orphan');
  eq(orphans.length, 1, '找不到发言的字幕进挂空隔离清单');
  ok(!state.captions.some((c) => c.text === '游离字幕' && c.speechId !== 'ghost'), '游离字幕未挂到任何现有发言');
}

/* 场景4：同基字幕修订分叉 —— 两版都保留 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  const localOp = op('console-1', 'hall-a', {
    type: 'caption-revise', speechId: 's1', speechSeq: 1, language: '中文', handoffBatch: null, interpreter: '老译员',
    baseRevision: 1, revision: 2, text: '本台修订第二版'
  });
  mutateCaption(state, localOp, false);
  state.outboxes['console-1'].push(localOp);
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', {
      type: 'caption-revise', speechId: 's1', speechSeq: 1, language: '中文', handoffBatch: null, interpreter: '老译员',
      baseRevision: 1, revision: 2, text: '对端修订第二版'
    })
  );
  syncRoom(state, 'hall-a');
  const caps = state.captions.filter((c) => c.speechId === 's1' && c.language === '中文');
  eq(caps.filter((c) => !c.forked).length, 1, '主线字幕仍只有一条（未被对端覆盖）');
  ok(caps.some((c) => c.text === '本台修订第二版'), '主线保持本台文本');
  const conflict = state.conflicts.find((c) => c.kind === 'caption' && !c.resolved);
  ok(Boolean(conflict && conflict.kind === 'caption'), '产生 1 条字幕冲突');
  if (conflict && conflict.kind === 'caption') {
    eq(conflict.localText, '本台修订第二版', '冲突记录保留本台文本');
    eq(conflict.peerText, '对端修订第二版', '冲突记录保留对端文本，两边都不丢');
  }
}

/* 场景5：交接批次对应 —— 同批次双方指定不同译员则冲突；批次已关闭则完成操作失效 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  const ch = state.channels[0];
  const batchId = nextHandoffBatch(ch);
  const startOp = op('console-1', 'hall-a', { type: 'handoff-start', channelId: 'c1', baseHandoffVersion: 0, batchId });
  mutateHandoffStart(state, startOp);
  state.outboxes['console-1'].push(startOp);
  const localDone = op('console-1', 'hall-a', { type: 'handoff-complete', channelId: 'c1', baseHandoffVersion: 1, batchId, interpreter: '本台替补' });
  mutateHandoffComplete(state, localDone);
  state.outboxes['console-1'].push(localDone);
  // 对端同批次指定了另一个译员
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', { type: 'handoff-complete', channelId: 'c1', baseHandoffVersion: 1, batchId, interpreter: '对端替补' })
  );
  syncRoom(state, 'hall-a');
  eq(state.conflicts.filter((c) => c.kind === 'handoff' && !c.resolved).length, 1, '同批次双译员产生交接冲突');

  // 已关闭批次的迟到完成操作必须失效，不能把在岗译员冲掉
  const state2 = makeState();
  state2.activeConsole = 'console-1';
  const b2 = nextHandoffBatch(state2.channels[0]);
  const st = op('console-1', 'hall-a', { type: 'handoff-start', channelId: 'c1', baseHandoffVersion: 0, batchId: b2 });
  mutateHandoffStart(state2, st);
  const done = op('console-1', 'hall-a', { type: 'handoff-complete', channelId: 'c1', baseHandoffVersion: 1, batchId: b2, interpreter: '新译员' });
  mutateHandoffComplete(state2, done);
  state2.appliedOpIds.push(st.id, done.id);
  // 对端迟到的完成操作：批次对不上（channel 已 v2 且无开放批次）
  state2.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', { type: 'handoff-complete', channelId: 'c1', baseHandoffVersion: 1, batchId: b2, interpreter: '迟到译员' })
  );
  syncRoom(state2, 'hall-a');
  eq(state2.channels[0].interpreter, '新译员', '批次已关闭，迟到交接操作失效');
}

/* 场景6：切换会议厅只处理本厅 —— B厅待同步原样保留 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-b', { type: 'speech-enqueue', speechId: 'sb', seq: 1, speaker: '丙', delegation: 'D', language: '中文', topic: '议题', plannedSeconds: 300 })
  );
  syncRoom(state, 'hall-a');
  eq(state.peerOutboxes['console-1'].length, 1, '合并 A厅时 B厅待同步操作原样保留');
  eq(state.speechQueue.filter((s) => s.roomId === 'hall-b').length, 0, 'B厅入队未被提前应用');
  syncRoom(state, 'hall-b');
  eq(state.speechQueue.filter((s) => s.roomId === 'hall-b').length, 1, '处理 B厅时才应用 B厅入队');
}

/* 场景7：旧数据升级 —— v1 结构迁移后可继续打开，序号/版本补齐 */
{
  const upgraded = migrate(
    {
      rooms: [{ id: 'hall-a', name: 'A厅' }],
      activeRoomId: 'hall-a',
      speechQueue: [
        { id: 'x', roomId: 'hall-a', speaker: '丁', delegation: 'D', language: '中文', topic: '议题', plannedSeconds: 300, remainingSeconds: 300, status: 'queued' }
      ],
      channels: [{ id: 'c', roomId: 'hall-a', language: '中文', interpreter: '戊', status: 'active', health: 80 }],
      captions: [{ id: 'k', speechId: 'x', roomId: 'hall-a', language: '中文', interpreter: '戊', text: '旧', revision: 3 }],
      terms: [],
      audits: []
    },
    []
  );
  eq(upgraded.schemaVersion, 2, '迁移到 schema v2');
  eq(upgraded.speechQueue[0].seq, 1, '旧发言补齐厅内序号');
  eq(upgraded.speechQueue[0].statusVersion, 1, '旧发言补齐状态版本');
  eq(upgraded.channels[0].handoffVersion, 0, '旧频道补齐交接版本');
  eq(upgraded.channels[0].openHandoffBatch, null, '旧频道无开放交接批次');
  eq(upgraded.captions[0].baseRevision, 2, '旧字幕按 revision 反推 baseRevision');
  eq(upgraded.perConsoleActiveRoom['console-2'], 'hall-a', '各台活动厅从旧 activeRoomId 继承');
  eq(nextSeq(upgraded, 'hall-a'), 2, '迁移后序号分配连续');
  ok(JSON.stringify(upgraded).length > 0, '迁移结果可序列化（可继续存档打开）');
}

/* 场景8：入队序号撞车 —— 对端顺延并记录差异 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', { type: 'speech-enqueue', speechId: 's99', seq: 1, speaker: '撞车代表', delegation: 'D', language: '中文', topic: '议题', plannedSeconds: 300 })
  );
  syncRoom(state, 'hall-a');
  const got = state.speechQueue.find((s) => s.id === 's99');
  eq(got.seq, 3, '撞序号的对端入队顺延到下一位');
  ok(state.audits.some((a) => a.message.includes('顺延')), '顺延差异进入时间线');
}

/* 场景9：计时调整旧版失效 */
{
  const state = makeState();
  state.activeConsole = 'console-1';
  const adj = op('console-1', 'hall-a', { type: 'time-adjust', speechId: 's1', speechSeq: 1, baseStatusVersion: 1, remainingSeconds: 100 });
  mutateTimeAdjust(state, adj); // v1 -> v2
  state.appliedOpIds.push(adj.id);
  state.peerOutboxes['console-1'].push(
    op('console-2', 'hall-a', { type: 'time-adjust', speechId: 's1', speechSeq: 1, baseStatusVersion: 1, remainingSeconds: 50 })
  );
  syncRoom(state, 'hall-a');
  eq(state.speechQueue.find((s) => s.id === 's1').remainingSeconds, 100, '基于旧版本的计时调整失效');
}

/* 场景10：字符级差异可列出 */
{
  const parts = buildTextDiff('适应资金', '适应资金与目标');
  const joined = parts.filter((p) => p.kind !== 'del').map((p) => p.text).join('');
  eq(joined, '适应资金与目标', '差异结果可还原对端文本');
  ok(parts.some((p) => p.kind === 'ins' && p.text === '与目标'), '新增部分被标出');
}

/* 场景11：未同步操作只是普通存档数据 —— 重开浏览器后仍在（由 migrate 保留 outboxes） */
{
  const state = makeState();
  state.activeConsole = 'console-2';
  const saved = JSON.parse(JSON.stringify(state));
  saved.outboxes['console-2'].push(
    op('console-2', 'hall-a', { type: 'speech-status', speechId: 's1', speechSeq: 1, baseStatusVersion: 1, status: 'done' })
  );
  const reopened = migrate(JSON.parse(JSON.stringify(saved)), []);
  eq(reopened.outboxes['console-2'].length, 1, '重开浏览器后待同步操作仍在');
  eq(reopened.activeConsole, 'console-2', '重开后仍在原操作台');
}

void assert;
void pushAudit;
console.log(`\n${passed} checks passed`);
