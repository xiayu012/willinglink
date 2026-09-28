import { importResidents } from "@/lib/coordination-history/import";

/**
 * 合作方名单导入。`/coordination-history` 顶上那个绿色长条按钮打进来的。
 *
 * 这个路由**没有鉴权**，跟那一页本身一样——整页就是靠 URL 分享给合作方看的
 * 演示窗口，公开可访问是既定要求（`proxy.ts` 里放行的那条）。要收紧的话
 * 得连页面一起收紧，只锁这里没有意义。
 *
 * ## 为什么是流式（NDJSON）而不是一个 JSON
 *
 * 一次导入要调模型认列（推理模型，几秒到几十秒），再逐行落库。整段憋到最后
 * 才回一个 JSON 的话，页面上就是一个转圈的方块——**用户已经从粘贴等过一次
 * 久到怀疑卡死**。所以这里边做边把「现在到哪一步了」推出去，页面就能说人话：
 * 正在认列 / 正在补号码 / 正在写第 7 个人。
 *
 * 一条一行 JSON：`{"type":"stage",...}` 若干条，最后一条 `{"type":"report",...}`。
 * **成功和失败都走这个格式**（失败也是最后那条 report），客户端就一条解析路径。
 */
export const maxDuration = 120;
export const preferredRegion = "sfo1";

function streamOf(buffer: ArrayBuffer | null, earlyError: string | null) {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      try {
        if (earlyError || !buffer) {
          send({ type: "report", report: { ok: false, error: earlyError } });
          return;
        }
        const report = await importResidents(buffer, (stage) => {
          send({ type: "stage", ...stage });
        });
        send({ type: "report", report });
      } catch (error) {
        // 失败原因（认不出电话列 / 空表 / 模型没给出合格 JSON）要原样带回页面，
        // 用户才知道该换一份文件还是重试
        console.error("[coordination-history] 导入失败", error);
        send({
          type: "report",
          report: {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        controller.close();
      }
    },
  });
}

export async function POST(request: Request) {
  let buffer: ArrayBuffer | null = null;
  let earlyError: string | null = null;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (file instanceof File) {
      buffer = await file.arrayBuffer();
    } else {
      earlyError = "No file was received.";
    }
  } catch (error) {
    console.error("[coordination-history] 读不到上传的文件", error);
    earlyError = "That upload didn't come through. Please try again.";
  }

  return new Response(streamOf(buffer, earlyError), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      // 中间层攒着不转发的话，进度就不是进度了
      "x-accel-buffering": "no",
    },
  });
}
