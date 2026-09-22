import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ResidentLanguage } from "./language";

/**
 * **住户会读到的自我介绍 / 能力说明——唯一出处是一份 Markdown，不是 TypeScript。**
 *
 * 老板 2026-09-22 定的口径：给住户看的这几句通用话（我是谁、我能帮上什么忙）属于
 * **文案**，必须放在一处人可以直接编辑、直接审阅的纯文本里，而不是散落在 `.ts` 的
 * 字符串常量里。文件在 `lib/ai/brains/coliving/doctrine/content/` 下——与其它 doctrine
 * 资产同处一棵树，`next.config.ts` 既有的 `lib/ai/brains/**\/doctrine/**\/*.md`
 * 追踪规则已经覆盖它，**不需要**新的 output tracing 配置。
 *
 * 本模块**只**做两件事：按标题把整段取出来、检查取到的东西合法。它
 * **不改写、不翻译、不拼接、不润色、不替换标点**——住户收到的就是文件里那一串字。
 * 任何"运行时再补一句""代码里再兜个措辞"的想法都属于把文案又搬回代码，不要那样做。
 *
 * **四段各自只服务一种问法**（与 `feature-qa.ts` 的分工）：
 *
 * - `identity.zh` / `identity.en`：住户问「你是谁 / 介绍一下你自己」时**只**读这一段；
 * - `capabilities.zh` / `capabilities.en`：住户问「你能做什么」时**只**读这一段。
 *
 * 校验（失败**直接抛错**，不悄悄退回旧文案、也不回空白）：四个标题**一个都不能少**、
 * 各自不能为空、身份段必须保留 `COORDINATOR_IDENTITY_ANCHORS` 里的每一个锚点。报错信息
 * 指明文件、标题与缺什么，让改文案的人一眼知道要改哪里。
 */

/** 内容文件相对仓库根的路径（`process.cwd()` 与其它 doctrine 读取同一套约定）。 */
export const COORDINATOR_COPY_RELATIVE_PATH =
  "lib/ai/brains/coliving/doctrine/content/coordinator-self-description.md";

/**
 * **四段稳定的标题 id**——文件里的标题一字不改就对应这里。标题写错 / 少了任何一段，
 * 校验会直接报错指出是哪一段，不会出现"改了一处、另一处还是旧的"。
 */
export const COORDINATOR_COPY_HEADINGS = [
  "identity.zh",
  "identity.en",
  "capabilities.zh",
  "capabilities.en",
] as const;

export type CoordinatorCopyHeading = (typeof COORDINATOR_COPY_HEADINGS)[number];

/** 两段**用途**：身份（问「你是谁」）与能力（问「你能做什么」）。 */
export type CoordinatorCopyKind = "identity" | "capabilities";

export type CoordinatorCopy = Record<CoordinatorCopyHeading, string>;

/**
 * **身份段不能省的锚点**——doctrine 的硬规则是报身份时「AI」两个字必须说出来、不冒充真人。
 *
 * 它**不是住户可见文案**（不住在 Markdown 里，Markdown 只有那四段），而是**对那四段里
 * 两段的校验要求**：身份段少了它就直接报错，而不是悄悄让住户收到一句像是真人在说话的
 * 自我介绍。能力段没有这条要求。
 */
export const COORDINATOR_IDENTITY_ANCHORS: readonly string[] = ["AI"];

/** 标题行（`#` 到 `######` 都认，但标题文本必须与上面四个 id 完全一致才被采纳）。 */
const HEADING_RE = /^#{1,6}[ \t]+(.*?)[ \t]*$/;

function isCoordinatorCopyHeading(text: string): text is CoordinatorCopyHeading {
  return (COORDINATOR_COPY_HEADINGS as readonly string[]).includes(text);
}

/**
 * 把 Markdown 解析成四段。**标题文本必须完全相等**（大小写、点号都算）：
 * 只有 `## identity.zh` 这种才是那一段的开始。
 *
 * 标题之外的一切（文件开头那段「编辑须知」、任意说明性文字）都**不是住户可见文案**，
 * 一律忽略；同一个标题出现两次会被判为错误（否则"改了上面那处、下面那处还是旧的"）。
 */
export function parseCoordinatorCopy(
  markdown: string,
  source: string = COORDINATOR_COPY_RELATIVE_PATH
): CoordinatorCopy {
  const blocks = new Map<CoordinatorCopyHeading, string[]>();
  let current: CoordinatorCopyHeading | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const title = heading[1];
      if (isCoordinatorCopyHeading(title)) {
        if (blocks.has(title)) {
          throw new Error(
            `[coordinator-copy] ${source} 里标题「${title}」出现了两次；` +
              "每一段只能有一处，否则改了一处、另一处还是旧的。"
          );
        }
        blocks.set(title, []);
        current = title;
      } else {
        // 别的标题（含文件大标题、说明性小标题）只是注释，不改写、不采纳。
        current = null;
      }
      continue;
    }
    if (current) blocks.get(current)!.push(line);
  }

  const copy = {} as CoordinatorCopy;
  for (const heading of COORDINATOR_COPY_HEADINGS) {
    const body = blocks.get(heading);
    if (!body) {
      throw new Error(
        `[coordinator-copy] ${source} 缺少标题「${heading}」；` +
          "四个标题必须一个不少（identity.zh / identity.en / capabilities.zh / capabilities.en）。"
      );
    }
    // 只去掉整段两端多余的空白，**不改动里面的一个字**（含换行）。
    const text = body.join("\n").trim();
    if (!text) {
      throw new Error(
        `[coordinator-copy] ${source} 的「${heading}」是空的；` +
          "住户那一侧会读到这段话，留空会直接报错而不是悄悄回一句空白。"
      );
    }
    copy[heading] = text;
  }

  for (const heading of COORDINATOR_COPY_HEADINGS) {
    if (!heading.startsWith("identity.")) continue;
    const absent = COORDINATOR_IDENTITY_ANCHORS.filter((a) => !copy[heading].includes(a));
    if (absent.length) {
      throw new Error(
        `[coordinator-copy] ${source} 的「${heading}」缺少身份披露锚点：${absent.join("、")}；` +
          "住户问起时不能冒充真人，这一段必须保留「AI」字样。"
      );
    }
  }

  return copy;
}

let cached: CoordinatorCopy | null = null;

/** 内容文件的绝对路径（只读，永远服务端）。 */
export function coordinatorCopyPath(): string {
  return join(process.cwd(), COORDINATOR_COPY_RELATIVE_PATH);
}

/**
 * 读一次、缓存住——与 `lib/ai/brains/loader.ts` 的 doctrine 读取同一套做法（进程内缓存，
 * 开发时改文件重启即可）。**读不到就报错**，不静默回退到任何代码里的旧文案。
 */
export function loadCoordinatorCopy(): CoordinatorCopy {
  if (cached) return cached;
  const path = coordinatorCopyPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    throw new Error(`[coordinator-copy] 读不到内容文件：${path}`, { cause });
  }
  cached = parseCoordinatorCopy(raw);
  return cached;
}

/** 只要某一段（`identity` / `capabilities`）在某一轮语言下的原文。 */
export function coordinatorCopyText(
  kind: CoordinatorCopyKind,
  language: ResidentLanguage
): string {
  const heading = `${kind}.${language}` as CoordinatorCopyHeading;
  return loadCoordinatorCopy()[heading];
}
