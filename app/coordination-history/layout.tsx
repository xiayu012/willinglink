import { ColorSchemeScript, MantineProvider } from "@mantine/core";

import "@mantine/core/styles.css";

/**
 * 这一层只做一件事：给 `/coordination-history` 挂上 Mantine。
 *
 * **故意不动根 layout。** 根 layout 管着整个站点（主题、会话、PWA 注册），
 * 为了这一个页面往里塞 provider，等于让所有人都背着它。样式也是在这个
 * 路由段里引的，其他路由的 CSS 体积不受影响。
 *
 * 配色固定成 light：根 layout 的 next-themes 会按系统偏好给 `<html>` 加
 * `dark` 类，Mantine 读不到那个类，跟着系统走会出现「Mantine 以为亮色、
 * 页面底色是暗色」的错位。演示页要的是确定性，所以两队各自固定。
 */
export default function CoordinationHistoryLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <ColorSchemeScript defaultColorScheme="light" />
      <MantineProvider defaultColorScheme="light">
        <div style={{ background: "#ffffff", minHeight: "100dvh" }}>{children}</div>
      </MantineProvider>
    </>
  );
}
