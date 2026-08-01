import type { JSX, ReactNode } from "react";

import "./globals.css";

export const metadata = {
  title: {
    default: "醋溜教育智能助手",
    template: "%s · 醋溜教育智能助手",
  },
  description: "证据可追溯的内部教育知识搜索与规划工具",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
