import { NextResponse } from "next/server";

import { importResidents } from "@/lib/coordination-history/import";

/**
 * 合作方名单导入。`/coordination-history` 顶上那个绿色长条按钮打进来的。
 *
 * 这个路由**没有鉴权**，跟那一页本身一样——整页就是靠 URL 分享给合作方看的
 * 演示窗口，公开可访问是既定要求（`proxy.ts` 里放行的那条）。要收紧的话
 * 得连页面一起收紧，只锁这里没有意义。
 *
 * 模型调用 + 逐行落库可能要几十秒，`maxDuration` 给到跟其它长路由一样的档位。
 */
export const maxDuration = 120;
export const preferredRegion = "sfo1";

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "No file was received." },
        { status: 400 }
      );
    }
    const report = await importResidents(await file.arrayBuffer());
    return NextResponse.json(report);
  } catch (error) {
    // 失败原因（认不出电话列 / 空表 / 模型没给出合格 JSON）要原样带回页面，
    // 用户才知道该换一份文件还是重试
    console.error("[coordination-history] 导入失败", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
