/**
 * 多渠道聊天的公共类型。
 *
 * 一句话原则：**WillingLink 的 conversation 才是聊天本体**，网页/短信
 * 只是同一个 conversation 的不同窗口。所以这里没有"某渠道的会话"这种
 * 概念，只有「一条消息从哪个渠道进来的」。
 *
 * 老板 2026-09-12 决定：外部**实时消息只做短信（SMS，Twilio）**。小红书私信/
 * 出站通道已整体下线（`xhs` 不再进 `CHANNELS`）；小红书的**房源采集**与
 * **帖子评论草稿**仍保留，后者只借 conversation 存帖主身份，见 `ConversationSource`。
 */

/** 实时通信渠道。新增渠道 = 加一个值 + 写一个 adapter，其它都不用动。 */
export const CHANNELS = ["web", "sms"] as const;

export type ChannelId = (typeof CHANNELS)[number];

export function isChannelId(value: unknown): value is ChannelId {
  return (
    typeof value === "string" && (CHANNELS as readonly string[]).includes(value)
  );
}

/**
 * 会写进 conversation 的来源标签。比 `ChannelId` 多一个 `"xhs"`。
 *
 * `"xhs"` 在这里**不是实时消息渠道**：没有 webhook、没有 adapter、没有出站
 * 路径。它只是 `/api/xhs/comment-reply`（帖子评论草稿）把同一个帖主的帖子
 * 归到同一条 conversation 的身份命名空间——评论草稿不是私信、不属下线范围，
 * 所以这个标签保留。**任何入站/出站消息通道仍必须用 `ChannelId`。**
 */
export type ConversationSource = ChannelId | "xhs";

/** 某个来源上的一个外部身份，例如 { channel: "sms", externalUserId: "+14085551234" } */
export type ExternalIdentity = {
  channel: ConversationSource;
  /** 该来源里这个人的唯一 id：手机号（帖主身份命名空间里则是小红书 userId） */
  externalUserId: string;
  /**
   * 同一渠道下的多账号场景：哪个客服号/发件号收到的。
   * 现在全填 null 也能跑，留着是为了以后同一渠道接第二个账号时不用改表。
   */
  accountId?: string | null;
  /** 该来源里的昵称（帖主用户名等）。只为好认，不参与判重 */
  displayName?: string | null;
};

/** adapter 交给 Chat Engine 的统一输入 */
export type InboundTurn = {
  chatId: string;
  userId: string;
  /** 用户这次说的话（纯文本；富媒体以后再说） */
  text: string;
  /** 消息来源，只是标签，**不因此拆会话** */
  channel: ConversationSource;
  /**
   * 渠道自己的消息 id，用来防重复投递（webhook 重试很常见）。
   * 现在只是存下来，去重逻辑等接真实 webhook 时再补。
   */
  externalMessageId?: string | null;
};

/** Chat Engine 的统一输出。怎么把它变成 SSE / JSON / TwiML 是 adapter 的事。 */
export type TurnResult = {
  chatId: string;
  /** 最终回答的纯文本（已去掉 <memory> 块） */
  text: string;
  /** 这一轮用到的工具，便于日志排查 */
  toolsUsed: string[];
  /**
   * 工具的原始返回。adapter 偶尔需要看工具到底查到了什么（例如评论回复要用
   * 真实字段兜底拼装），不给的话它只能自己再调一次工具。
   */
  toolOutputs: unknown[];
  elapsedMs: number;
};
