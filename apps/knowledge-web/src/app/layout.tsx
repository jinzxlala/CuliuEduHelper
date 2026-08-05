import type { JSX, ReactNode } from "react";

import { AppNavigation } from "../components/app-navigation";

import "./globals.css";

export const metadata = {
  title: {
    default: "醋溜教育知识系统",
    template: "%s · 醋溜教育知识系统",
  },
  description: "供顾问使用的讲座、案例与证据搜索系统",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>): JSX.Element {
  return (
    <html lang="zh-CN">
      <body>
        <AppNavigation />
        {children}
        <footer className="site-footer">
          <span>醋溜科技 · 顾问知识系统</span>
          <span>Evidence first · Human reviewed</span>
        </footer>
      </body>
    </html>
  );
}
