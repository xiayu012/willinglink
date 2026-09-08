/**
 * 可写的「协商会话推进」入口 —— turn.ts 将来接入生产的接口（目前默认未接线）。
 *
 * 离线/影子对照已经证明 `lib/coordination` 的状态机能复现真实排班。第三步要
 * 「替换生产排班路径」，需要一个**可写**的会话推进入口：给定 household + 一条
 * 住户消息，恢复该户的协商事件流 → 意图解析 → 状态机 step → 落盘/推进 checkpoint
 * → 返回下一步动作。本文件就是这个入口：它把 `runCoordinationTurn`（runtime.ts）
 * 与「按 household 分文件的事件日志 + checkpoint」绑到一起，调用方每次只需给
 * householdId + sender + 消息文本，就能推进/续放该户的厨房协商状态；事件日志里
 * 已有的事实会在每次调用时从磁盘恢复，所以连续多次调用天然是「从上一轮续放」。
 *
 * ⚠️ 目前默认未接线：本文件不 import turn.ts / route.ts，不改任何 production 行为。
 * 将来 turn.ts 要接管时，从这里拿 `actions` 去措辞/发送、拿 `blocked` 诊断去协调
 * ——本文件只算状态机、把下一步动作交出去，不替调用方发消息。
 *
 * 安全边界：
 * - 本文件不 import 任何发送逻辑（无 Twilio / sendSms），`actions` 只返回给调用方；
 * - 事件只落本地 JSONL/checkpoint（按 household 分文件），不写 coliving 生产库、
 *   不连 DB——coordination-bridge.ts（直连 POSTGRES_URL）与 repo.ts（server-only）
 *   一概不 import；
 * - 默认意图解析是 `llmParseIntent`（lib/coordination/llm.ts）；测试/调用方可注入
 *   确定性 stub（第 5 参），与 `runCoordinationTurn` 的注入方式一致。
 */

import path from "node:path";
import os from "node:os";
import { runCoordinationTurn } from "../../coordination/runtime";
import { llmParseIntent } from "../../coordination/llm";
import type { StateSnapshot } from "../../coordination/machine";
import type { Event, Intent, OutboundAction, PersonId, State, TimeWindow } from "../../coordination/types";

/** `advanceCoordinationSession` 的调用方配置。 */
export interface CoordinationSessionOptions {
  /** 该户厨房协商的窗口（调用方传入；产品默认傍晚窗可取自 coordination-bridge 的 kitchenEveningWindow）。 */
  window: TimeWindow;
  /** 参与人 display_name（由调用方显式传入；本文件不查 DB）。 */
  participants: readonly PersonId[];
  /** 事件日志/checkpoint 落盘目录（够用即可；缺省落到本地临时目录）。 */
  dir?: string;
  /**
   * 最近几条对话原文（含 AI 出站），仅供 LLM 意图解析消歧用——「AI 刚建议 17:30、
   * 住户回“可以”」这类接受时间建议 ≠ confirm 要靠它分辨。原样透传给
   * `runCoordinationTurn` 进投影快照，本文件不维护它；缺省表示没提供。
   */
  recentDialogue?: readonly string[];
}

/** householdId → 文件名里只留安全字符（防路径穿越 / Windows 非法字符；同一 id 两侧换算一致）。 */
function safeFileStem(householdId: string): string {
  return householdId.replace(/[^A-Za-z0-9._-]/g, "_");
}

/** 一栋 household 的事件日志 + checkpoint 两个落盘路径（按 household 分文件）。 */
function sessionFiles(
  dir: string,
  householdId: string
): { eventsFile: string; checkpointFile: string } {
  const stem = safeFileStem(householdId);
  return {
    eventsFile: path.join(dir, `${stem}.events.jsonl`),
    checkpointFile: path.join(dir, `${stem}.checkpoint.json`),
  };
}

/** 缺省落盘目录：本地临时目录下固定子目录（跨调用稳定，不做一次性 mkdtemp）。 */
function defaultSessionDir(): string {
  return path.join(os.tmpdir(), "coliving-coordination-sessions");
}

/**
 * 完整推进一轮「可写」的协商会话：给定 household + 一条住户消息，从该户的事件
 * 日志/checkpoint 恢复状态 → 意图解析 → 状态机 step → 新事件追加进 JSONL、
 * checkpoint 推进 → 返回本轮追加的事件、出站动作、终态与终态投影。
 *
 * - 事件文件按 household 分文件：`<dir>/<householdId>.events.jsonl` 与
 *   `<dir>/<householdId>.checkpoint.json`（`dir` 缺省为本地临时目录）。
 * - 内部调 `runCoordinationTurn` 推进；默认 intent 解析是 `llmParseIntent`，
 *   调用方可通过第 5 参注入确定性 stub（不连 DB、不调 LLM 的本地测试用）。
 * - 返回的 `actions` 只交给调用方去措辞/发送，本文件不发短信；已定案
 *   （`settled`）是终态，之后的消息不再追加事件（`runCoordinationTurn` 保证）。
 */
export async function advanceCoordinationSession(
  householdId: string,
  sender: PersonId,
  text: string,
  opts: CoordinationSessionOptions,
  resolveIntent: (message: string, snapshot: StateSnapshot) => Promise<Intent> = llmParseIntent
): Promise<{ events: Event[]; actions: OutboundAction[]; state: State; snapshot: StateSnapshot }> {
  const dir = opts.dir ?? defaultSessionDir();
  const { eventsFile, checkpointFile } = sessionFiles(dir, householdId);
  return runCoordinationTurn(
    text,
    sender,
    {
      eventsFile,
      checkpointFile,
      participants: opts.participants,
      window: opts.window,
      ...(opts.recentDialogue ? { recentDialogue: opts.recentDialogue } : {}),
    },
    resolveIntent
  );
}
