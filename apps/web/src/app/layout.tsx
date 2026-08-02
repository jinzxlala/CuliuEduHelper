import type { JSX, ReactNode } from "react";

import { AppNavigation } from "../components/app-navigation";

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
      <body>
        <AppNavigation />
        {children}
        <footer className="site-footer">
          <span>醋溜科技 · 内部教育知识与规划系统</span>
          <span>Evidence first · Human reviewed</span>
        </footer>
      </body>
    </html>
  );
}
