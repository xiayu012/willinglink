import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * **共同规则通知的措辞约束——唯一出处是一份 Markdown，不是 TypeScript 里的字符串。**
 *
 * 为什么要有这一层：定案通知走的是**收窄的小生成路径**（`composeRuleNotices`），
 * 它**不加载 doctrine**——所以「AI 对住户没有个人权威」这条立场如果只写在
 * `always/identity.md` / `always/arbitration.md` 里，通知这条路一个字都读不到，
 * 生成出来的句子会漂回「我定的标准 / 我对每个人的要求」那种管理者口吻（真实生产
 * 事故就是这个口气）。
 *
 * 所以把这条路径的措辞约束摆成**可以人直接改、直接审的纯文本**，与
 * `coordinator-copy.ts` 同一套做法：文件在 `lib/ai/brains/coliving/doctrine/content/`
 * 下（`next.config.ts` 既有的 `lib/ai/brains/**\/doctrine/**\/*.md` 追踪规则已覆盖，
 * 不需要新的 output tracing 配置），本模块只**读出来、校验**，不改写、不拼接措辞。
 *
 * **校验失败直接抛错**（不静默退回代码里的旧句子）：五段标题一个都不能少、各自不能为空，
 * 立场那一段必须保留「不是你定的」这个锚点——否则改文案的人会以为改掉了，实际上通知
 * 又变回了管理者口吻。
 *
 * 本模块**不 import server-only**：它只读文件、不碰 DB / 模型 / 环境变量，纯解析部分
 * 可以在离线测试里直接跑。
 */

/** 内容文件相对仓库根的路径（与 `coordinator-copy.ts` 同一套 `process.cwd()` 约定）。 */
export const RULE_NOTICE_DOCTRINE_RELATIVE_PATH =
  "lib/ai/brains/coliving/doctrine/content/rule-notice.md";

/**
 * **五段稳定的标题 id**：立场、隐私、以及三种文案各一段。文件里的标题一字不改就对应这里。
 * 顺序也是拼进系统提示的顺序——立场与隐私在最前，三种文案在后。
 */
export const RULE_NOTICE_SECTIONS = [
  "authority",
  "privacy",
  "consult",
  "announce",
  "ack",
] as const;

export type RuleNoticeSection = (typeof RULE_NOTICE_SECTIONS)[number];

export type RuleNoticeDoctrine = Record<RuleNoticeSection, string>;

/**
 * **立场段不能省的锚点。** 它不在住户可见文案里，而是**对那一段的校验要求**：
 * 少了它，这段就可能被改成任何一句客气话，而通知照样输出管理者口吻。
 */
export const RULE_NOTICE_AUTHORITY_ANCHOR = "不是你定的";

/** 标题行（`#` 到 `######` 都认，标题文本必须与上面五个 id 完全一致才被采纳）。 */
const HEADING_RE = /^#{1,6}[ \t]+(.*?)[ \t]*$/;

function isSection(text: string): text is RuleNoticeSection {
  return (RULE_NOTICE_SECTIONS as readonly string[]).includes(text);
}

/**
 * 把 Markdown 解析成五段。标题之外的一切（文件开头那段「编辑须知」、别的标题下的说明）
 * 都**不是**要拼进提示词的内容，一律忽略；同一个标题出现两次判为错误（否则改了一处、
 * 另一处还是旧的）。
 */
export function parseRuleNoticeDoctrine(
  markdown: string,
  source: string = RULE_NOTICE_DOCTRINE_RELATIVE_PATH
): RuleNoticeDoctrine {
  const blocks = new Map<RuleNoticeSection, string[]>();
  let current: RuleNoticeSection | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const title = heading[1];
      if (isSection(title)) {
        if (blocks.has(title)) {
          throw new Error(
            `[rule-notice] ${source} 里标题「${title}」出现了两次；` +
              "每一段只能有一处，否则改了一处、另一处还是旧的。"
          );
        }
        blocks.set(title, []);
        current = title;
      } else {
        current = null;
      }
      continue;
    }
    if (current) blocks.get(current)!.push(line);
  }

  const doctrine = {} as RuleNoticeDoctrine;
  for (const section of RULE_NOTICE_SECTIONS) {
    const body = blocks.get(section);
    if (!body) {
      throw new Error(
        `[rule-notice] ${source} 缺少标题「${section}」；` +
          `五个标题必须一个不少（${RULE_NOTICE_SECTIONS.join(" / ")}）。`
      );
    }
    const text = body.join("\n").trim();
    if (!text) {
      throw new Error(
        `[rule-notice] ${source} 的「${section}」是空的；` +
          "这一段的约束会被原样拼进通知的系统提示，留空等于没有约束。"
      );
    }
    doctrine[section] = text;
  }

  if (!doctrine.authority.includes(RULE_NOTICE_AUTHORITY_ANCHOR)) {
    throw new Error(
      `[rule-notice] ${source} 的「authority」缺少锚点「${RULE_NOTICE_AUTHORITY_ANCHOR}」；` +
        "通知这条路不加载 doctrine，这一段是它唯一读得到的立场来源，不能删掉。"
    );
  }

  return doctrine;
}

let cached: RuleNoticeDoctrine | null = null;

/** 内容文件的绝对路径（只读，永远服务端）。 */
export function ruleNoticeDoctrinePath(): string {
  return join(process.cwd(), RULE_NOTICE_DOCTRINE_RELATIVE_PATH);
}

/**
 * 读一次、缓存住（与 `lib/ai/brains/loader.ts` 的 doctrine 读取同一套做法：进程内缓存，
 * 开发时改文件重启即可）。**读不到就报错**，不静默退回任何代码里的旧措辞。
 */
export function loadRuleNoticeDoctrine(): RuleNoticeDoctrine {
  if (cached) return cached;
  const path = ruleNoticeDoctrinePath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`[rule-notice] 读不到措辞文件：${path}`, { cause });
  }
  cached = parseRuleNoticeDoctrine(raw);
  return cached;
}
