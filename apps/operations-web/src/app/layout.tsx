import type { JSX, ReactNode } from "react";

import { AppNavigation } from "../components/app-navigation";

import "./globals.css";

export const metadata = {
  title: {
    default: "醋溜教育教务系统",
    template: "%s · 醋溜教育教务系统",
  },
  description: "学生档案、画像、课程规划与排课管理系统",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <html lang="zh-CN">
      <body>
        <AppNavigation />
        {children}
        <footer className="site-footer">
          <span>醋溜科技 · 内部教务系统</span>
          <span>Evidence first · Human reviewed</span>
        </footer>
      </body>
    </html>
  );
}
