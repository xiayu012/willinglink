/**
 * **这次调用是被取消的**，不是普通业务失败。
 *
 * 一处用：`turn.ts` 判定「哪些错误绝不能被 catch 吞掉」——预算超限（`isEvalBudgetExceeded`）
 * 或这一轮被上层 abort。两者都不是「这一步没成、接着往下走」：吞掉它们等于在被取消之后
 * 继续调模型、继续写库、继续发短信。
 *
 * **只判取消，超时不算。** `AbortSignal.timeout()` 抛出的是 `TimeoutError`，那是"这一步
 * 太慢"而不是"这一轮被取消"：一次功能调用超时该退回普通回复、下一轮相关话题再补，
 * 不该把整轮一起废掉。把超时也当致命，一次抖动就会让住户**一条回复都收不到**。
 *
 * 要**沿着 `cause` 链找**：功能调用失败会被包成 `FeatureCallError`（原始错误挂在
 * `cause` 上），SDK 自己也会再包一层，只看最外层会漏。而且 DOMException 不是 `Error`
 * 子类，所以按 `name` 判、不按 `instanceof` 判。
 *
 * 不 import 任何 `server-only` / DB 模块，因此可以离线跑真断言。
 */

export function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    if ((current as { name?: unknown }).name === "AbortError") {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
